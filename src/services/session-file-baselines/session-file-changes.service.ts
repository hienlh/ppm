/**
 * What a chat session has changed, file by file: its "before" against the file on disk now.
 *
 * The before is the session's own copy (`session-file-baselines.service.ts`) when it has one.
 * A session older than those copies, or a file it changed in some way that took none, falls
 * back to the file at git HEAD — but only inside the project, because outside it there is no
 * reason to trust a path the browser names. Every read goes through the same guard as the
 * generic file routes, so a credential file is never served.
 *
 * A file whose before and after are the same — edited and then put back, or a write that
 * failed — has no change to review and is left out.
 *
 * A file the user marked reviewed (`session-review-marks.ts`) is still listed, flagged, so the
 * browser can hide it; once it changes again it is compared with the state it was marked in
 * rather than with its "before", so only what is new is left to read.
 *
 * Each text file is also cut into change blocks (`src/shared/review-blocks.ts`), flagged with
 * the ones the user kept (`session-review-blocks.ts`); a file marked reviewed has every block
 * kept. Keeping, reverting and undoing those answers is `session-review-actions.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import simpleGit from "simple-git";
import { decodeText, isBinaryContent } from "../binary-content.ts";
import { assertReadPermitted } from "../fs-ops/fs-ops-read-write.service.ts";
import { realPathOrSelf } from "../fs-ops/fs-real-path.ts";
import { getBranchRow } from "../session-branch.service.ts";
import { BASELINE_MAX_BYTES, baselinePaths, readBaseline, recordFile, sessionDir, type FileBaseline } from "./session-file-baselines.service.ts";
import { clearReviewMark, findReviewMark, writeReviewMark, type ReviewMark } from "./session-review-marks.ts";
import { answerRecordFiles, hashBase, keptBlocks } from "./session-review-blocks.ts";
import { blockCalls } from "./session-file-blame.ts";
import { historyFile } from "./session-file-history.ts";
import { onSessionFileWritten } from "./session-file-writes.ts";
import { computeBlocks, type BlockDiff } from "../../shared/review-blocks.ts";
import type {
  SessionChangeStatus,
  SessionFileChange,
  SessionFileDiff,
  SessionReviewResult,
} from "../../shared/session-file-changes.ts";

/** More than any session plausibly touches; a bigger request is cut, not refused. */
export const MAX_SESSION_CHANGE_PATHS = 500;

/** How far up a chain of edited versions and forks a missing "before" is looked for. */
const MAX_ANCESTORS = 20;

export type { SessionChangeStatus, SessionFileChange, SessionFileDiff, SessionReviewResult };

/** One side of a comparison: absent, text, or something that cannot be shown as text. */
type Present = { exists: true; text?: string; binary?: boolean; tooLarge?: boolean; version?: string; hash?: string };
export type Side = { exists: false } | Present;

/**
 * The session and every session it was branched from, nearest first. An edited version or a
 * fork carries its parent's history, and files are not rewound when one is made, so the
 * parent's "before" is this session's too.
 */
export function lineage(sessionId: string): string[] {
  const out = [sessionId];
  let current = sessionId;
  for (let i = 0; i < MAX_ANCESTORS; i++) {
    const parent = getBranchRow(current)?.parent_id;
    if (!parent || out.includes(parent)) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

function findBaseline(chain: string[], path: string): FileBaseline | null {
  for (const id of chain) {
    const found = readBaseline(id, path);
    if (found) return found;
  }
  return null;
}

function sideFromBaseline(b: FileBaseline): Side {
  if (!b.existed) return { exists: false };
  return { exists: true, text: b.content, binary: b.binary, tooLarge: b.tooLarge };
}

function sideFromBytes(bytes: Uint8Array): Present {
  if (bytes.length > BASELINE_MAX_BYTES) return { exists: true, tooLarge: true };
  if (isBinaryContent(bytes)) return { exists: true, binary: true };
  return { exists: true, text: decodeText(bytes) };
}

/** The file on disk now, through the generic read guard. A refused path throws. */
async function readCurrent(path: string): Promise<Side> {
  assertReadPermitted(path, await realPathOrSelf(path));
  try {
    const st = await stat(path);
    if (!st.isFile()) return { exists: false };
    const version = `${st.size}:${st.mtimeMs}`;
    if (st.size > BASELINE_MAX_BYTES) return { exists: true, tooLarge: true, version };
    const bytes = await readFile(path);
    return { ...sideFromBytes(bytes), version, hash: createHash("sha256").update(bytes).digest("hex") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") {
      return { exists: false };
    }
    throw e;
  }
}

/** Repository roots by directory, for one request: a session's files share a few. */
export type RepoCache = Map<string, Promise<string | null>>;

function repoTop(dir: string, cache: RepoCache): Promise<string | null> {
  let found = cache.get(dir);
  if (!found) {
    // simple-git refuses a directory that does not exist, as a deleted file's may not.
    let existing = dir;
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
    found = simpleGit(existing).revparse(["--show-toplevel"]).then((t) => t.trim() || null, () => null);
    cache.set(dir, found);
  }
  return found;
}

/**
 * The bytes HEAD holds at `rel`: null when it holds nothing there, undefined when what it holds
 * is no file's content — a symbolic link's blob is only the name it points to, so it is no
 * "before" for the file that name reaches.
 */
async function headBlob(top: string, rel: string): Promise<Uint8Array | null | undefined> {
  const git = simpleGit(top);
  const listed = await git.raw(["ls-tree", "-z", "HEAD", "--", rel]).catch(() => "");
  const entry = listed.split("\0").find((line) => line.slice(line.indexOf("\t") + 1) === rel);
  if (!entry) return null;
  if (!/^100(644|755) blob /.test(entry)) return undefined;
  return git.showBuffer([`HEAD:${rel}`]).catch(() => null);
}

/** The file at git HEAD in whatever repository holds it; null when no repository does, or HEAD holds no file there. */
async function readHead(path: string, cache: RepoCache): Promise<Side | null> {
  const top = await repoTop(dirname(path), cache);
  if (!top) return null;
  const rel = relative(top, path).split(sep).join("/");
  if (!rel || rel.startsWith("../")) return null;
  const bytes = await headBlob(top, rel);
  if (bytes === undefined) return null;
  return bytes ? sideFromBytes(bytes) : { exists: false };
}

/** The file's bytes at git HEAD, for putting back a file that has no text to diff; null when no repository has it. */
export async function headBytes(path: string): Promise<Uint8Array | null> {
  const top = await repoTop(dirname(path), new Map());
  if (!top) return null;
  const rel = relative(top, path).split(sep).join("/");
  if (!rel || rel.startsWith("../")) return null;
  return (await headBlob(top, rel)) ?? null;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface Compared {
  change: SessionFileChange;
  /** What the change is counted and diffed against: the "before", or the state marked reviewed. */
  before: Side;
  after: Side;
  /**
   * The blocks between the two, or null when either side is not text or the diff would stall
   * the server (a large file rewritten wholesale is the one case Myers' diff is slow at).
   */
  diff: BlockDiff | null;
}

function sideFromMark(mark: ReviewMark): Side {
  if (!mark.existed) return { exists: false };
  return { exists: true, text: mark.content, binary: mark.binary, tooLarge: mark.tooLarge };
}

/** Whether the file is still exactly as it was marked; past the size cap only its version can say. */
function isAsMarked(mark: ReviewMark, now: Side): boolean {
  if (!mark.existed || !now.exists) return !mark.existed && !now.exists;
  return mark.hash && now.hash ? mark.hash === now.hash : mark.version === now.version;
}

/** How the session changed `path`, or null when it did not. A path the read guard refuses throws. */
export async function compare(chain: string[], projectPath: string, path: string, repos: RepoCache = new Map()): Promise<Compared | null> {
  const baseline = findBaseline(chain, path);
  let before: Side | null = baseline ? sideFromBaseline(baseline) : null;
  if (!before && isInside(projectPath, path)) before = await readHead(path, repos);
  if (!before) return null;
  const after = await readCurrent(path);
  if (!before.exists && !after.exists) return null;

  const status: SessionChangeStatus = !before.exists ? "added" : !after.exists ? "deleted" : "modified";
  const beforeText = before.exists ? before.text : "";
  const afterText = after.exists ? after.text : "";
  if (beforeText !== undefined && afterText !== undefined && status === "modified" && beforeText === afterText) return null;

  // What is left to review: a file marked reviewed is hidden while it stays as marked, and
  // counted against the state it was marked in once it has moved on.
  const mark = findReviewMark(chain, path);
  const reviewed = !!mark && isAsMarked(mark, after);
  const base = mark && !reviewed ? sideFromMark(mark) : before;
  const baseText = base.exists ? base.text : "";
  const binary = (base.exists && base.binary) || (after.exists && after.binary) || undefined;
  const tooLarge = (base.exists && base.tooLarge) || (after.exists && after.tooLarge) || undefined;

  const version = after.exists ? after.version ?? "" : "";
  const change: SessionFileChange = { path, status, baseline: baseline ? "session" : "head", version };
  if (binary) change.binary = true;
  if (tooLarge) change.tooLarge = true;
  if (reviewed) change.reviewed = true;
  else if (mark) change.sinceReview = true;
  const diff = baseText !== undefined && afterText !== undefined ? computeBlocks(baseText, afterText) : null;
  if (diff) {
    change.additions = diff.additions;
    change.deletions = diff.deletions;
    const baseHash = hashBase(baseText!);
    change.base = baseHash.slice(0, 16);
    const kept = reviewed ? null : keptBlocks(chain, path, baseHash);
    const calls = await blockCalls({
      sessionId: chain[0]!,
      path,
      baseText: baseText!,
      currentText: afterText!,
      blocks: diff.blocks,
      ...(base !== before && mark ? { markedAt: Date.parse(mark.markedAt) } : {}),
    });
    change.blocks = diff.blocks.map((b, i) => ({
      key: b.key,
      added: b.added,
      removed: b.removed,
      ...(!kept || kept.has(b.key) ? { kept: true } : {}),
      ...(calls?.[i]?.length ? { calls: calls[i] } : {}),
    }));
  }
  return { change, before: base, after, diff };
}

/** Mark a file reviewed as it stands in `compared`. False when the mark could not be written. */
export function markReviewed(sessionId: string, compared: Compared): boolean {
  const { path } = compared.change;
  const now = compared.after;
  return now.exists
    ? writeReviewMark(sessionId, { path, existed: true, content: now.text, binary: now.binary, tooLarge: now.tooLarge, hash: now.hash, version: now.version })
    : writeReviewMark(sessionId, { path, existed: false });
}

/**
 * Each session's list, kept between asks: one entry per file, with a stamp of what it was worked
 * out from. Working a file out reads its "before" and its text now, diffs the two and replays
 * its history, which on a session that touched a few thousand files took minutes per ask;
 * stamping it is a few `stat`s. So an ask works out again only the files whose stamp moved,
 * whoever moved them — the agent, the user's answers, an editor, a checkout — and the agent's
 * own writes are worked out as they land and pushed to the browser (`onSessionFileChanges`).
 */
interface Entry {
  stamp: string;
  /** Null when the file is no change of the session's, or one it may not read. */
  change: SessionFileChange | null;
}

interface KeptList {
  sessionId: string;
  projectPath: string;
  /** The lineage at the last ask, which is what an entry's stamp was taken along. */
  chain: string[];
  entries: Map<string, Entry>;
  /** Asks and pushes one at a time: two would work the same file out side by side. */
  queue: Promise<unknown>;
}

const lists = new Map<string, KeptList>();
const LISTS_KEPT = 32;

/** Work done between two hand-backs to the event loop: a first ask can take minutes. */
const YIELD_AFTER_MS = 20;

/** A 0 ms timer, not `setImmediate`: that one starves HTTP (see `file-list-index.service.ts`). */
const breathe = () => new Promise<void>((done) => setTimeout(done, 0));

function listFor(sessionId: string, projectPath: string): KeptList {
  // By the session's directory, which names the PPM directory too.
  const key = `${sessionDir(sessionId)}\0${resolve(projectPath)}`;
  const list = lists.get(key) ?? { sessionId, projectPath, chain: [sessionId], entries: new Map(), queue: Promise.resolve() };
  lists.delete(key);
  lists.set(key, list);
  if (lists.size > LISTS_KEPT) lists.delete(lists.keys().next().value!);
  return list;
}

function queued<T>(list: KeptList, task: () => Promise<T>): Promise<T> {
  const next = list.queue.then(task, task);
  list.queue = next.catch(() => {});
  return next;
}

function statStamp(file: string | null): string {
  if (!file) return "";
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "-";
  }
}

type HeadCache = Map<string, Promise<string | null>>;

/** The commit HEAD names in the repository holding `dir`, once per ask and repository. */
async function headOf(dir: string, repos: RepoCache, heads: HeadCache): Promise<string | null> {
  const top = await repoTop(dir, repos);
  if (!top) return null;
  let head = heads.get(top);
  if (!head) {
    head = simpleGit(top).revparse(["HEAD"]).then((h) => h.trim() || null, () => null);
    heads.set(top, head);
  }
  return head;
}

/**
 * What `compare` reads for `path`, by `stat` alone: the file now; each session's "before",
 * review mark and kept blocks along the lineage; the history the blocks are named from; and for
 * a file with no "before", the HEAD it falls back to. Equal stamps mean an equal answer. Taken
 * before the file is worked out, so a write landing in between moves the next stamp, not this one.
 */
async function stampOf(chain: string[], projectPath: string, path: string, repos: RepoCache, heads: HeadCache): Promise<string> {
  const parts = [chain.join(","), statStamp(path)];
  let kept = false;
  for (const id of chain) {
    const dir = sessionDir(id);
    const before = dir ? statStamp(recordFile(dir, path)) : "-";
    if (before !== "-") kept = true;
    const answers = answerRecordFiles(id, path);
    parts.push(before, statStamp(answers?.[0] ?? null), statStamp(answers?.[1] ?? null));
  }
  parts.push(statStamp(historyFile(chain[0]!, path)));
  if (!kept && isInside(projectPath, path)) parts.push((await headOf(dirname(path), repos, heads)) ?? "");
  return parts.join("|");
}

/** The file's entry, worked out again only when its stamp moved. */
async function entryOf(list: KeptList, path: string, repos: RepoCache, heads: HeadCache): Promise<{ change: SessionFileChange | null; redone: boolean }> {
  const stamp = await stampOf(list.chain, list.projectPath, path, repos, heads);
  const held = list.entries.get(path);
  if (held && held.stamp === stamp) return { change: held.change, redone: false };
  // A path the guard refuses, or one that vanished mid-read, is simply not listed.
  const change = (await compare(list.chain, list.projectPath, path, repos).catch(() => null))?.change ?? null;
  list.entries.set(path, { stamp, change });
  workedOut++;
  return { change, redone: true };
}

let workedOut = 0;

/** Test seam: how many files the kept lists have worked out, from scratch or again. */
export function _sessionFilesWorkedOut(): number {
  return workedOut;
}

/**
 * The files the list is made of: those the session and its ancestors kept a "before" for, oldest
 * first, then `extra`. Past the cap the newest are kept — on a session that touched thousands of
 * files, the ones its latest turns changed are the ones being reviewed.
 */
function listedPaths(chain: string[], projectPath: string, extra: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (raw: string) => {
    if (!raw) return;
    const path = resolve(projectPath, raw);
    if (seen.has(path)) return;
    seen.add(path);
    ordered.push(path);
  };
  for (const id of [...chain].reverse()) for (const path of baselinePaths(id)) add(path);
  for (const raw of extra) add(raw);
  return ordered.length > MAX_SESSION_CHANGE_PATHS ? ordered.slice(-MAX_SESSION_CHANGE_PATHS) : ordered;
}

/** Every file the session changed: those it kept a "before" for, then any other `paths`. */
export function sessionFileChanges(p: {
  sessionId: string;
  projectPath: string;
  paths?: string[];
}): Promise<SessionFileChange[]> {
  const list = listFor(p.sessionId, p.projectPath);
  return queued(list, async () => {
    list.chain = lineage(list.sessionId);
    const repos: RepoCache = new Map();
    const heads: HeadCache = new Map();
    const out: SessionFileChange[] = [];
    let since = performance.now();
    for (const path of listedPaths(list.chain, list.projectPath, p.paths ?? [])) {
      const { change } = await entryOf(list, path, repos, heads);
      if (change) out.push(change);
      if (performance.now() - since > YIELD_AFTER_MS) {
        await breathe();
        since = performance.now();
      }
    }
    return out;
  });
}

/** What a push carries: the rows of the files just worked out again, and the files no longer changed. */
export interface SessionFileChangesPush {
  sessionId: string;
  projectPath: string;
  files: SessionFileChange[];
  gone: string[];
}

const pushListeners = new Set<(push: SessionFileChangesPush) => void>();

/** Subscribe to the rows pushed after the agent changed files; returns the unsubscribe function. */
export function onSessionFileChanges(cb: (push: SessionFileChangesPush) => void): () => void {
  pushListeners.add(cb);
  return () => {
    pushListeners.delete(cb);
  };
}

/** Folds one shell command's files, or a burst of edits, into one push. */
const PUSH_DELAY_MS = 150;
const written = new Map<string, Set<string>>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;

onSessionFileWritten((sessionId, path) => {
  let paths = written.get(sessionId);
  if (!paths) written.set(sessionId, (paths = new Set()));
  paths.add(resolve(path));
  pushTimer ??= setTimeout(pushWritten, PUSH_DELAY_MS);
});

/** Work out again the files the agent wrote, in every kept list along whose lineage it wrote them, and push them. */
function pushWritten(): void {
  pushTimer = null;
  const batch = new Map(written);
  written.clear();
  for (const list of lists.values()) {
    const paths = new Set<string>();
    for (const id of list.chain) for (const path of batch.get(id) ?? []) paths.add(path);
    if (paths.size === 0) continue;
    void queued(list, async () => {
      const repos: RepoCache = new Map();
      const heads: HeadCache = new Map();
      const push: SessionFileChangesPush = { sessionId: list.sessionId, projectPath: list.projectPath, files: [], gone: [] };
      for (const path of paths) {
        const was = list.entries.get(path)?.change ?? null;
        const { change, redone } = await entryOf(list, path, repos, heads);
        if (!redone) continue;
        if (change) push.files.push(change);
        else if (was) push.gone.push(path);
      }
      if (push.files.length === 0 && push.gone.length === 0) return;
      for (const cb of pushListeners) {
        try {
          cb(push);
        } catch (e) {
          console.warn(`[session-baselines] push listener failed: ${(e as Error).message}`);
        }
      }
    }).catch((e) => console.warn(`[session-baselines] push failed: ${(e as Error).message}`));
  }
}

/** Test seam: forget every kept list and pending push. */
export function _resetSessionFileChanges(): void {
  lists.clear();
  written.clear();
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
}

/** Both sides of one file, for the diff editor. Null when the session did not change it. */
export async function sessionFileDiff(p: { sessionId: string; projectPath: string; path: string }): Promise<SessionFileDiff | null> {
  const path = resolve(p.projectPath, p.path);
  const compared = await compare(lineage(p.sessionId), p.projectPath, path, new Map());
  if (!compared) return null;
  const text = (side: Side) => (side.exists && side.text !== undefined ? side.text : "");
  return { ...compared.change, original: text(compared.before), modified: text(compared.after) };
}

/**
 * Mark files reviewed in the state the browser showed them in, or unmark them. A file is
 * marked only while it is still one of the session's changes and still at the `version` that
 * was shown: one the agent moved on since would otherwise be hidden with a change nobody has
 * read. Those are named in `stale`, for the browser to ask again.
 */
export async function setSessionFilesReviewed(p: {
  sessionId: string;
  projectPath: string;
  files: { path: string; version: string }[];
  reviewed: boolean;
}): Promise<SessionReviewResult> {
  const chain = lineage(p.sessionId);
  const repos: RepoCache = new Map();
  const updated: string[] = [];
  const stale: string[] = [];
  for (const file of p.files.slice(0, MAX_SESSION_CHANGE_PATHS)) {
    const path = resolve(p.projectPath, file.path);
    if (!p.reviewed) {
      if (clearReviewMark(p.sessionId, chain, path)) updated.push(path);
      continue;
    }
    // A path the read guard refuses is no change of the session's, as it is not listed either.
    const compared = await compare(chain, p.projectPath, path, repos).catch(() => null);
    if (!compared || compared.change.version !== file.version) {
      stale.push(path);
      continue;
    }
    (markReviewed(p.sessionId, compared) ? updated : stale).push(path);
  }
  return { updated, stale };
}
