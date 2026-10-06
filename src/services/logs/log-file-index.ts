/**
 * An index over one log file — `ppm.log` (or a rotated copy) or `cloudflared.log`: where each
 * record starts and ends in the file, plus its columns (`log-columns.ts`). Text is read back
 * from disk only for the records a page shows or a search has to look through.
 *
 * A record is a line with the file's head (`[time] [LEVEL] [tag] …` / `time LVL …`) and every
 * line after it without one: a stack trace, a multi-line message. One exception: a process's
 * own stderr lands in `ppm.log` unprefixed (the supervisor hands the server the log file as
 * stdio), and a line that plainly starts such a message — `[Bun.serve]: …`, `Warning: …`,
 * `TypeError: …` — becomes a record of its own under the `stderr` tag, at the time of the record
 * before it, rather than being shown as part of an unrelated line above.
 *
 * Record ids are `<kind><generation>.<byte offset>`, where the generation is the time of the
 * file's first record. Rotation copies `ppm.log` to `ppm.log.1` byte for byte before truncating
 * it, so a record keeps its id when it moves to the older file.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { areaOfTag, sessionIdOf, STDERR_TAG, UNTAGGED, type LogEntry, type LogLevel, type LogSourceId } from "../../shared/logs-model.ts";
import { redactSecrets } from "../redact-secrets.ts";
import { copyInto, FLAG_RESTART, RecordColumns } from "./log-columns.ts";

export type LogFileFormat = "ppm" | "cloudflared";

/** Bytes processed between two yields to the event loop while indexing. */
const YIELD_EVERY_BYTES = 2 * 1024 * 1024;
/** How much of a line is decoded to read its head and the chat id near its start. */
const HEAD_BYTES = 600;
/** Longest first line and most continuation lines one entry carries to the browser. */
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_MORE_LINES = 300;

const PPM_HEAD = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z)\] \[(DEBUG|INFO|WARN|ERROR|FATAL)\] (?:\[([^\]\s]{1,48})\] )?/;
const CLOUDFLARED_HEAD = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z) (DBG|INF|WRN|ERR|FTL) /;
const CLOUDFLARED_LEVEL: Readonly<Record<string, LogLevel>> = { DBG: "debug", INF: "info", WRN: "warn", ERR: "error", FTL: "fatal" };
/** A line that starts a message a process printed itself, as opposed to continuing a record. */
const STDERR_START = /^(?:\[Bun\.serve\]|Warning: |\(node:\d+\) |Unhandled (?:rejection|promise)|(?:Uncaught )?(?:[A-Z][A-Za-z]*)?Error(?: \[[\w-]+\])?: )/;
const STDERR_WARN = /^(?:\[Bun\.serve\]|Warning: |\(node:\d+\) )/;
const RESTART_TEXT = "Server started (PID";

export const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The generation a file's ids carry (its first record's time, base 36), from its first line. */
export function readFirstGen(path: string, format: LogFileFormat): string | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const head = parseHead(format, buf.toString("utf8", 0, n));
    return head ? Math.round(head.ts).toString(36) : null;
  } finally {
    closeSync(fd);
  }
}

interface Head {
  ts: number;
  lv: LogLevel;
  src: LogSourceId;
  tag: string;
  /** Length of the head in characters, i.e. where the message starts on the first line. */
  headChars: number;
}

function parseHead(format: LogFileFormat, line: string): Head | null {
  if (format === "ppm") {
    const m = PPM_HEAD.exec(line);
    if (!m) return null;
    const tag = m[3] ?? UNTAGGED;
    return { ts: Date.parse(m[1]!), lv: m[2]!.toLowerCase() as LogLevel, src: areaOfTag(tag), tag, headChars: m[0].length };
  }
  const m = CLOUDFLARED_HEAD.exec(line);
  if (!m) return null;
  return { ts: Date.parse(m[1]!), lv: CLOUDFLARED_LEVEL[m[2]!] ?? "info", src: "tunnel", tag: "cloudflared", headChars: m[0].length };
}

export class LogFileIndex {
  readonly cols = new RecordColumns();
  /** Byte offset of each record, and its length up to (not including) its last newline. */
  off = new Float64Array(256);
  len = new Uint32Array(256);
  /** Bytes consumed so far: up to the end of the last complete line. */
  scanned = 0;
  ino = 0;
  mtimeMs = 0;
  /** Time of the first record, base 36: the part of every id that names this file's content. */
  gen = "";
  lastUsed = Date.now();
  private building: Promise<void> | null = null;
  /**
   * The file's first bytes as indexed. Rotation empties `ppm.log` in place, and a file that has
   * grown past its old length again by the next refresh looks merely appended to by size alone.
   */
  private firstBytes: Buffer | null = null;

  constructor(readonly path: string, readonly format: LogFileFormat) {}

  get count(): number {
    return this.cols.count;
  }

  get prefix(): string {
    return this.format === "ppm" ? "p" : "c";
  }

  idOf(i: number): string {
    return `${this.prefix}${this.gen}.${this.off[i]!.toString(36)}`;
  }

  /** The record an id names, if it is in this file. */
  indexOfId(id: string): number {
    const dot = id.indexOf(".");
    if (dot < 0 || id[0] !== this.prefix || id.slice(1, dot) !== this.gen) return -1;
    const off = parseInt(id.slice(dot + 1), 36);
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.off[mid]! < off) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.count && this.off[lo] === off ? lo : -1;
  }

  /**
   * Bring the index up to the file on disk: read what was appended since the last call, or start
   * over when the file was replaced or truncated (rotation empties `ppm.log` in place). Returns
   * the index of the first new record, so the live tail can send exactly those.
   */
  async refresh(): Promise<{ from: number; reset: boolean } | null> {
    // `while`: every caller waiting on one build wakes at once, and the first to go may start
    // the next one — the rest must wait for that too, or they scan the same bytes again.
    while (this.building) await this.building;
    let st;
    try { st = statSync(this.path); } catch { return null; }
    const reset = st.ino !== this.ino || st.size < this.scanned || !this.sameStart();
    if (!reset && st.size === this.scanned) {
      this.mtimeMs = st.mtimeMs;
      return { from: this.count, reset: false };
    }
    let from = this.count;
    const run = (async () => {
      if (reset) {
        this.clear();
        this.ino = st.ino;
        from = 0;
      }
      await this.scan(st.size);
      this.mtimeMs = st.mtimeMs;
    })();
    this.building = run;
    try { await run; } finally { this.building = null; }
    return { from, reset };
  }

  private clear(): void {
    this.cols.count = 0;
    this.scanned = 0;
    this.gen = "";
    this.firstBytes = null;
  }

  private sameStart(): boolean {
    const want = this.firstBytes;
    if (!want) return true;
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { return false; }
    try {
      const buf = Buffer.alloc(want.length);
      const n = readSync(fd, buf, 0, want.length, 0);
      return n === want.length && buf.equals(want);
    } finally {
      closeSync(fd);
    }
  }

  private ensureRoom(): void {
    if (this.cols.count < this.off.length) return;
    const n = this.off.length * 2;
    this.off = copyInto(new Float64Array(n), this.off);
    this.len = copyInto(new Uint32Array(n), this.len);
  }

  private async scan(size: number): Promise<void> {
    const start = this.scanned;
    const length = size - start;
    if (length <= 0) return;
    const buf = Buffer.allocUnsafe(length);
    const fd = openSync(this.path, "r");
    let got = 0;
    try {
      while (got < length) {
        const n = readSync(fd, buf, got, length - got, start + got);
        if (n <= 0) break;
        got += n;
      }
    } finally {
      closeSync(fd);
    }
    if (start === 0 && got > 0) this.firstBytes = Buffer.from(buf.subarray(0, Math.min(64, got)));
    let pos = 0;
    let sinceYield = 0;
    /** Unprefixed lines before the first record of a fresh file, held until a time is known. */
    let orphanFrom = -1;
    while (pos < got) {
      const nl = buf.indexOf(10, pos);
      if (nl < 0 || nl >= got) break; // a line still being written: picked up next time
      const lineEnd = nl > pos && buf[nl - 1] === 13 ? nl - 1 : nl;
      this.takeLine(buf, pos, lineEnd, start, (at) => { if (orphanFrom < 0) orphanFrom = at; });
      sinceYield += nl + 1 - pos;
      pos = nl + 1;
      if (sinceYield >= YIELD_EVERY_BYTES) {
        sinceYield = 0;
        await yieldToLoop();
      }
    }
    if (orphanFrom >= 0 && this.count > 0) this.fixOrphans();
    this.scanned = start + pos;
  }

  /** One line: a new record, or the next line of the last one. */
  private takeLine(buf: Buffer, from: number, to: number, base: number, orphan: (at: number) => void): void {
    const text = to > from ? buf.toString("utf8", from, Math.min(to, from + HEAD_BYTES)) : "";
    const head = text ? parseHead(this.format, text) : null;
    if (head) {
      const flags = this.format === "ppm" && head.tag === "supervisor" && text.includes(RESTART_TEXT) ? FLAG_RESTART : 0;
      this.ensureRoom();
      const i = this.cols.push(head.ts, head.lv, head.src, head.tag, sessionIdOf(text), flags);
      this.off[i] = base + from;
      this.len[i] = to - from;
      if (!this.gen) this.gen = Math.round(head.ts).toString(36);
      return;
    }
    if (this.format === "ppm" && text) {
      if (STDERR_START.test(text)) {
        const prev = this.count - 1;
        const ts = prev >= 0 ? this.cols.ts[prev]! : Number.NaN;
        this.ensureRoom();
        const i = this.cols.push(ts, STDERR_WARN.test(text) ? "warn" : "error", "server", STDERR_TAG, undefined);
        this.off[i] = base + from;
        this.len[i] = to - from;
        if (prev < 0) orphan(i);
        return;
      }
    }
    const last = this.count - 1;
    if (last >= 0) {
      this.len[last] = base + to - this.off[last]!;
      return;
    }
    // Text before the file's first record: kept as a record of its own so nothing is hidden.
    this.ensureRoom();
    const i = this.cols.push(Number.NaN, "info", "server", STDERR_TAG, undefined);
    this.off[i] = base + from;
    this.len[i] = to - from;
    orphan(i);
  }

  /** Records that came before any time was known take the time of the first record that has one. */
  private fixOrphans(): void {
    let known = Number.NaN;
    for (let i = 0; i < this.count; i++) {
      if (!Number.isNaN(this.cols.ts[i]!)) { known = this.cols.ts[i]!; break; }
    }
    if (Number.isNaN(known)) known = this.mtimeMs || Date.now();
    for (let i = 0; i < this.count && Number.isNaN(this.cols.ts[i]!); i++) this.cols.ts[i] = known;
    if (!this.gen) this.gen = Math.round(known).toString(36);
  }

  /**
   * The text of records `indices` (ascending), read with as few reads as the gaps allow. A
   * record whose bytes are gone (the file shrank under us) comes back as `null`.
   */
  readTexts(indices: readonly number[]): Array<string | null> {
    const out: Array<string | null> = new Array(indices.length).fill(null);
    if (indices.length === 0) return out;
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { return out; }
    try {
      const size = fstatSync(fd).size;
      let k = 0;
      while (k < indices.length) {
        // One read per run of records whose bytes lie within 64 KB of each other.
        const startIdx = indices[k]!;
        const spanStart = this.off[startIdx]!;
        let spanEnd = spanStart + this.len[startIdx]!;
        let m = k + 1;
        while (m < indices.length) {
          const o = this.off[indices[m]!]!;
          const e = o + this.len[indices[m]!]!;
          if (o - spanEnd > 64 * 1024 || e - spanStart > 8 * 1024 * 1024) break;
          spanEnd = e;
          m++;
        }
        if (spanEnd <= size) {
          const buf = Buffer.allocUnsafe(spanEnd - spanStart);
          let got = 0;
          while (got < buf.length) {
            const n = readSync(fd, buf, got, buf.length - got, spanStart + got);
            if (n <= 0) break;
            got += n;
          }
          for (let j = k; j < m; j++) {
            const i = indices[j]!;
            const a = this.off[i]! - spanStart;
            const b = a + this.len[i]!;
            if (b <= got) out[j] = buf.toString("utf8", a, b);
          }
        }
        k = m;
      }
    } finally {
      closeSync(fd);
    }
    return out;
  }

  /** A record as the browser gets it, from its text. */
  entryFromText(i: number, text: string): LogEntry {
    const nl = text.indexOf("\n");
    const firstLine = nl < 0 ? text : text.slice(0, nl);
    const head = parseHead(this.format, firstLine);
    let msg = head ? firstLine.slice(head.headChars) : firstLine;
    if (this.format === "cloudflared") msg = redactSecrets(msg);
    if (msg.length > MAX_MESSAGE_CHARS) msg = `${msg.slice(0, MAX_MESSAGE_CHARS)}…`;
    const entry: LogEntry = {
      id: this.idOf(i),
      ts: this.cols.ts[i]!,
      lv: this.cols.level(i),
      src: this.cols.source(i),
      tag: this.cols.tagName(i),
      msg,
    };
    if (nl >= 0) {
      let more = text.slice(nl + 1).split("\n");
      if (this.format === "cloudflared") more = more.map(redactSecrets);
      if (more.length > MAX_MORE_LINES) {
        const cut = more.length - MAX_MORE_LINES;
        more = [...more.slice(0, MAX_MORE_LINES), `… ${cut} more lines`];
      }
      entry.more = more.map((l) => (l.length > MAX_MESSAGE_CHARS ? `${l.slice(0, MAX_MESSAGE_CHARS)}…` : l));
    }
    const sid = this.cols.sessionId(i);
    if (sid) entry.sid = sid;
    return entry;
  }

  /** Records `indices` (ascending) as entries; a record that could not be read is left out. */
  readEntries(indices: readonly number[]): LogEntry[] {
    const texts = this.readTexts(indices);
    const out: LogEntry[] = [];
    texts.forEach((t, j) => { if (t !== null) out.push(this.entryFromText(indices[j]!, t)); });
    return out;
  }
}
