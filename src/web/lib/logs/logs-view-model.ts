/**
 * The Logs window's pure half: how a filter becomes a query string, how a record's message is
 * cut into the pieces a row draws, how repeats fold into one row, and the small text rules
 * (times, counts) every pane shares. No stores and no DOM, so all of it runs under `bun:test`.
 */
import {
  sameLogRecord,
  type LogEntry,
  type LogFilter,
  type LogRange,
} from "../../../shared/logs-model";
import type { LogQueryParams } from "../../../shared/logs-api";

/** `/api/logs`'s query string; `parseLogQuery` on the server reads it back. */
export function logsQueryString(p: LogQueryParams): string {
  const q = new URLSearchParams();
  q.set("src", p.src);
  q.set("lv", (Object.keys(p.levels) as Array<keyof LogFilter["levels"]>).filter((k) => p.levels[k]).join(","));
  if (p.tagsOff.length) q.set("off", p.tagsOff.join(","));
  if (p.q) q.set("q", p.q);
  if (p.regex) q.set("re", "1");
  if (p.caseSensitive) q.set("cs", "1");
  if (p.chat) q.set("chat", p.chat);
  q.set("range", p.range);
  q.set("from", String(p.from));
  if (p.before) q.set("before", p.before);
  if (p.reach) q.set("reach", p.reach);
  q.set("limit", String(p.limit));
  return q.toString();
}

/**
 * Where a range starts, in epoch ms. The browser works this out because "today" is the
 * viewer's midnight, not the server's; the server finds the restart itself, and "everything
 * kept" starts at 0.
 */
export function rangeStart(range: LogRange, now: number): number {
  if (range === "15m") return now - 15 * 60_000;
  if (range === "1h") return now - 60 * 60_000;
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return 0;
}

/** The narrowest range that still holds a record from `oldest`, for "Show in Logs". */
export function rangeCovering(oldest: number, now: number): LogRange {
  if (oldest >= rangeStart("1h", now)) return "1h";
  if (oldest >= rangeStart("today", now)) return "today";
  return "all";
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `01:35:55.748`, in local time or UTC. */
export function clockTime(ts: number, utc: boolean): string {
  const d = new Date(ts);
  return utc
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** `UTC+7`, `UTC-3:30`, or `UTC` for an offset of zero. */
export function utcOffsetLabel(offsetMinutesEast: number): string {
  if (offsetMinutesEast === 0) return "UTC";
  const a = Math.abs(offsetMinutesEast);
  return `UTC${offsetMinutesEast > 0 ? "+" : "-"}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ""}`;
}

/** The local offset now, as `utcOffsetLabel` writes it. */
export function localOffsetLabel(): string {
  return utcOffsetLabel(-new Date().getTimezoneOffset());
}

/** `01:35:55 – 01:36:02`, or one time when the span is inside a second. */
export function timeSpan(first: number, last: number, utc: boolean): string {
  const a = clockTime(first, utc).slice(0, 8);
  const b = clockTime(last, utc).slice(0, 8);
  return a === b ? a : `${a} – ${b}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** `73.5k` past ten thousand, the number itself below. */
export function shortCount(n: number): string {
  return n >= 10_000 ? `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString("en-US");
}

/** `3.6 MB`, `212 KB`. */
export function byteSize(n: number): string {
  if (n >= 1024 * 1024) return `${+(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** One row of the list: a record, or a run of identical ones folded under the first. */
export interface LogRow {
  /** The first record's id, which is what selection and React keys use. */
  key: string;
  entry: LogEntry;
  count: number;
  ids: string[];
  /** The last copy's time. */
  lastTs: number;
}

/** Folds back-to-back copies of a record into one row with a count. */
export function foldRepeats(entries: readonly LogEntry[]): LogRow[] {
  const rows: LogRow[] = [];
  for (const e of entries) {
    const prev = rows[rows.length - 1];
    if (prev && sameLogRecord(prev.entry, e)) {
      prev.count++;
      prev.ids.push(e.id);
      prev.lastTs = e.ts;
      continue;
    }
    rows.push({ key: e.id, entry: e, count: 1, ids: [e.id], lastTs: e.ts });
  }
  return rows;
}

/**
 * For each restart, the key of the row a "PPM restarted" divider goes above: the first row at
 * or after it, when some row is before it — a divider at the very top would separate nothing.
 */
export function restartDividers(rows: readonly LogRow[], restarts: readonly number[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const at of restarts) {
    const i = rows.findIndex((r) => r.entry.ts >= at);
    if (i > 0) out.set(rows[i]!.key, at);
  }
  return out;
}

export type MessagePiece =
  | { kind: "text"; text: string }
  | { kind: "chat"; sid: string }
  | { kind: "quote"; text: string }
  | { kind: "key"; text: string };

const TOKEN = /session=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|("(?:[^"\\]|\\.)*")|\b([A-Za-z_][\w.]*=)/g;

/**
 * A message cut into what a row draws differently: `session=<id>` becomes that chat's name (a
 * chip that filters to it), `key=` and quoted values are toned down, the rest is plain.
 */
export function messagePieces(msg: string): MessagePiece[] {
  const out: MessagePiece[] = [];
  let last = 0;
  for (const m of msg.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: msg.slice(last, at) });
    if (m[1]) out.push({ kind: "chat", sid: m[1] });
    else if (m[2]) out.push({ kind: "quote", text: m[2] });
    else out.push({ kind: "key", text: m[3]! });
    last = at + m[0].length;
  }
  if (last < msg.length) out.push({ kind: "text", text: msg.slice(last) });
  return out;
}

/** The search as a global RegExp for marking hits, or null. */
export function hitPattern(search: RegExp | null | undefined): RegExp | null {
  if (!search) return null;
  return new RegExp(search.source, search.flags.includes("g") ? search.flags : `${search.flags}g`);
}

/** `text` cut at every hit of `re`, for `<mark>`ing them. An empty match is skipped, not looped on. */
export function splitHits(text: string, re: RegExp | null): Array<{ text: string; hit: boolean }> {
  if (!re) return [{ text, hit: false }];
  const out: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

/** The keys from `a` to `b` inclusive, in list order, whichever comes first. */
export function keySpan(keys: readonly string[], a: string, b: string): string[] {
  let i = keys.indexOf(a);
  let j = keys.indexOf(b);
  if (i < 0) i = j;
  if (j < 0) j = i;
  if (i < 0) return [];
  if (i > j) [i, j] = [j, i];
  return keys.slice(i, j + 1);
}
