import type { Json } from "../mcp-http-endpoint.ts";
import type { GitChanges } from "../../shared/git-changes.ts";
import type { GitGraphData, GitRef } from "../../types/git.ts";
import type { HistoryCard } from "./assistant-approval-summary-git-history.ts";
import type { GitRepoScope } from "./assistant-git-repo-scope.ts";
import { gitRoute, refArg, routeErrorResult } from "./assistant-git-tool-helpers.ts";
import { errorResult } from "./assistant-tool-output.ts";
import type { ToolContext } from "./assistant-tool-family.ts";

/**
 * What a `git_history` call will do, worked out before the card: its arguments checked, the
 * commit or branch it names looked up through PPM's own routes (never trusted as the agent
 * spelled it), and the refusals git would otherwise answer with half a change made.
 */

export const HISTORY_ACTIONS = ["merge", "cherry_pick", "revert", "tag", "abort", "continue"] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/** The arguments each action takes; any other one is refused rather than ignored. */
const ACTION_ARGS: Record<HistoryAction, readonly string[]> = {
  merge: ["source"], cherry_pick: ["hash"], revert: ["hash"], tag: ["name", "at"], abort: [], continue: [],
};
const OPTIONAL_ARGS = ["source", "hash", "name", "at"] as const;

const HASH = /^[0-9a-f]{7,64}$/i;
/** How far back a commit named by hash is looked for, across every branch. */
export const HISTORY_LOOKUP = 1000;

export interface HistoryPlan {
  card: HistoryCard;
  /** The write route's body, built from what was looked up. */
  body: Record<string, unknown>;
  /** For a merge: the source branch's tip the card showed, checked again after the answer. */
  sourceTip?: string;
}

export type Planned = { ok: true; plan: HistoryPlan } | { ok: false; result: Json };

const refuse = (message: string): Planned => ({ ok: false, result: errorResult(message) });

export function actionOf(value: unknown): HistoryAction | null {
  return (HISTORY_ACTIONS as readonly unknown[]).includes(value) ? (value as HistoryAction) : null;
}

/** An argument the action does not take, named so the agent can drop it. */
export function strayArgument(action: HistoryAction, args: Record<string, unknown>): string | null {
  const stray = OPTIONAL_ARGS.find((key) => args[key] !== undefined && args[key] !== null && !ACTION_ARGS[action].includes(key));
  return stray ? `\`${stray}\` does not apply to ${action}.` : null;
}

/** A commit by full or abbreviated hash, as the history lists it; one match only. */
async function findCommit(ctx: ToolContext, scope: GitRepoScope, value: unknown, label: string) {
  if (typeof value !== "string" || !HASH.test(value)) {
    return { ok: false as const, result: errorResult(`\`${label}\` must be a commit id: 7 to 64 hexadecimal characters, as git_log gives it.`) };
  }
  const res = await ctx.callRoute<GitGraphData>("GET", gitRoute(scope, "graph", { max: HISTORY_LOOKUP }));
  if (!res.ok || !res.data) return { ok: false as const, result: routeErrorResult("PPM could not read the history", res) };
  const want = value.toLowerCase();
  const matches = res.data.commits.filter((c) => c.hash.toLowerCase().startsWith(want));
  if (matches.length === 0) {
    return { ok: false as const, result: errorResult(`No commit ${value} among the newest ${HISTORY_LOOKUP} commits of any branch. Check it with git_log.`) };
  }
  if (matches.length > 1) return { ok: false as const, result: errorResult(`${value} names ${matches.length} commits; give more of the hash.`) };
  return { ok: true as const, commit: matches[0]! };
}

async function readRefs(ctx: ToolContext, scope: GitRepoScope): Promise<{ ok: true; refs: GitRef[] } | { ok: false; result: Json }> {
  const res = await ctx.callRoute<GitRef[]>("GET", gitRoute(scope, "refs"));
  if (!res.ok || !res.data) return { ok: false, result: routeErrorResult("PPM could not list the branches and tags", res) };
  return { ok: true, refs: res.data };
}

/** A local branch by name, or a remote one as `origin/x`; never a remote's HEAD alias. */
export const mergeSource = (refs: GitRef[], name: string): GitRef | undefined =>
  refs.find((r) => (r.type === "branch" || (r.type === "remote" && !r.name.endsWith("/HEAD"))) && r.name === name);

/** The refusals every action shares, read off the repository's state. */
function stateProblem(action: HistoryAction, changes: GitChanges): string | null {
  const { operation, files, branch } = changes;
  const conflicts = files.filter((f) => f.conflict).length;
  if (action === "abort" || action === "continue") {
    if (!operation) return `There is no merge, rebase, cherry-pick or revert under way to ${action}.`;
    if (action === "continue" && conflicts) return `${conflicts} file(s) are still in conflict: resolve them and stage them with git_stage first.`;
    return null;
  }
  if (operation) return `A ${operation.kind} is under way; finish it with git_history continue, or abort it, first.`;
  if (conflicts) return `${conflicts} file(s) are in conflict; resolve them first.`;
  if (!branch.oid) return "This repository has no commit yet.";
  if (action === "tag") return null;
  if (!branch.head) return "HEAD is detached; switch to a branch first (git_branch).";
  if (files.some((f) => !f.untracked && (f.staged || f.unstaged))) return "There are uncommitted changes to tracked files: commit or stash them first.";
  return null;
}

export async function planHistory(ctx: ToolContext, scope: GitRepoScope, action: HistoryAction, args: Record<string, unknown>, changes: GitChanges): Promise<Planned> {
  const problem = stateProblem(action, changes);
  if (problem) return refuse(problem);
  const { branch, operation, lastCommit } = changes;

  if (action === "abort" || action === "continue") return { ok: true, plan: { card: { action, operation: operation! }, body: {} } };

  if (action === "merge") {
    const source = refArg(args.source, "source");
    if (!source.ok) return refuse(source.error);
    if (source.value === branch.head) return refuse(`${source.value} is the branch checked out; it cannot be merged into itself.`);
    const refs = await readRefs(ctx, scope);
    if (!refs.ok) return refs;
    const ref = mergeSource(refs.refs, source.value);
    if (!ref) return refuse(`There is no branch named ${source.value}, locally or as a remote branch like origin/${source.value}. See git_branches.`);
    return { ok: true, plan: { card: { action, source: ref.name, sourceTip: ref.hash }, body: { source: ref.name }, sourceTip: ref.hash } };
  }

  if (action === "cherry_pick" || action === "revert") {
    const found = await findCommit(ctx, scope, args.hash, "hash");
    if (!found.ok) return found;
    const { commit } = found;
    if (commit.parents.length > 1) return refuse(`${commit.hash.slice(0, 7)} is a merge commit; picking or reverting one is not supported here.`);
    return { ok: true, plan: { card: { action, commit: { hash: commit.hash, subject: commit.subject } }, body: { hash: commit.hash } } };
  }

  // Tag.
  const name = refArg(args.name, "name");
  if (!name.ok) return refuse(name.error);
  const refs = await readRefs(ctx, scope);
  if (!refs.ok) return refs;
  if (refs.refs.some((r) => r.type === "tag" && r.name === name.value)) return refuse(`A tag named ${name.value} already exists.`);
  let commit = { hash: branch.oid!, subject: lastCommit?.hash === branch.oid ? lastCommit.subject : "" };
  if (args.at !== undefined && args.at !== null) {
    const found = await findCommit(ctx, scope, args.at, "at");
    if (!found.ok) return found;
    commit = { hash: found.commit.hash, subject: found.commit.subject };
  }
  return { ok: true, plan: { card: { action, name: name.value, commit }, body: { name: name.value, hash: commit.hash } } };
}
