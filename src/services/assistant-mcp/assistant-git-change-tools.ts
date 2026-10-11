import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Json } from "../mcp-http-endpoint.ts";
import type { ChangedFile, DiscardRecord, GitChanges } from "../../shared/git-changes.ts";
import { GIT_COMMIT_TOOL, GIT_DISCARD_TOOL, GIT_STAGE_TOOL, GIT_UNDO_TOOL } from "../../shared/assistant-git-tool-names.ts";
import {
  gitCommitSummary, gitDiscardSummary, gitStageSummary, gitUndoCommitSummary, gitUndoDiscardSummary, type DiscardFile,
} from "./assistant-approval-summary-git.ts";
import {
  askFirst, cardTarget, filesArg, gitRoute, optionalBoolean, readChanges, repoLabel, routeErrorResult, scopeOrError, staleResult,
} from "./assistant-git-tool-helpers.ts";
import { errorResult, jsonResult } from "./assistant-tool-output.ts";
import type { ToolContext } from "./assistant-tool-family.ts";

/**
 * The git tools that change the working tree, the index or the last commit: stage, discard,
 * undo and commit. Each reads the repository through PPM's routes, refuses what git would refuse
 * (or what the card could not show truthfully) before asking, asks, and only then calls the same
 * write route Source Control calls — so the Undo journal, the shared commit message and the
 * `git:changed` broadcast all happen exactly as for a click.
 */

/** The size above which PPM's discard journal keeps no copy (`git-discard-journal.service.ts`). */
export const DISCARD_KEEP_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_COMMIT_MESSAGE_CHARS = 20_000;

/** The listed file each requested path names, or the first path that is not listed for this action. */
function pickFiles(changes: GitChanges, wanted: string[], fits: (f: ChangedFile) => boolean, what: string): ChangedFile[] | string {
  const byPath = new Map(changes.files.map((f) => [f.path, f]));
  const picked: ChangedFile[] = [];
  for (const path of wanted) {
    const f = byPath.get(path);
    if (!f || !fits(f)) {
      const listedNote = changes.truncated ? " (the change list is cut short in very large trees; narrow the work in PPM)" : "";
      return `"${path.slice(0, 300)}" has no ${what}${listedNote}. Use the paths git_status lists.`;
    }
    picked.push(f);
  }
  return picked;
}

export async function gitStage(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const files = filesArg(args.files);
  if (!files.ok) return errorResult(files.error);
  const unstage = optionalBoolean(args.unstage, "unstage");
  if (!unstage.ok) return errorResult(unstage.error);
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const read = await readChanges(ctx.callRoute, got.scope);
  if (!read.ok) return read.result;

  const picked = unstage.value
    ? pickFiles(read.changes, files.files, (f) => f.staged !== null, "staged change to unstage")
    : pickFiles(read.changes, files.files, (f) => f.untracked || f.unstaged !== null || f.conflict, "unstaged change to stage");
  if (typeof picked === "string") return errorResult(picked);

  const refused = await askFirst(ctx, GIT_STAGE_TOOL, { ...repoLabel(got.scope), files: files.files, unstage: unstage.value }, gitStageSummary({
    target: cardTarget(got.scope, read.changes), unstage: unstage.value,
    files: picked.map((f) => ({ path: f.path, conflict: f.conflict })),
  }));
  if (refused) return refused;

  const res = await ctx.callRoute("POST", gitRoute(got.scope, unstage.value ? "unstage" : "stage"), { files: files.files });
  if (!res.ok) return routeErrorResult(unstage.value ? "Unstaging failed" : "Staging failed", res);
  return jsonResult({ ...repoLabel(got.scope), [unstage.value ? "unstaged" : "staged"]: files.files });
}

async function sizeOver(path: string, limit: number): Promise<boolean> {
  try {
    return (await stat(path)).size > limit;
  } catch {
    return false; // gone already: there is nothing to keep, and git reports it as a deletion
  }
}

export async function gitDiscard(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const files = filesArg(args.files);
  if (!files.ok) return errorResult(files.error);
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const read = await readChanges(ctx.callRoute, got.scope);
  if (!read.ok) return read.result;

  // Only what the route discards: unstaged edits and untracked files. A conflicted file has no
  // unstaged side git can check out, and staged changes are left alone by design.
  const picked = pickFiles(read.changes, files.files, (f) => !f.conflict && (f.untracked || f.unstaged !== null), "unstaged change to discard");
  if (typeof picked === "string") return errorResult(picked);
  // A stat, not git: the journal decides what it keeps by size, and the card has to say which
  // files would be gone for good.
  const cards: DiscardFile[] = await Promise.all(picked.map(async (f) => ({
    path: f.path, untracked: f.untracked, tooLarge: await sizeOver(join(got.scope.path, f.path), DISCARD_KEEP_MAX_BYTES),
  })));

  const refused = await askFirst(ctx, GIT_DISCARD_TOOL, { ...repoLabel(got.scope), files: files.files },
    gitDiscardSummary({ target: cardTarget(got.scope, read.changes), files: cards }));
  if (refused) return refused;

  const res = await ctx.callRoute<{ discarded: string[]; undo: DiscardRecord | null }>("POST", gitRoute(got.scope, "discard"), { files: files.files });
  if (!res.ok) {
    return routeErrorResult("The discard failed, possibly part way (git_status lists an Undo for whatever already went)", res);
  }
  const undo = res.data?.undo ?? null;
  return jsonResult({
    ...repoLabel(got.scope),
    discarded: files.files,
    undo: undo ? { id: undo.id, ...(undo.skipped?.length ? { notKept: undo.skipped } : {}) } : null,
    note: undo ? "Undo within a day with git_undo { kind: \"discard\", id }." : "PPM could not keep a copy, so this discard cannot be undone.",
  });
}

export async function gitUndo(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  if (args.kind !== "discard" && args.kind !== "commit") return errorResult("`kind` must be \"discard\" or \"commit\".");
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const read = await readChanges(ctx.callRoute, got.scope);
  if (!read.ok) return read.result;
  const target = cardTarget(got.scope, read.changes);

  if (args.kind === "discard") {
    if (typeof args.id !== "string" || !args.id) return errorResult("`id` is required: the discard's id from git_discard or git_status.");
    const list = await ctx.callRoute<DiscardRecord[]>("GET", gitRoute(got.scope, "discards"));
    if (!list.ok || !list.data) return routeErrorResult("PPM could not list the discards", list);
    const record = list.data.find((d) => d.id === args.id);
    if (!record) return errorResult("No discard with that id can still be undone here (they are kept for one day). See git_status.");
    const refused = await askFirst(ctx, GIT_UNDO_TOOL, { ...repoLabel(got.scope), kind: "discard", id: record.id }, gitUndoDiscardSummary({ target, record }));
    if (refused) return refused;
    const res = await ctx.callRoute<{ paths: string[] }>("POST", gitRoute(got.scope, "discard/undo"), { id: record.id });
    if (!res.ok) return res.status === 409 ? staleResult(GIT_UNDO_TOOL, res.error ?? "A file changed since the discard.") : routeErrorResult("Undo failed", res);
    return jsonResult({ ...repoLabel(got.scope), restored: res.data?.paths ?? record.paths });
  }

  if (typeof args.hash !== "string" || !/^[0-9a-f]{7,64}$/.test(args.hash)) {
    return errorResult("`hash` is required: the last commit's id (at least 7 hex digits), from git_status or git_commit.");
  }
  const last = read.changes.lastCommit;
  // Every reason the route would refuse, before a card the user cannot usefully approve.
  if (!last || !last.hash.startsWith(args.hash)) return errorResult(`${args.hash.slice(0, 12)} is not the last commit; only the last commit can be undone.`);
  if (last.pushed) return errorResult("That commit is already on the remote; undoing it would rewrite pushed history. PPM will not do that.");
  if (!last.hasParent) return errorResult("The first commit of a repository cannot be undone this way.");
  if (read.changes.operation) return errorResult(`Finish or abort the ${read.changes.operation.kind} first.`);

  const refused = await askFirst(ctx, GIT_UNDO_TOOL, { ...repoLabel(got.scope), kind: "commit", hash: last.hash },
    gitUndoCommitSummary({ target, commit: { hash: last.hash, subject: last.subject } }));
  if (refused) return refused;
  // The route checks again that it is still the last, unpushed commit: 409 otherwise.
  const res = await ctx.callRoute<{ hash: string }>("POST", gitRoute(got.scope, "commit/undo"), { hash: last.hash });
  if (!res.ok) return res.status === 409 ? staleResult(GIT_UNDO_TOOL, res.error ?? "The last commit changed.") : routeErrorResult("Undo failed", res);
  return jsonResult({ ...repoLabel(got.scope), undone: last.hash, note: "Its changes are staged again and its message is back in the commit box." });
}

/** The staged state a commit card shows, as one comparable string. */
function stagedSignature(changes: GitChanges): string {
  const staged = changes.files.filter((f) => f.staged !== null)
    .map((f) => [f.path, f.oldPath ?? "", f.x, f.y, f.staged!.added, f.staged!.removed].join("\u0000"))
    .sort();
  return JSON.stringify([changes.branch.head, changes.branch.oid, staged]);
}

export async function gitCommit(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const amend = optionalBoolean(args.amend, "amend");
  const signoff = optionalBoolean(args.signoff, "signoff");
  if (!amend.ok) return errorResult(amend.error);
  if (!signoff.ok) return errorResult(signoff.error);
  const message = args.message ?? "";
  if (typeof message !== "string") return errorResult("`message` must be a string.");
  if (!amend.value && !message.trim()) return errorResult("`message` is required for a new commit.");
  if (message.length > MAX_COMMIT_MESSAGE_CHARS) return errorResult(`\`message\` is longer than ${MAX_COMMIT_MESSAGE_CHARS} characters.`);
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const read = await readChanges(ctx.callRoute, got.scope);
  if (!read.ok) return read.result;
  const { changes } = read;

  if (changes.truncated) return errorResult("This repository has too many changes for a card to list them all; commit from PPM's Source Control.");
  if (changes.files.some((f) => f.conflict)) return errorResult("Some files are still in conflict; resolve and stage them first.");
  const staged = changes.files.filter((f) => f.staged !== null);
  if (!amend.value && staged.length === 0) return errorResult("Nothing is staged. Stage files with git_stage first.");
  const last = changes.lastCommit;
  if (amend.value && !last) return errorResult("There is no commit to amend.");

  const signature = stagedSignature(changes);
  const refused = await askFirst(ctx, GIT_COMMIT_TOOL, { ...repoLabel(got.scope), message, amend: amend.value, signoff: signoff.value }, gitCommitSummary({
    target: cardTarget(got.scope, changes),
    files: staged.map((f) => ({ path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), x: f.x })),
    message,
    amend: amend.value && last ? { hash: last.hash, subject: last.subject, pushed: last.pushed } : null,
    signoff: signoff.value,
  }));
  if (refused) return refused;

  // The card may have waited for hours: commit only what it showed, on the commit it showed.
  const again = await readChanges(ctx.callRoute, got.scope);
  if (!again.ok) return again.result;
  if (stagedSignature(again.changes) !== signature) {
    return staleResult(GIT_COMMIT_TOOL, "The staged files or the branch's last commit changed while the card waited.");
  }
  const res = await ctx.callRoute<{ hash: string }>("POST", gitRoute(got.scope, "commit"), {
    message, ...(amend.value ? { amend: true } : {}), ...(signoff.value ? { signoff: true } : {}),
  });
  if (!res.ok) return routeErrorResult("The commit failed (a commit hook may have refused it)", res);
  return jsonResult({ ...repoLabel(got.scope), committed: res.data?.hash ?? null, files: staged.length, amended: amend.value });
}
