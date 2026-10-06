/**
 * Answers in the block-by-block session review — keep blocks, open them again, or revert blocks
 * or whole files on disk — and Undo for every one of them.
 *
 * Every answer names each file at the version the browser drew it, and blocks by their keys
 * (`src/shared/review-blocks.ts`). The server cuts the blocks again from the disk and leaves a
 * file alone — answering `stale` — unless it is still exactly as drawn, so no block is ever kept
 * or reverted on lines nobody saw.
 *
 * Keeping writes the session's kept-block record (`session-review-blocks.ts`); a file whose last
 * open block is answered is then marked reviewed (`session-review-marks.ts`), as Keep file does.
 * A revert writes the base's lines back: the file's "before", or the state it was marked reviewed
 * in when only what changed since is open.
 *
 * Each answer is journalled under `<session dir>/undo/`: the session's own records for every file
 * it touched, as they were and as it left them, and for a revert the file before and after. Undo
 * puts a revert's change back even after other blocks of the file were answered — wherever its
 * lines are still as the revert left them — and the records only while nothing has answered the
 * file since. A file Undo cannot put back makes the whole Undo `stale`, so a turn's worth of
 * files never comes back half.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertReadPermitted } from "../fs-ops/fs-ops-read-write.service.ts";
import { realPathOrSelf } from "../fs-ops/fs-real-path.ts";
import { assertNotPpmSubtreeDeep } from "../fs-credential-path-guard.ts";
import { decodeText, isBinaryContent } from "../binary-content.ts";
import { sessionDir } from "./session-file-baselines.service.ts";
import { compare, headBytes, lineage, markReviewed, type Compared } from "./session-file-changes.service.ts";
import { clearReviewMark } from "./session-review-marks.ts";
import { answerRecordFiles, hashBase, writeKeptBlocks } from "./session-review-blocks.ts";
import { reapply, revertBlocks, type ReviewBlock } from "../../shared/review-blocks.ts";
import type {
  SessionAnswer,
  SessionAnswerFile,
  SessionAnswerResult,
  SessionFileAnswer,
  SessionFileChange,
} from "../../shared/session-file-changes.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("session-review");

/** A journal older than this is dropped: Undo is offered for seconds, and Change for a sitting. */
const UNDO_KEEP_MS = 24 * 60 * 60 * 1000;

/** A file bigger than this is not reverted: its bytes would have to be held for Undo. */
const REVERT_MAX_BYTES = 64 * 1024 * 1024;

export type Target = { exists: false } | { exists: true; bytes: string | Uint8Array };

interface UndoEntry {
  path: string;
  /** The session's own records for the file (`answerRecordFiles` order) before and after the answer; null where there was none. */
  records: { before: (string | null)[]; after: (string | null)[] };
  /**
   * A revert: whether the file existed before it (its bytes are then in `<id>.<n>.before`), the
   * version it left, and whether it left a file (written to `<id>.<n>.after`, to find the change
   * again once the file has moved on).
   */
  revert?: { before: boolean; afterVersion: string; after: boolean };
}

interface UndoRecord {
  id: string;
  entries: UndoEntry[];
  createdAt: string;
}

/** What one file's answer did, for the answer's result and its journal. */
interface Done {
  answer: SessionFileAnswer;
  changed: boolean;
  revert?: { before: Uint8Array | null; after: string | Uint8Array | null; afterVersion: string };
}

const textOf = (side: Compared["before"]): string => (side.exists ? side.text ?? "" : "");

const NOT_UTF8 = "This file is not plain UTF-8 text, so it can only be reverted by hand.";

/** Text that decoding may have mangled: a revert would write the replacement characters back. */
const lossy = (text: string): boolean => text.includes("\uFFFD");

export async function versionOf(path: string): Promise<string> {
  try {
    const st = await stat(path);
    return st.isFile() ? `${st.size}:${st.mtimeMs}` : "";
  } catch {
    return "";
  }
}

async function current(chain: string[], projectPath: string, path: string): Promise<SessionFileChange | null> {
  return (await compare(chain, projectPath, path).catch(() => null))?.change ?? null;
}

/**
 * Mark the file reviewed once every block it has is kept, as Keep file does. Returns the file as
 * it stands now.
 */
async function settle(sessionId: string, chain: string[], projectPath: string, path: string): Promise<SessionFileChange | null> {
  const compared = await compare(chain, projectPath, path).catch(() => null);
  const file = compared?.change ?? null;
  if (!compared || !file || file.reviewed || !file.blocks?.length || !file.blocks.every((b) => b.kept)) return file;
  return markReviewed(sessionId, compared) ? current(chain, projectPath, path) : file;
}

function readRecords(sessionId: string, path: string): (string | null)[] {
  return (answerRecordFiles(sessionId, path) ?? []).map((file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  });
}

function restoreRecords(sessionId: string, path: string, contents: (string | null)[]): void {
  (answerRecordFiles(sessionId, path) ?? []).forEach((file, i) => {
    const content = contents[i] ?? null;
    if (content === null) {
      rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  });
}

const sameRecords = (a: (string | null)[], b: (string | null)[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Keep blocks of one file, or open them again; a file that has no blocks is answered whole. */
async function keepOne(sessionId: string, chain: string[], projectPath: string, path: string, f: SessionAnswerFile, kept: boolean): Promise<Done> {
  const compared = await compare(chain, projectPath, path).catch(() => null);
  if (!compared || compared.change.version !== f.version) return { answer: { path, stale: true, file: compared?.change ?? null }, changed: false };
  const change = compared.change;
  const failed = (): Done => ({ answer: { path, error: "Could not save the answer", file: change }, changed: false });

  if (!compared.diff) {
    if (f.keys) return { answer: { path, stale: true, file: change }, changed: false };
    if (!kept) clearReviewMark(sessionId, chain, path);
    else if (!markReviewed(sessionId, compared)) return failed();
    return { answer: { path, file: await current(chain, projectPath, path) }, changed: true };
  }

  const all = new Set(compared.diff.blocks.map((b) => b.key));
  const keys = f.keys ?? [...all];
  if (kept && keys.some((k) => !all.has(k))) return { answer: { path, stale: true, file: change }, changed: false };
  const keptNow = new Set((change.blocks ?? []).filter((b) => b.kept).map((b) => b.key));
  for (const key of keys) {
    if (kept) keptNow.add(key);
    else keptNow.delete(key);
  }
  // Opening a block of a file marked reviewed takes the mark off; the other blocks stay kept.
  if (!kept && change.reviewed) clearReviewMark(sessionId, chain, path);
  if (!writeKeptBlocks(sessionId, path, hashBase(textOf(compared.before)), keptNow)) return failed();
  return { answer: { path, file: await settle(sessionId, chain, projectPath, path) }, changed: true };
}

/** The file with `keys` put back to the base's lines, or the whole base when `keys` is absent. */
async function revertTarget(compared: Compared, path: string, keys: string[] | undefined): Promise<Target | "stale" | string> {
  const { before: base, after } = compared;
  if (keys) {
    if (!compared.diff) return "This file can only be reverted whole.";
    if (lossy(textOf(base)) || lossy(textOf(after))) return NOT_UTF8;
    const chosen = keys.map((k) => compared.diff!.blocks.find((b) => b.key === k));
    if (chosen.some((b) => !b)) return "stale";
    const content = revertBlocks(textOf(base), textOf(after), chosen as ReviewBlock[]);
    // The last block of a file the session created takes the file with it.
    return !base.exists && content === "" ? { exists: false } : { exists: true, bytes: content };
  }
  if (!base.exists) return { exists: false };
  if (base.text !== undefined && !lossy(base.text)) return { exists: true, bytes: base.text };
  // A binary, oversized or mangled file kept no text to write; git has the bytes compared with HEAD.
  const bytes = compared.change.baseline === "head" && !compared.change.sinceReview ? await headBytes(path) : null;
  if (bytes) return { exists: true, bytes };
  return base.text !== undefined ? NOT_UTF8 : "There is no copy of this file from before to put back.";
}

/** Write `target` over `path` (through a symlink, to the file it names), behind the same guards as reading it. */
export async function writeTarget(path: string, target: Target): Promise<string> {
  const real = await realPathOrSelf(path);
  assertReadPermitted(path, real);
  await assertNotPpmSubtreeDeep(path);
  if (!target.exists) {
    await unlink(real).catch((e) => { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; });
    return "";
  }
  await mkdir(dirname(real), { recursive: true });
  await writeFile(real, target.bytes);
  return versionOf(path);
}

/** Revert blocks of one file, or the whole file. */
async function revertOne(sessionId: string, chain: string[], projectPath: string, path: string, f: SessionAnswerFile): Promise<Done> {
  const compared = await compare(chain, projectPath, path).catch(() => null);
  const stale = (): Done => ({ answer: { path, stale: true, file: compared?.change ?? null }, changed: false });
  if (!compared || compared.change.version !== f.version) return stale();
  const target = await revertTarget(compared, path, f.keys);
  if (target === "stale") return stale();
  if (typeof target === "string") return { answer: { path, error: target, file: compared.change }, changed: false };

  let before: Uint8Array | null = null;
  if (compared.after.exists) {
    if ((await stat(path)).size > REVERT_MAX_BYTES) return { answer: { path, error: "This file is too large to revert.", file: compared.change }, changed: false };
    before = await readFile(path);
    // Written since it was compared: the blocks were cut from other bytes than these.
    const hash = compared.after.hash;
    if (hash ? createHash("sha256").update(before).digest("hex") !== hash : (await versionOf(path)) !== f.version) return stale();
  } else if ((await versionOf(path)) !== "") {
    return stale();
  }
  const afterVersion = await writeTarget(path, target);
  return {
    answer: { path, file: await settle(sessionId, chain, projectPath, path) },
    changed: true,
    revert: { before, after: target.exists ? target.bytes : null, afterVersion },
  };
}

function undoDir(sessionId: string): string | null {
  const dir = sessionDir(sessionId);
  return dir ? join(dir, "undo") : null;
}

function pruneUndo(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > UNDO_KEEP_MS) rmSync(file, { force: true });
    } catch { /* gone already */ }
  }
}

/** Journal an answer for Undo. Null when it could not be written: the answer stands, without Undo. */
function journal(sessionId: string, entries: UndoEntry[], blobs: { name: string; bytes: string | Uint8Array }[]): string | null {
  const dir = undoDir(sessionId);
  if (!dir) return null;
  const id = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    pruneUndo(dir);
    for (const blob of blobs) writeFileSync(join(dir, `${id}.${blob.name}`), blob.bytes);
    const record: UndoRecord = { id, entries, createdAt: new Date().toISOString() };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(record));
    return id;
  } catch (e) {
    log.warn(`undo journal failed: ${(e as Error).message}`);
    for (const blob of blobs) rmSync(join(dir, `${id}.${blob.name}`), { force: true });
    return null;
  }
}

/**
 * Journal files written outside an answer — a turn's revert — so `undoSessionAnswer` puts them
 * back like a revert's: the bytes each file had, and what was written over them.
 */
export function journalWrites(
  sessionId: string,
  writes: { path: string; before: Uint8Array | null; after: string | null; afterVersion: string }[],
): string | null {
  const entries: UndoEntry[] = [];
  const blobs: { name: string; bytes: string | Uint8Array }[] = [];
  for (const [n, w] of writes.entries()) {
    const records = readRecords(sessionId, w.path);
    entries.push({ path: w.path, records: { before: records, after: records }, revert: { before: w.before !== null, afterVersion: w.afterVersion, after: w.after !== null } });
    if (w.before) blobs.push({ name: `${n}.before`, bytes: w.before });
    if (w.after !== null) blobs.push({ name: `${n}.after`, bytes: w.after });
  }
  return entries.length ? journal(sessionId, entries, blobs) : null;
}

/** Keep, open or revert blocks — or whole files — as the browser drew each file. */
export async function answerSessionChanges(p: {
  sessionId: string;
  projectPath: string;
  answer: SessionAnswer;
  files: SessionAnswerFile[];
}): Promise<SessionAnswerResult> {
  const chain = lineage(p.sessionId);
  const files: SessionFileAnswer[] = [];
  const entries: UndoEntry[] = [];
  const blobs: { name: string; bytes: string | Uint8Array }[] = [];
  const seen = new Set<string>();
  for (const f of p.files) {
    const path = resolve(p.projectPath, f.path);
    if (seen.has(path)) continue;
    seen.add(path);
    const records = readRecords(p.sessionId, path);
    const done = p.answer === "revert"
      ? await revertOne(p.sessionId, chain, p.projectPath, path, f)
      : await keepOne(p.sessionId, chain, p.projectPath, path, f, p.answer === "keep");
    files.push(done.answer);
    if (!done.changed) continue;
    const n = entries.length;
    const entry: UndoEntry = { path, records: { before: records, after: readRecords(p.sessionId, path) } };
    if (done.revert) {
      const { before, after, afterVersion } = done.revert;
      entry.revert = { before: before !== null, afterVersion, after: after !== null };
      if (before) blobs.push({ name: `${n}.before`, bytes: before });
      if (after !== null) blobs.push({ name: `${n}.after`, bytes: after });
    }
    entries.push(entry);
  }
  const undoId = entries.length ? journal(p.sessionId, entries, blobs) : null;
  // A revert rewrites files on disk; keep and open only move the session's own records.
  const stale = files.filter((f) => f.stale).length;
  const line = `session ${p.sessionId} review ${p.answer}: ${entries.length} of ${files.length} file(s) ${p.answer === "revert" ? "written" : "answered"}, ${stale} stale, undo=${undoId ?? "none"}`;
  if (p.answer === "revert") log.info(line);
  else log.debug(line);
  return { files, ...(undoId ? { undoId } : {}) };
}

/**
 * What putting a revert back writes: the bytes it replaced while the file is still as it left
 * it, or its change made again wherever those lines are untouched. Null when neither can be done.
 */
async function undoTarget(dir: string, id: string, n: number, entry: UndoEntry): Promise<Target | null> {
  const r = entry.revert!;
  const blob = (name: string) => readFileSync(join(dir, `${id}.${n}.${name}`));
  const before: Target = r.before ? { exists: true, bytes: blob("before") } : { exists: false };
  if ((await versionOf(entry.path)) === r.afterVersion) return before;
  if (!before.exists || !r.after) return null;
  const now = await readFile(entry.path).catch(() => null);
  if (!now) return null;
  const texts = [blob("after"), before.bytes as Uint8Array, now].map((b) => (isBinaryContent(b) ? null : decodeText(b)));
  if (texts.some((t) => t === null || lossy(t))) return null;
  const merged = reapply(texts[0]!, texts[1]!, texts[2]!);
  return merged === null ? null : { exists: true, bytes: merged };
}

/** Undo an answer: every file it touched, or none of them. */
export async function undoSessionAnswer(p: { sessionId: string; projectPath: string; undoId: string }): Promise<SessionAnswerResult> {
  const dir = undoDir(p.sessionId);
  if (!dir || !/^[0-9a-f-]{36}$/.test(p.undoId)) return { stale: true, files: [] };
  let record: UndoRecord;
  try {
    record = JSON.parse(readFileSync(join(dir, `${p.undoId}.json`), "utf8")) as UndoRecord;
  } catch {
    return { stale: true, files: [] };
  }
  const chain = lineage(p.sessionId);
  const plans: { entry: UndoEntry; target: Target | null; records: boolean }[] = [];
  let stale = false;
  for (const [n, entry] of record.entries.entries()) {
    const records = sameRecords(readRecords(p.sessionId, entry.path), entry.records.after);
    const target = entry.revert ? await undoTarget(dir, record.id, n, entry) : null;
    // A revert is undone by its bytes; an answer that wrote none, only while its records stand.
    if (entry.revert ? !target : !records) stale = true;
    plans.push({ entry, target, records });
  }
  const states = async () => Promise.all(record.entries.map(async (e) => ({ path: e.path, file: await current(chain, p.projectPath, e.path) })));
  if (stale) {
    log.debug(`session ${p.sessionId} undo ${record.id} not applied: a file moved since`);
    return { stale: true, files: await states() };
  }

  for (const { entry, target, records } of plans) {
    if (target) await writeTarget(entry.path, target);
    if (records) restoreRecords(p.sessionId, entry.path, entry.records.before);
  }
  for (const name of readdirSync(dir).filter((f) => f.startsWith(`${record.id}.`))) rmSync(join(dir, name), { force: true });
  log.info(`session ${p.sessionId} undid ${record.id}: ${plans.length} file(s), ${plans.filter((plan) => plan.target).length} rewritten on disk`);
  return { files: await states() };
}
