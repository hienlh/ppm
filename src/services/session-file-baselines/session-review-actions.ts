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
 * it touched, as they were and as it left them, and for a revert the file before and after. A
 * revert writes that journal before it writes any file (`journalAhead`), so a crash between two
 * writes leaves nothing Undo cannot put back, and a write that fails part way still leaves the
 * file's old bytes in the journal; with no journal it writes nothing. A file it cannot write is
 * answered with why, and the others still go.
 *
 * Undo puts back every file of an answer or none. It works each one out first: a file still as
 * the revert left it gets the bytes it replaced, one already back to them is left alone, and one
 * written since gets the revert's change made again wherever its lines are untouched; the
 * session's records go back only while nothing has answered the file since. A file it cannot
 * work out makes the whole Undo `stale`, and one that then cannot be written, or moves meanwhile,
 * takes back the files written before it and keeps the journal, so the same Undo can be asked
 * again. Only a file that cannot be taken back either — written again in that moment — stays
 * put back, and the error says so.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
   * A revert: whether the file existed before it (its bytes are then in `<id>.<blob>.before`) and
   * whether it left a file (written to `<id>.<blob>.after`). `blob` is the entry's place in the
   * journal as first written, and its place in the list when absent.
   */
  revert?: { blob?: number; before: boolean; after: boolean };
}

interface UndoRecord {
  id: string;
  entries: UndoEntry[];
  createdAt: string;
}

/** What one file's keep or open answer did, for the answer's result and its journal. */
interface Done {
  answer: SessionFileAnswer;
  changed: boolean;
}

/** A file's bytes on disk, or null when there is no file. */
export type State = Uint8Array | null;

/** The file's bytes; null when it does not exist. Any other failure to read it throws. */
export async function readState(path: string): Promise<State> {
  try {
    return await readFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

/** Whether a file read as `state` (undefined: it could not be read) holds exactly `expected`. */
export function sameState(state: State | undefined, expected: State | string): boolean {
  if (state === undefined) return false;
  if (state === null || expected === null) return state === expected;
  return Buffer.from(state).equals(typeof expected === "string" ? Buffer.from(expected) : Buffer.from(expected));
}

const stateOf = (target: Target): State | string => (target.exists ? target.bytes : null);
const targetOf = (state: State): Target => (state === null ? { exists: false } : { exists: true, bytes: state });

const textOf = (side: Compared["before"]): string => (side.exists ? side.text ?? "" : "");

const NOT_UTF8 = "This file is not plain UTF-8 text, so it can only be reverted by hand.";

const IS_LINK = "This is a symbolic link, so it can only be reverted by hand.";

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

/**
 * Write `target` over `path`, behind the same guards as reading it. A symbolic link is refused
 * either way: what stood there before may have been another file (`ln -sf AGENTS.md CLAUDE.md`),
 * so writing through it could overwrite the file it names, and a link taken away could not come
 * back by Undo, which keeps bytes rather than links.
 */
export async function writeTarget(path: string, target: Target): Promise<void> {
  const real = await realPathOrSelf(path);
  assertReadPermitted(path, real);
  await assertNotPpmSubtreeDeep(path);
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error(IS_LINK);
  if (!target.exists) {
    await unlink(real).catch((e) => { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; });
    return;
  }
  await mkdir(dirname(real), { recursive: true });
  await writeFile(real, target.bytes);
}

/** A revert of one file worked out, nothing written yet: what goes over the bytes it holds now. */
interface RevertPlan {
  path: string;
  compared: Compared;
  target: Target;
  /** The file as the blocks were cut from it; null when there is none. */
  before: State;
  /** The session's records for the file before the answer. */
  records: (string | null)[];
}

/** Work out the revert of blocks of one file, or of the whole file, or why it cannot be done. */
async function planRevert(sessionId: string, chain: string[], projectPath: string, path: string, f: SessionAnswerFile): Promise<RevertPlan | SessionFileAnswer> {
  const compared = await compare(chain, projectPath, path).catch(() => null);
  const stale: SessionFileAnswer = { path, stale: true, file: compared?.change ?? null };
  if (!compared || compared.change.version !== f.version) return stale;
  const target = await revertTarget(compared, path, f.keys);
  if (target === "stale") return stale;
  if (typeof target === "string") return { path, error: target, file: compared.change };

  let before: State = null;
  if (compared.after.exists) {
    if ((await stat(path)).size > REVERT_MAX_BYTES) return { path, error: "This file is too large to revert.", file: compared.change };
    before = await readFile(path);
    // Written since it was compared: the blocks were cut from other bytes than these.
    const hash = compared.after.hash;
    if (hash ? createHash("sha256").update(before).digest("hex") !== hash : (await versionOf(path)) !== f.version) return stale;
  } else if ((await versionOf(path)) !== "") {
    return stale;
  }
  return { path, compared, target, before, records: readRecords(sessionId, path) };
}

/**
 * Revert blocks or whole files: every file worked out, the journal written, then each file
 * written as long as it still holds the bytes it was worked out from.
 */
async function revertFiles(sessionId: string, chain: string[], projectPath: string, files: { path: string; f: SessionAnswerFile }[]): Promise<{ answers: SessionFileAnswer[]; undoId: string | null; written: number }> {
  const answers: SessionFileAnswer[] = [];
  const plans: { at: number; plan: RevertPlan }[] = [];
  for (const { path, f } of files) {
    const planned = await planRevert(sessionId, chain, projectPath, path, f)
      .catch((e): SessionFileAnswer => ({ path, error: (e as Error).message, file: null }));
    if ("target" in planned) plans.push({ at: answers.length, plan: planned });
    answers.push("target" in planned ? { path, file: planned.compared.change } : planned);
  }
  if (plans.length === 0) return { answers, undoId: null, written: 0 };

  const journal = journalAhead(sessionId, plans.map(({ plan }) => ({
    path: plan.path, records: plan.records, before: plan.before, after: plan.target.exists ? plan.target.bytes : null,
  })));
  if (!journal) {
    for (const { at, plan } of plans) answers[at] = { path: plan.path, error: "What Undo needs could not be saved, so nothing was written.", file: plan.compared.change };
    return { answers, undoId: null, written: 0 };
  }
  const written: number[] = [];
  for (const [n, { at, plan }] of plans.entries()) {
    try {
      if (!sameState(await readState(plan.path), plan.before)) {
        answers[at] = { path: plan.path, stale: true, file: await current(chain, projectPath, plan.path) };
        continue;
      }
      await writeTarget(plan.path, plan.target);
      written.push(n);
      answers[at] = { path: plan.path, file: await settle(sessionId, chain, projectPath, plan.path) };
    } catch (e) {
      answers[at] = { path: plan.path, error: (e as Error).message, file: plan.compared.change };
      // A write that failed part way changed the file all the same: Undo keeps its bytes.
      if (!sameState(await readState(plan.path).catch(() => undefined), plan.before)) written.push(n);
      log.error(`session ${sessionId} review revert could not write ${plan.path}:`, e);
    }
  }
  return { answers, undoId: settleJournal(sessionId, journal, written), written: written.length };
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
    for (const blob of blobs) {
      try {
        rmSync(join(dir, `${id}.${blob.name}`), { force: true });
      } catch { /* never written: the folder could not be made */ }
    }
    return null;
  }
}

/** A file about to be written: its bytes now (null: there is none), and what goes over them. */
export interface PlannedWrite {
  path: string;
  before: State;
  after: string | Uint8Array | null;
  /** The session's records for the file now; read here when absent. */
  records?: (string | null)[];
}

/** A journal written ahead of its writes. */
export interface OpenJournal { id: string; entries: UndoEntry[]; createdAt: string }

/**
 * Journal writes before any is made: each file's bytes now (`<id>.<n>.before`) and what goes
 * over them (`.after`), so Undo can put back whichever of them were made. Null when the journal
 * could not be written: then nothing may be written either.
 */
export function journalAhead(sessionId: string, writes: PlannedWrite[]): OpenJournal | null {
  const entries: UndoEntry[] = [];
  const blobs: { name: string; bytes: string | Uint8Array }[] = [];
  for (const [n, w] of writes.entries()) {
    const records = w.records ?? readRecords(sessionId, w.path);
    entries.push({ path: w.path, records: { before: records, after: records }, revert: { blob: n, before: w.before !== null, after: w.after !== null } });
    if (w.before) blobs.push({ name: `${n}.before`, bytes: w.before });
    if (w.after !== null) blobs.push({ name: `${n}.after`, bytes: w.after });
  }
  const id = entries.length ? journal(sessionId, entries, blobs) : null;
  return id ? { id, entries, createdAt: new Date().toISOString() } : null;
}

/**
 * Close a journal once its writes are made: only the files `written` (their places in it) stay,
 * each with the session's records as the answer left them. Returns its id, or null — and the
 * journal is gone — when nothing was written. Should the rewrite fail, the journal as written
 * ahead still puts back every file: one never written already holds its old bytes.
 */
export function settleJournal(sessionId: string, open: OpenJournal, written: number[]): string | null {
  const dir = undoDir(sessionId);
  if (!dir) return null;
  const files = (): string[] => {
    try {
      return readdirSync(dir).filter((name) => name.startsWith(`${open.id}.`));
    } catch {
      return [];
    }
  };
  if (written.length === 0) {
    for (const name of files()) rmSync(join(dir, name), { force: true });
    return null;
  }
  const kept = new Set(written);
  const entries = open.entries
    .filter((_, n) => kept.has(n))
    .map((e) => ({ ...e, records: { before: e.records.before, after: readRecords(sessionId, e.path) } }));
  try {
    const record: UndoRecord = { id: open.id, entries, createdAt: open.createdAt };
    const tmp = join(dir, `${open.id}.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, join(dir, `${open.id}.json`));
    // Only once the record no longer names them: the bytes of files that were not written.
    const blobs = new Set(entries.map((e) => e.revert?.blob));
    for (const name of files()) {
      const n = /^[^.]+\.(\d+)\.(before|after)$/.exec(name)?.[1];
      if (n !== undefined && !blobs.has(Number(n))) rmSync(join(dir, name), { force: true });
    }
  } catch (e) {
    log.warn(`undo journal ${open.id} kept as written ahead: ${(e as Error).message}`);
  }
  return open.id;
}

/** Keep, open or revert blocks — or whole files — as the browser drew each file. */
export async function answerSessionChanges(p: {
  sessionId: string;
  projectPath: string;
  answer: SessionAnswer;
  files: SessionAnswerFile[];
}): Promise<SessionAnswerResult> {
  const chain = lineage(p.sessionId);
  const named: { path: string; f: SessionAnswerFile }[] = [];
  for (const f of p.files) {
    const path = resolve(p.projectPath, f.path);
    if (!named.some((n) => n.path === path)) named.push({ path, f });
  }
  if (p.answer === "revert") {
    const { answers, undoId, written } = await revertFiles(p.sessionId, chain, p.projectPath, named);
    const stale = answers.filter((f) => f.stale).length;
    const failed = answers.filter((f) => f.error).length;
    log.info(`session ${p.sessionId} review revert: ${written} of ${answers.length} file(s) written, ${stale} stale, ${failed} refused, undo=${undoId ?? "none"}`);
    return { files: answers, ...(undoId ? { undoId } : {}) };
  }

  const files: SessionFileAnswer[] = [];
  const entries: UndoEntry[] = [];
  for (const { path, f } of named) {
    const records = readRecords(p.sessionId, path);
    const done = await keepOne(p.sessionId, chain, p.projectPath, path, f, p.answer === "keep");
    files.push(done.answer);
    if (done.changed) entries.push({ path, records: { before: records, after: readRecords(p.sessionId, path) } });
  }
  // Keep and open only move the session's own records, so their journal can come after.
  const undoId = entries.length ? journal(p.sessionId, entries, []) : null;
  const stale = files.filter((f) => f.stale).length;
  log.debug(`session ${p.sessionId} review ${p.answer}: ${entries.length} of ${files.length} file(s) answered, ${stale} stale, undo=${undoId ?? "none"}`);
  return { files, ...(undoId ? { undoId } : {}) };
}

/**
 * What putting a revert back writes over the file as it is `now`: the bytes the revert replaced
 * while the file is still as it left it, nothing ("done") once it holds them again, or else the
 * revert's change made again wherever its lines are untouched. Null when none of that can be done.
 */
function undoTarget(dir: string, id: string, n: number, entry: UndoEntry, now: State): Target | "done" | null {
  const r = entry.revert!;
  const blob = (name: string) => readFileSync(join(dir, `${id}.${r.blob ?? n}.${name}`));
  const before: State = r.before ? blob("before") : null;
  const after: State = r.after ? blob("after") : null;
  if (sameState(now, after)) return targetOf(before);
  if (sameState(now, before)) return "done";
  if (!before || !after || !now) return null;
  const texts = [after, before, now].map((b) => (isBinaryContent(b) ? null : decodeText(b)));
  if (texts.some((t) => t === null || lossy(t))) return null;
  const merged = reapply(texts[0]!, texts[1]!, texts[2]!);
  return merged === null ? null : { exists: true, bytes: merged };
}

/** A file an Undo writes: as it was found, and what goes over it. */
interface UndoWrite { path: string; now: State; target: Target }

/**
 * Put back what an Undo wrote, each file only while it still holds what the Undo left. Whether
 * every one of them went back.
 */
async function takeBack(writes: UndoWrite[]): Promise<boolean> {
  let all = true;
  for (const w of [...writes].reverse()) {
    try {
      if (sameState(await readState(w.path), stateOf(w.target))) await writeTarget(w.path, targetOf(w.now));
      else all = false;
    } catch (e) {
      all = false;
      log.error(`undo could not take back ${w.path}:`, e);
    }
  }
  return all;
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
  const states = async () => Promise.all(record.entries.map(async (e) => ({ path: e.path, file: await current(chain, p.projectPath, e.path) })));
  const notApplied = async () => {
    log.debug(`session ${p.sessionId} undo ${record.id} not applied: a file moved since`);
    return { stale: true, files: await states() };
  };

  const writes: UndoWrite[] = [];
  const records: UndoEntry[] = [];
  let stale = false;
  for (const [n, entry] of record.entries.entries()) {
    const standing = sameRecords(readRecords(p.sessionId, entry.path), entry.records.after);
    if (standing) records.push(entry);
    // A revert is undone by its bytes; an answer that wrote none, only while its records stand.
    if (!entry.revert) {
      if (!standing) stale = true;
      continue;
    }
    const now = await readState(entry.path).catch(() => undefined);
    const target = now === undefined ? null : undoTarget(dir, record.id, n, entry, now);
    if (target === null) stale = true;
    else if (target !== "done") writes.push({ path: entry.path, now: now!, target });
  }
  if (stale) return notApplied();

  const done: UndoWrite[] = [];
  for (const w of writes) {
    let failure: (Error & { status?: number }) | null = null;
    try {
      // Only over the bytes it was worked out from: a file written since makes the Undo stale.
      if (sameState(await readState(w.path), w.now)) {
        await writeTarget(w.path, w.target);
        done.push(w);
        continue;
      }
    } catch (e) {
      failure = e as Error;
    }
    const all = await takeBack(done);
    if (!failure && all) return notApplied();
    const why = `${failure ? `Could not put back ${basename(w.path)}: ${failure.message}` : `${basename(w.path)} changed while Undo ran`}. ${all ? "Nothing was undone." : "Some files could not be taken back; Undo again once they can be written."}`;
    log.error(`session ${p.sessionId} undo ${record.id} failed: ${why}`);
    throw Object.assign(new Error(why), { status: failure?.status });
  }
  for (const entry of records) restoreRecords(p.sessionId, entry.path, entry.records.before);
  for (const name of readdirSync(dir).filter((f) => f.startsWith(`${record.id}.`))) rmSync(join(dir, name), { force: true });
  log.info(`session ${p.sessionId} undid ${record.id}: ${record.entries.length} file(s), ${done.length} rewritten on disk`);
  return { files: await states() };
}
