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
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import simpleGit from "simple-git";
import { decodeText, isBinaryContent } from "../binary-content.ts";
import { assertReadPermitted } from "../fs-ops/fs-ops-read-write.service.ts";
import { realPathOrSelf } from "../fs-ops/fs-real-path.ts";
import { getBranchRow } from "../session-branch.service.ts";
import { BASELINE_MAX_BYTES, listBaselines, readBaseline, type FileBaseline } from "./session-file-baselines.service.ts";
import { clearReviewMark, findReviewMark, writeReviewMark, type ReviewMark } from "./session-review-marks.ts";
import { hashBase, keptBlocks } from "./session-review-blocks.ts";
import { blockCalls } from "./session-file-blame.ts";
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
    const calls = blockCalls({
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

/** Every file the session changed: those it kept a "before" for, then any other `paths`. */
export async function sessionFileChanges(p: {
  sessionId: string;
  projectPath: string;
  paths?: string[];
}): Promise<SessionFileChange[]> {
  const chain = lineage(p.sessionId);
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (raw: string) => {
    if (!raw || ordered.length >= MAX_SESSION_CHANGE_PATHS) return;
    const path = resolve(p.projectPath, raw);
    if (seen.has(path)) return;
    seen.add(path);
    ordered.push(path);
  };
  for (const id of [...chain].reverse()) for (const b of listBaselines(id)) add(b.path);
  for (const raw of p.paths ?? []) add(raw);

  const out: SessionFileChange[] = [];
  const repos: RepoCache = new Map();
  for (const path of ordered) {
    try {
      const compared = await compare(chain, p.projectPath, path, repos);
      if (compared) out.push(compared.change);
    } catch {
      // A path the guard refuses, or one that vanished mid-read, is simply not listed.
    }
  }
  return out;
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
