import type { Json } from "../mcp-http-endpoint.ts";
import type { ChangedFile, ChangeSide, ChangeSideDetail, DiscardRecord, FileChangeDetail, StashEntry } from "../../shared/git-changes.ts";
import type { GitBranch, GitGraphData } from "../../types/git.ts";
import { resolveGitRepo } from "./assistant-git-repo-scope.ts";
import {
  DATA_NOTE, gitRoute, optionalString, readChanges, repoLabel, routeErrorResult, scopeOrError,
} from "./assistant-git-tool-helpers.ts";
import { clip, errorResult, intArg, jsonResult } from "./assistant-tool-output.ts";
import type { ToolContext } from "./assistant-tool-family.ts";

/**
 * The git tools that only read: status, log, diff and branches. Each answers from PPM's own git
 * routes and keeps only listed fields — no author e-mail, no remote URL — because the answer goes
 * to the AI provider. Whatever the repository holds (messages, diffs, branch names) is labelled as
 * data, never as instructions.
 */

export const MAX_STATUS_FILES = 300;
export const MAX_DIFF_BYTES = 40 * 1024;
const MAX_BODY_CHARS = 500;

const side = (s: ChangeSide | null) => (s ? { added: s.added, removed: s.removed, ...(s.whole ? { whole: s.whole } : {}) } : null);

const fileRow = (f: ChangedFile) => ({
  path: f.path,
  ...(f.oldPath ? { oldPath: f.oldPath } : {}),
  x: f.x, y: f.y, untracked: f.untracked, conflict: f.conflict,
  staged: side(f.staged), unstaged: side(f.unstaged),
});

export async function gitStatus(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const resolved = await resolveGitRepo(ctx.callRoute, args.project, args.repo);
  if (!resolved.ok) {
    // A container project with several repositories is an answer, not a failure: the agent
    // needs exactly this list to name one.
    if (resolved.repos && (args.repo === undefined || args.repo === null)) {
      return jsonResult({ project: args.project, repositories: resolved.repos, note: "Pass `repo` with one of these relative paths." });
    }
    return resolved.repos ? errorResult(`${resolved.error} Repositories: ${resolved.repos.map((r) => r.relative).join(", ")}`) : errorResult(resolved.error);
  }
  const { scope } = resolved;
  const [read, stashes, discards] = await Promise.all([
    readChanges(ctx.callRoute, scope),
    ctx.callRoute<StashEntry[]>("GET", gitRoute(scope, "stashes")),
    ctx.callRoute<DiscardRecord[]>("GET", gitRoute(scope, "discards")),
  ]);
  if (!read.ok) return read.result;
  const { changes } = read;
  const files = changes.files.slice(0, MAX_STATUS_FILES).map(fileRow);
  return jsonResult({
    ...repoLabel(scope),
    branch: {
      name: changes.branch.head,
      detached: changes.branch.head === null,
      commit: changes.branch.oid,
      upstream: changes.branch.upstream,
      upstreamGone: changes.branch.upstreamGone,
      ahead: changes.branch.ahead,
      behind: changes.branch.behind,
      hasRemote: changes.branch.hasRemote,
    },
    operation: changes.operation,
    lastCommit: changes.lastCommit
      ? { hash: changes.lastCommit.hash, subject: clip(changes.lastCommit.subject, 300), date: changes.lastCommit.date, pushed: changes.lastCommit.pushed, hasParent: changes.lastCommit.hasParent }
      : null,
    fileCount: changes.files.length,
    truncated: changes.truncated || changes.files.length > files.length,
    stashes: stashes.ok && stashes.data
      ? stashes.data.map((s) => ({ index: s.index, hash: s.hash, message: clip(s.message, 300), branch: s.branch, date: s.date }))
      : [],
    undoableDiscards: discards.ok && discards.data
      ? discards.data.map((d) => ({ id: d.id, kind: d.kind, files: d.paths, createdAt: new Date(d.createdAt).toISOString(), ...(d.skipped?.length ? { notKept: d.skipped } : {}) }))
      : [],
    note: DATA_NOTE,
    files,
  }, { key: "files", list: files });
}

export async function gitLog(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const max = intArg(args.max, 30, 1, 100);
  const skip = intArg(args.skip, 0, 0, 1_000_000);
  if (max === null) return errorResult("`max` must be a whole number from 1 to 100.");
  if (skip === null) return errorResult("`skip` must be a whole number, 0 or more.");
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const res = await ctx.callRoute<GitGraphData>("GET", gitRoute(got.scope, "graph", { max, skip }));
  if (!res.ok || !res.data) return routeErrorResult("PPM could not read the history", res);
  const commits = res.data.commits.map((c) => ({
    hash: c.hash,
    subject: c.subject,
    ...(c.body?.trim() ? { body: clip(c.body.trim(), MAX_BODY_CHARS) } : {}),
    authorName: c.authorName,
    authorDate: c.authorDate,
    parents: c.parents,
    refs: c.refs,
  }));
  return jsonResult({
    ...repoLabel(got.scope),
    head: res.data.head,
    skip,
    ...(commits.length === max ? { next: { skip: skip + max } } : {}),
    note: `Every branch's history, newest first. ${DATA_NOTE}`,
    commits,
  }, { key: "commits", list: commits });
}

/** One side of a file's changes, written back out as unified-diff text. */
function renderSide(label: string, s: ChangeSideDetail | null): string {
  if (!s) return "";
  const head = `### ${label} (+${s.added} −${s.removed})\n`;
  if (s.whole && s.hunks.length === 0) return `${head}(shown whole: ${s.whole})\n`;
  return head + s.hunks.map((h) => [
    `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.heading ? ` ${h.heading}` : ""}`,
    ...h.lines.map((l) => `${l.kind}${l.text}${l.noNewline ? "\n\\ No newline at end of file" : ""}`),
  ].join("\n")).join("\n") + "\n";
}

function cutDiff(text: string): { diff: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_DIFF_BYTES) return { diff: text, truncated: false };
  return { diff: `${bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n… [diff cut at ${MAX_DIFF_BYTES / 1024} KB; ask for one file]`, truncated: true };
}

export async function gitDiff(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const file = optionalString(args.file, "file", 4096);
  const from = optionalString(args.from, "from", 250);
  const to = optionalString(args.to, "to", 250);
  if (!file.ok) return errorResult(file.error);
  if (!from.ok) return errorResult(from.error);
  if (!to.ok) return errorResult(to.error);
  if (to.value && !from.value) return errorResult("`to` needs `from`: the diff runs from `from` to `to`.");
  if (to.value && file.value) return errorResult("`file` cannot be combined with `to`; ask for the two revisions without `file`, or for one file against `from` alone.");
  if (!from.value && !file.value) return errorResult("Name a `file` to see its uncommitted changes, or give `from` (and `to`) to compare revisions.");
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const { scope } = got;

  let text: string;
  if (!from.value) {
    const res = await ctx.callRoute<FileChangeDetail>("GET", gitRoute(scope, "changes/file", { path: file.value }));
    if (!res.ok || !res.data) return routeErrorResult("PPM could not read that file's changes", res);
    const d = res.data;
    text = renderSide("Staged (HEAD → index)", d.staged) + renderSide("Unstaged (index → working tree)", d.unstaged);
    if (!text) text = "(no uncommitted changes)";
  } else {
    const res = file.value
      ? await ctx.callRoute<{ diff: string }>("GET", gitRoute(scope, "file-diff", { file: file.value, ref: from.value }))
      : await ctx.callRoute<{ diff: string }>("GET", gitRoute(scope, "diff", { ref1: from.value, ref2: to.value }));
    if (!res.ok || !res.data) return routeErrorResult("PPM could not build that diff", res);
    text = res.data.diff || "(no differences)";
  }
  return jsonResult({
    ...repoLabel(scope),
    ...(file.value ? { file: file.value } : {}),
    ...(from.value ? { from: from.value } : {}),
    ...(to.value ? { to: to.value } : {}),
    note: DATA_NOTE,
    ...cutDiff(text),
  });
}

export async function gitBranches(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const got = await scopeOrError(ctx, args);
  if ("result" in got) return got.result;
  const [branches, read] = await Promise.all([
    ctx.callRoute<GitBranch[]>("GET", gitRoute(got.scope, "branches")),
    readChanges(ctx.callRoute, got.scope),
  ]);
  if (!branches.ok || !branches.data) return routeErrorResult("PPM could not list the branches", branches);
  const list = branches.data;
  const current = read.ok ? read.changes.branch : null;
  return jsonResult({
    ...repoLabel(got.scope),
    current: current
      ? { name: current.head, commit: current.oid, upstream: current.upstream, upstreamGone: current.upstreamGone, ahead: current.ahead, behind: current.behind }
      : null,
    local: list.filter((b) => !b.remote).map((b) => ({ name: b.name, current: b.current, commit: b.commitHash })),
    // `remotes/origin/main` → `origin/main`: what checkout and the UI call it. Names only, never URLs.
    remote: list.filter((b) => b.remote && !/\/HEAD$/.test(b.name)).map((b) => ({ name: b.name.replace(/^remotes\//, ""), commit: b.commitHash })),
    note: DATA_NOTE,
  });
}
