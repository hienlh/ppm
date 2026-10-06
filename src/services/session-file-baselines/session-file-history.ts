/**
 * Every state a file passed through in a chat session, call by call: what tells which turn
 * wrote a block of the review (`session-file-blame.ts`), and what reverting a turn undoes.
 *
 * The session's "before" copy (`session-file-baselines.service.ts`) is one state per file; this
 * is all of them. Each call that can write a file — a file tool, a shell command, a codex patch —
 * reports the file as it was just before the call and just after it, so a change no call
 * reported (the user's own edit, a formatter on save, another program) is told apart from the
 * calls' own changes: it lies between one call's "after" and the next call's "before".
 *
 * A state is stored as the change from the state before it, a few hundred bytes for an ordinary
 * edit, so a file edited two hundred times costs two hundred small deltas rather than two
 * hundred copies. A state that is not text (binary, over the size cap) keeps only a hash and
 * breaks the chain; the next text state is then stored whole.
 *
 * Layout: `<session dir>/history/<sha256 of the path>.jsonl`, appended to in order. Its first
 * line names the path; every other line is one observation (`HistoryLine`). Only this server
 * writes it, one observation of a file at a time.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, utimesSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { diffLines } from "diff";
import { decodeText, isBinaryContent } from "../binary-content.ts";
import { isCredentialPath } from "../fs-credential-path-guard.ts";
import { realPathOrSelf } from "../fs-ops/fs-real-path.ts";
import { splitLines } from "../../shared/review-blocks.ts";
import { BASELINE_MAX_BYTES, sessionDir, type BaselineSource } from "./session-file-baselines.service.ts";

/** A log past this keeps only hashes: a file rewritten whole hundreds of times is not worth more. */
export const HISTORY_MAX_FILE_BYTES = 16 * 1024 * 1024;

export type HistoryPhase = "before" | "after";

/** Lines kept (> 0) and dropped (< 0) from the previous state, and lines put in (strings, terminators included), in order. */
export type Delta = (number | string)[];

/** One line of a history log. */
interface HistoryLine {
  /** The call: a tool use id, or a codex item id. */
  c: string;
  p: "b" | "a";
  /** Milliseconds since the epoch. */
  t: number;
  /** `stateHash` of the text; null when the file did not exist. */
  h: string | null;
  /** The state is not kept: binary, over the size cap, or written past the log's cap. */
  k?: "binary" | "large" | "cap";
  /** The change from the previous state, when that state is known. */
  d?: Delta;
  /** The whole text, when the previous state is not known or the change would be bigger. */
  f?: string;
}

export interface HistoryEntry {
  call: string;
  phase: HistoryPhase;
  at: number;
  /** Null when the file did not exist. */
  hash: string | null;
  /** The file's text — "" when it did not exist — or null when this state was not kept. */
  text: string | null;
}

/** Where a replay stands: the bytes of the log read, and the state they led to. */
export interface HistoryPosition {
  bytes: number;
  /** Undefined before the first observation. */
  hash: string | null | undefined;
  text: string | null;
}

export const HISTORY_START: HistoryPosition = { bytes: 0, hash: undefined, text: null };

/** Names a text state: the first 64 bits of its SHA-256, plenty to tell one file's states apart. */
export function stateHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function encodeDelta(prev: string, next: string, timeoutMs = 200): Delta | null {
  const parts = diffLines(prev, next, { timeout: timeoutMs });
  if (!parts) return null;
  const out: Delta = [];
  for (const part of parts) {
    if (part.added) out.push(part.value);
    else {
      const n = splitLines(part.value).length;
      out.push(part.removed ? -n : n);
    }
  }
  return out;
}

/** `prev` with `delta` made in it; null when the delta does not fit it. */
export function applyDelta(prev: string, delta: Delta): string | null {
  const lines = splitLines(prev);
  const out: string[] = [];
  let i = 0;
  for (const op of delta) {
    if (typeof op === "string") out.push(op);
    else if (op > 0) {
      if (i + op > lines.length) return null;
      for (let k = 0; k < op; k++) out.push(lines[i++]!);
    } else {
      i -= op;
      if (i > lines.length) return null;
    }
  }
  return i === lines.length ? out.join("") : null;
}

function historyDir(sessionId: string): string | null {
  const dir = sessionDir(sessionId);
  return dir ? join(dir, "history") : null;
}

function logName(path: string): string {
  return `${createHash("sha256").update(path).digest("hex")}.jsonl`;
}

/** The log of `filePath` in the session, or null for an id that cannot name a directory. */
export function historyFile(sessionId: string, filePath: string): string | null {
  const dir = historyDir(sessionId);
  return dir && filePath ? join(dir, logName(resolve(filePath))) : null;
}

interface State {
  hash: string | null;
  text: string | null;
  kind?: "binary" | "large";
}

const ABSENT: State = { hash: null, text: "" };

function stateOf(source: BaselineSource | string): State {
  if (source === null) return ABSENT;
  if (source === "tooLarge") return { hash: "large", text: null, kind: "large" };
  if (typeof source === "string") return { hash: stateHash(source), text: source };
  if (source.length > BASELINE_MAX_BYTES) return { hash: "large", text: null, kind: "large" };
  if (isBinaryContent(source)) {
    return { hash: `bin:${createHash("sha256").update(source).digest("hex").slice(0, 16)}`, text: null, kind: "binary" };
  }
  const text = decodeText(source);
  return { hash: stateHash(text), text };
}

/** The file on disk now; null when it is not a file at all, or cannot be read. */
async function readState(path: string): Promise<State | null> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    if (st.size > BASELINE_MAX_BYTES) return { hash: `large:${st.size}:${st.mtimeMs}`, text: null, kind: "large" };
    return stateOf(new Uint8Array(await readFile(path)));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? ABSENT : null;
  }
}

/** The complete lines of `file` from byte `from` on, and the byte after the last of them. */
function readLines(file: string, from: number): { lines: string[]; end: number } {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { lines: [], end: from };
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= from) return { lines: [], end: from };
    const buf = Buffer.alloc(size - from);
    const read = readSync(fd, buf, 0, buf.length, from);
    // A line still being appended has no terminator yet: it is read next time.
    const last = buf.subarray(0, read).lastIndexOf(10);
    if (last < 0) return { lines: [], end: from };
    return { lines: buf.subarray(0, last).toString("utf8").split("\n"), end: from + last + 1 };
  } finally {
    closeSync(fd);
  }
}

function parseLine(raw: string): HistoryLine | null {
  try {
    const line = JSON.parse(raw) as HistoryLine;
    return typeof line?.c === "string" && (line.p === "b" || line.p === "a") ? line : null;
  } catch {
    return null;
  }
}

/** The text a line leaves, given the state before it. */
function textAfter(prev: HistoryPosition, line: HistoryLine): string | null {
  if (line.k) return null;
  if (line.h === null) return "";
  if (line.f !== undefined) return line.f;
  if (line.d) return prev.text === null ? null : applyDelta(prev.text, line.d);
  return line.h === prev.hash ? prev.text : null;
}

/**
 * The observations of `filePath` from `from` on (the start of the log by default), each with
 * the text it records, and where the replay ends.
 */
export function readHistory(sessionId: string, filePath: string, from: HistoryPosition = HISTORY_START): { entries: HistoryEntry[]; end: HistoryPosition } {
  const file = historyFile(sessionId, filePath);
  if (!file) return { entries: [], end: from };
  return replay(file, from);
}

function replay(file: string, from: HistoryPosition): { entries: HistoryEntry[]; end: HistoryPosition } {
  const { lines, end } = readLines(file, from.bytes);
  const entries: HistoryEntry[] = [];
  let pos: HistoryPosition = from;
  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;
    const text = textAfter(pos, line);
    entries.push({ call: line.c, phase: line.p === "b" ? "before" : "after", at: line.t, hash: line.h, text });
    pos = { bytes: pos.bytes, hash: line.h, text };
  }
  return { entries, end: { bytes: end, hash: pos.hash, text: pos.text } };
}

/** Where each log's writes stand, so an observation does not replay its log to find the last state. */
const tails = new Map<string, HistoryPosition>();
const TAILS_KEPT = 512;

function tailOf(file: string): HistoryPosition {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch { /* no log yet */ }
  const known = tails.get(file);
  if (known && known.bytes === size) return known;
  // Never seen, written by an earlier run, or gone with its session: read it again.
  const from = known && known.bytes < size ? known : HISTORY_START;
  return replay(file, from).end;
}

function rememberTail(file: string, pos: HistoryPosition): void {
  tails.delete(file);
  tails.set(file, pos);
  if (tails.size > TAILS_KEPT) tails.delete(tails.keys().next().value!);
}

const queues = new Map<string, Promise<void>>();

/** Run `task` after every earlier one for the same log, so its lines go in the order they were seen. */
function serialized(key: string, task: () => Promise<void>): Promise<void> {
  const next = (queues.get(key) ?? Promise.resolve()).then(task).catch((e) => {
    console.warn(`[session-history] observation failed: ${(e as Error).message}`);
  });
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

/**
 * Record `filePath` as it is just before or just after `call` changes it: read from disk, or
 * given as `source` when it was read earlier (a shell command's "before") or worked out (a codex
 * patch's). Never throws. A credential path is never recorded, as it is never copied.
 */
export function observeFile(sessionId: string, filePath: string, call: string, phase: HistoryPhase, source?: BaselineSource | string): Promise<void> {
  const dir = historyDir(sessionId);
  if (!dir || !filePath || !call) return Promise.resolve();
  const path = resolve(filePath);
  if (isCredentialPath(path)) return Promise.resolve();
  const file = join(dir, logName(path));
  const at = Date.now();
  return serialized(file, async () => {
    if (isCredentialPath(await realPathOrSelf(path))) return;
    const state = source === undefined ? await readState(path) : stateOf(source);
    if (!state) return;
    const tail = tailOf(file);
    const line: HistoryLine = { c: call, p: phase === "before" ? "b" : "a", t: at, h: state.hash };
    if (state.kind) line.k = state.kind;
    else if (tail.bytes > HISTORY_MAX_FILE_BYTES) line.k = "cap";
    else if (state.hash !== null && (state.hash !== tail.hash || tail.text === null)) {
      const text = state.text!;
      const delta = tail.text !== null && tail.hash !== undefined ? encodeDelta(tail.text, text) : null;
      // Checked once on the way in, so a replay can trust every delta it reads.
      if (delta && JSON.stringify(delta).length < text.length && applyDelta(tail.text!, delta) === text) line.d = delta;
      else line.f = text;
    }
    let out = `${JSON.stringify(line)}\n`;
    if (tail.bytes === 0) {
      mkdirSync(dir, { recursive: true });
      out = `${JSON.stringify({ path })}\n${out}`;
    }
    appendFileSync(file, out);
    rememberTail(file, { bytes: tail.bytes + Buffer.byteLength(out), hash: state.hash, text: line.k ? null : state.text });
    // An append moves no directory's mtime, and the session's is what keeps its files from
    // being pruned (`pruneSessionBaselines`): a session still writing files it captured long
    // ago would otherwise lose their "before"s, and its next write record a state it produced.
    try {
      const now = new Date();
      utimesSync(dirname(dir), now, now);
    } catch { /* pruned meanwhile: the next capture makes it again */ }
  });
}

/** Every path the session has a history for. */
export function historyPaths(sessionId: string): string[] {
  const dir = historyDir(sessionId);
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const path = headerPath(join(dir, name));
    if (path) out.push(path);
  }
  return out;
}

/** The path a log's first line names. */
function headerPath(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buf, 0, buf.length, 0);
    const end = buf.subarray(0, read).indexOf(10);
    const head = JSON.parse(buf.subarray(0, end < 0 ? read : end).toString("utf8")) as { path?: unknown };
    return typeof head.path === "string" ? head.path : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Test seam: forget every remembered log position. */
export function _resetSessionFileHistory(): void {
  tails.clear();
}
