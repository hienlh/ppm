import type { Json } from "../mcp-http-endpoint.ts";
import type { GitChanges, StashEntry } from "../../shared/git-changes.ts";
import type { GitBranch } from "../../types/git.ts";
import { assertRef } from "../git-branch-diff/branch-diff-parse.ts";
import { gitWorkflowService, type PushTarget } from "../git-workflow/git-workflow.service.ts";
import { GIT_BRANCH_TOOL, GIT_STASH_TOOL, GIT_SYNC_TOOL } from "../../shared/assistant-git-tool-names.ts";
import {
  gitBranchSummary, gitFetchSummary, gitPullSummary, gitPushSummary, gitStashEntrySummary, gitStashSaveSummary,
} from "./assistant-approval-summary-git.ts";
import type { GitRepoScope } from "./assistant-git-repo-scope.ts";
import {
  askFirst, cardTarget, gitRoute, optionalBoolean, optionalString, readChanges, repoLabel, routeErrorMessage, routeErrorResult, scopeOrError,
  staleResult,
} from "./assistant-git-tool-helpers.ts";
import { errorResult, intArg, jsonResult } from "./assistant-tool-output.ts";
import type { ToolContext } from "./assistant-tool-family.ts";

/**
 * The git tools that reach a remote or move HEAD: sync (fetch, pull, push), branch (create,
 * switch) and stash. Never a force push, a merge, a rebase other than pull's, or a branch
 * deletion — those stay in PPM's UI. Remotes are named, never shown by URL.
 */

/** What a pull or push leaves behind, read back so the agent hears about a conflict or a new state. */
async function afterState(ctx: ToolContext, scope: GitRepoScope): Promise<Record<string, unknown>> {
  const read = await readChanges(ctx.callRoute, scope);
  if (!read.ok) return {};
  const { branch, operation } = read.changes;
  return { branch: { name: branch.head, upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind }, operation };
}

const headSignature = (c: GitChanges): string => JSON.stringify([c.branch.head, c.branch.oid, c.branch.upstream]);

/**
 * Exactly where a push or a publish goes, read from the repository's own config. No route
 * answers this, so it is read through the workflow service, on the path discovery returned.
 */
async function pushTarget(scope: GitRepoScope, publish: boolean): Promise<{ ok: true; target: PushTarget } | { ok: false; error: string }> {
  try {
    return { ok: true, target: publish ? await gitWorkflowService.publishTarget(scope.path) : await gitWorkflowService.upstreamPushTarget(scope.path) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function gitSync(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const action = args.action;
  if (action !== "fetch" && action !== "pull" && action !== "push") return errorResult("`action` must be \"fetch\", \"pull\" or \"push\".");
  const rebase = optionalBoolean(args.rebase, "rebase");
  if (!rebase.ok) return errorResult(rebase.error);
  if (rebase.value && action !== "pull") return errorResult("`rebase` applies to a pull only.");
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const { scope } = got;
  const read = await readChanges(ctx.callRoute, scope);
  if (!read.ok) return read.result;
  const { changes } = read;
  const { branch } = changes;
  const target = cardTarget(scope, changes);
  const input = { ...repoLabel(scope), action, ...(rebase.value ? { rebase: true } : {}) };

  if (!branch.hasRemote) return errorResult("This repository has no remote.");

  if (action === "fetch") {
    const refused = await askFirst(ctx, GIT_SYNC_TOOL, input, gitFetchSummary({ target }));
    if (refused) return refused;
    const res = await ctx.callRoute("POST", gitRoute(scope, "fetch"), {});
    if (!res.ok) return routeErrorResult("The fetch failed", res);
    return jsonResult({ ...repoLabel(scope), fetched: true, ...(await afterState(ctx, scope)) });
  }

  if (!branch.head) return errorResult("HEAD is detached; switch to a branch first (git_branch).");
  if (changes.operation) return errorResult(`A ${changes.operation.kind} is under way; finish or abort it in PPM first.`);

  if (action === "pull") {
    if (!branch.upstream) return errorResult(`${branch.head} has no upstream to pull from.`);
    if (branch.upstreamGone) return errorResult(`${branch.head}'s upstream ${branch.upstream} no longer exists on the remote.`);
    const refused = await askFirst(ctx, GIT_SYNC_TOOL, input, gitPullSummary({
      target, upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind, rebase: rebase.value,
    }));
    if (refused) return refused;
    const res = await ctx.callRoute("POST", gitRoute(scope, "pull"), { rebase: rebase.value });
    // A pull that stopped on a conflict fails and has still changed the tree: report both.
    const after = await afterState(ctx, scope);
    if (!res.ok) return errorResult(`${routeErrorMessage("The pull failed", res)}\nNow: ${JSON.stringify(after)}`);
    return jsonResult({ ...repoLabel(scope), pulled: true, ...after });
  }

  // Push. A gone upstream is pushed to as configured, which recreates it; no upstream publishes.
  const publish = branch.upstream === null;
  if (!publish && !branch.upstreamGone && branch.ahead === 0) return errorResult(`${branch.head} has nothing to push to ${branch.upstream}.`);
  const to = await pushTarget(scope, publish);
  if (!to.ok) return errorResult(to.error);
  const last = changes.lastCommit;
  const refused = await askFirst(ctx, GIT_SYNC_TOOL, input, gitPushSummary({
    target, upstream: branch.upstream, to: to.target, ahead: branch.ahead, behind: branch.behind,
    head: last ? { hash: last.hash, subject: last.subject } : null,
  }));
  if (refused) return refused;
  // The user approved pushing these commits there: anything that moved HEAD or the target since
  // would push other commits, or push them somewhere else.
  const again = await readChanges(ctx.callRoute, scope);
  if (!again.ok) return again.result;
  const toAgain = await pushTarget(scope, publish);
  if (headSignature(again.changes) !== headSignature(changes) || !toAgain.ok || JSON.stringify(toAgain.target) !== JSON.stringify(to.target)) {
    return staleResult(GIT_SYNC_TOOL, "The branch, its last commit, its upstream or the remote it pushes to changed while the card waited.");
  }
  // A push names the remote and the full refspec the card showed, so the repository's push
  // configuration (a push remote, `push.default = matching`, a forced `remote.<r>.push`, a
  // mirror) cannot send it anywhere else. Publish builds the same kind of refspec itself.
  const res = publish
    ? await ctx.callRoute<{ remote: string; branch: string }>("POST", gitRoute(scope, "publish"), {})
    : await ctx.callRoute("POST", gitRoute(scope, "push"), { remote: to.target.remote, branch: to.target.refspec });
  if (!res.ok) return routeErrorResult(publish ? "Publishing failed" : "The push failed", res);
  return jsonResult({ ...repoLabel(scope), pushed: true, ...(publish ? { published: res.data } : {}), ...(await afterState(ctx, scope)) });
}

/**
 * `name` as git checks it out, or why not: no dash first, no range, nothing git forbids, and no
 * leading `+`, which a later push would read as a forced refspec (`assertRef` refuses it).
 */
function refArg(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.length > 250) return { ok: false, error: `\`${label}\` must be a branch name.` };
  try {
    return { ok: true, value: assertRef(value, label) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function gitBranch(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const action = args.action;
  if (action !== "create" && action !== "switch") return errorResult("`action` must be \"create\" or \"switch\".");
  const name = refArg(args.name, "name");
  if (!name.ok) return errorResult(name.error);
  const from = args.from === undefined || args.from === null ? null : refArg(args.from, "from");
  if (from && !from.ok) return errorResult(from.error);
  if (from && action !== "create") return errorResult("`from` applies to create only.");
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const { scope } = got;
  const [read, list] = await Promise.all([
    readChanges(ctx.callRoute, scope),
    ctx.callRoute<GitBranch[]>("GET", gitRoute(scope, "branches")),
  ]);
  if (!read.ok) return read.result;
  if (!list.ok || !list.data) return routeErrorResult("PPM could not list the branches", list);
  const local = new Set(list.data.filter((b) => !b.remote).map((b) => b.name));
  const remote = list.data.filter((b) => b.remote).map((b) => b.name.replace(/^remotes\//, "")).filter((n) => !n.endsWith("/HEAD"));
  const target = cardTarget(scope, read.changes);
  const uncommitted = read.changes.files.length;
  const input = { ...repoLabel(scope), action, name: name.value, ...(from?.ok ? { from: from.value } : {}) };

  if (action === "create") {
    if (local.has(name.value)) return errorResult(`A branch named ${name.value} already exists; switch to it instead.`);
    const refused = await askFirst(ctx, GIT_BRANCH_TOOL, input, gitBranchSummary({
      target, action, name: name.value, from: from?.ok ? from.value : null, tracks: null, uncommitted,
    }));
    if (refused) return refused;
    const res = await ctx.callRoute("POST", gitRoute(scope, "branch/create"), { name: name.value, ...(from?.ok ? { from: from.value } : {}) });
    if (!res.ok) return routeErrorResult("Creating the branch failed", res);
    return jsonResult({ ...repoLabel(scope), created: name.value, current: name.value });
  }

  if (read.changes.branch.head === name.value) return errorResult(`${name.value} is already checked out.`);
  // A local branch is checked out; a branch only on a remote gets a local one following it.
  let body: { ref: string; mode: "checkout" | "track" };
  let tracks: string | null = null;
  let localName = name.value;
  if (local.has(name.value)) {
    body = { ref: name.value, mode: "checkout" };
  } else {
    const exact = remote.includes(name.value) ? name.value : null;
    const matches = exact ? [exact] : remote.filter((r) => r.slice(r.indexOf("/") + 1) === name.value);
    const chosen = matches.length === 1 ? matches[0]! : matches.find((m) => m.startsWith("origin/"));
    if (!chosen) {
      return errorResult(matches.length
        ? `${name.value} exists on several remotes (${matches.join(", ")}); name one, e.g. "${matches[0]}".`
        : `There is no branch named ${name.value}, locally or on a remote. Fetch first, or create it.`);
    }
    localName = chosen.slice(chosen.indexOf("/") + 1);
    // `origin/+main` passes as a name, but the local branch it would create is `+main`.
    if (localName.startsWith("+")) return errorResult(`A branch name may not start with "+": ${localName}.`);
    if (local.has(localName)) {
      body = { ref: localName, mode: "checkout" };
    } else {
      body = { ref: chosen, mode: "track" };
      tracks = chosen;
    }
  }
  const refused = await askFirst(ctx, GIT_BRANCH_TOOL, input, gitBranchSummary({ target, action, name: localName, from: null, tracks, uncommitted }));
  if (refused) return refused;
  const res = await ctx.callRoute("POST", gitRoute(scope, "checkout"), body);
  if (!res.ok) return routeErrorResult("Switching failed (git refuses when uncommitted changes would be overwritten)", res);
  return jsonResult({ ...repoLabel(scope), current: localName, ...(tracks ? { tracks } : {}) });
}

export async function gitStash(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const action = args.action;
  if (action !== "save" && action !== "apply" && action !== "pop" && action !== "drop") {
    return errorResult("`action` must be \"save\", \"apply\", \"pop\" or \"drop\".");
  }
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const { scope } = got;
  const read = await readChanges(ctx.callRoute, scope);
  if (!read.ok) return read.result;
  const target = cardTarget(scope, read.changes);

  if (action === "save") {
    const message = optionalString(args.message, "message", 2000);
    if (!message.ok) return errorResult(message.error);
    const untracked = optionalBoolean(args.includeUntracked, "includeUntracked");
    if (!untracked.ok) return errorResult(untracked.error);
    if (read.changes.truncated) return errorResult("This repository has too many changes for a card to list them all; stash from PPM.");
    const files = read.changes.files.filter((f) => !f.untracked || untracked.value).map((f) => f.path);
    if (files.length === 0) return errorResult(`There is nothing to stash${untracked.value ? "" : " (untracked files are only stashed with includeUntracked)"}.`);
    const input = { ...repoLabel(scope), action, ...(message.value ? { message: message.value } : {}), includeUntracked: untracked.value };
    const refused = await askFirst(ctx, GIT_STASH_TOOL, input, gitStashSaveSummary({
      target, files, message: message.value ?? null, includeUntracked: untracked.value,
    }));
    if (refused) return refused;
    const res = await ctx.callRoute<{ stashed: boolean; stash: StashEntry | null }>("POST", gitRoute(scope, "stash"), {
      ...(message.value ? { message: message.value } : {}), includeUntracked: untracked.value,
    });
    if (!res.ok) return routeErrorResult("Stashing failed", res);
    const stash = res.data?.stash ?? null;
    return jsonResult({ ...repoLabel(scope), stashed: !!stash, stash: stash ? { index: stash.index, hash: stash.hash, message: stash.message } : null });
  }

  const index = intArg(args.index, -1, 0, 10_000);
  if (index === null || index < 0) return errorResult("`index` is required: the stash's index from git_status (0 is the newest).");
  const list = await ctx.callRoute<StashEntry[]>("GET", gitRoute(scope, "stashes"));
  if (!list.ok || !list.data) return routeErrorResult("PPM could not list the stashes", list);
  const stash = list.data.find((s) => s.index === index);
  if (!stash) return errorResult(`There is no stash@{${index}}. See git_status for the list.`);
  const refused = await askFirst(ctx, GIT_STASH_TOOL, { ...repoLabel(scope), action, index, hash: stash.hash }, gitStashEntrySummary({ target, action, stash }));
  if (refused) return refused;
  // The hash goes with the index: the route refuses if stash@{index} is no longer this stash.
  const res = await ctx.callRoute<{ indexRestored?: boolean }>("POST", gitRoute(scope, `stash/${action}`), { index, hash: stash.hash });
  if (!res.ok) {
    return /stash list changed/i.test(res.error ?? "")
      ? staleResult(GIT_STASH_TOOL, "The stash list changed while the card waited.")
      : routeErrorResult(`Stash ${action} failed`, res);
  }
  return jsonResult({
    ...repoLabel(scope), [action === "apply" ? "applied" : action === "pop" ? "popped" : "dropped"]: { index, hash: stash.hash },
    ...(res.data?.indexRestored === false ? { note: "Staged changes came back unstaged: the staged part no longer applied on its own." } : {}),
  });
}
