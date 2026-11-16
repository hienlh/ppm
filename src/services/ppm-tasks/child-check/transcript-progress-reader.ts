/**
 * What a handed-off chat wrote since the last check: the bytes appended to its transcript after the
 * stored offset (one positioned read, at most 256 KB, keeping the tail when more was written), turned
 * into text lines — assistant text, each tool call's name and the first line of its input, and the
 * first 20 lines of each tool result — and judged against the forms seen recently. The file is only
 * read; never through `Bun.file().stream()` (it keeps native memory per read).
 *
 * Only `user`/`assistant` records (Claude) and response items and agent messages (Codex) carry
 * content; bookkeeping records (titles, API request logs, token counts) are skipped, or every turn
 * would look like progress. A content block of a kind this reader does not know counts as progress:
 * a format change must fail towards "running", never towards a false alarm.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { normalizeLine, splitLines } from "./transcript-line-normalizer.ts";

export const MAX_READ_BYTES = 256 * 1024;
export const RECENT_FORMS = 64;
const RESULT_LINES = 20;
const TEXT_LINES = 40;

export interface TranscriptLine {
  text: string;
  at: number | null;
  /**
   * The child AI's own words or tool call, which may be quoted to the manager. Tool output is not:
   * it carries whatever the child read (web pages, files), text nobody vetted.
   */
  quotable: boolean;
}

/** One record's lines before they are stamped with its time. */
export interface RecordLines { lines: Array<{ text: string; quotable: boolean }>; unknown: boolean }

const own = (texts: string[]) => texts.map((text) => ({ text, quotable: true }));
const output = (texts: string[]) => texts.map((text) => ({ text, quotable: false }));
const NONE: RecordLines = { lines: [], unknown: false };

export interface AppendedRead {
  lines: TranscriptLine[];
  /** Where the next read starts: after the last complete line read. */
  offset: number;
  /** Content of a kind the reader does not recognise was seen (counts as progress). */
  unknown: boolean;
  /** The file's modification time: the chat's last write. */
  mtimeMs: number;
}

const firstLines = (text: string, n: number): string[] => splitLines(text).slice(0, n);

function timeOf(rec: Record<string, unknown>): number | null {
  const t = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

function inputLine(input: unknown): string {
  if (input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string") {
    return (input as { command: string }).command;
  }
  return typeof input === "string" ? input : JSON.stringify(input ?? null);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n");
}

const KNOWN_QUIET_BLOCKS = new Set(["thinking", "redacted_thinking", "image", "document", "server_tool_use", "web_search_tool_result"]);

/** Text lines of one Claude record; `unknown` when a content block is of an unknown kind. */
export function claudeRecordLines(rec: Record<string, unknown>): RecordLines {
  if (rec.type !== "user" && rec.type !== "assistant") return NONE;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return { lines: rec.type === "assistant" ? own(firstLines(content, TEXT_LINES)) : [], unknown: false };
  if (!Array.isArray(content)) return NONE;
  const lines: RecordLines["lines"] = [];
  let unknown = false;
  for (const raw of content) {
    const b = (raw ?? {}) as Record<string, unknown>;
    if (b.type === "text") {
      // The user's own words (and PPM's messages to the chat) are not the child's progress.
      if (rec.type === "assistant" && typeof b.text === "string") lines.push(...own(firstLines(b.text, TEXT_LINES)));
    } else if (b.type === "tool_use") {
      lines.push(...own([`${String(b.name ?? "tool")} ${firstLines(inputLine(b.input), 1)[0] ?? ""}`]));
    } else if (b.type === "tool_result") {
      lines.push(...output(firstLines(resultText(b.content), RESULT_LINES)));
    } else if (!KNOWN_QUIET_BLOCKS.has(String(b.type))) {
      unknown = true;
    }
  }
  return { lines, unknown };
}

/** Text lines of one Codex rollout record. */
export function codexRecordLines(rec: Record<string, unknown>): RecordLines {
  const p = (rec.payload ?? {}) as Record<string, unknown>;
  if (rec.type === "event_msg") {
    return p.type === "agent_message" && typeof p.message === "string" ? { lines: own(firstLines(p.message, TEXT_LINES)), unknown: false } : NONE;
  }
  if (rec.type !== "response_item") return NONE;
  switch (p.type) {
    case "message":
      if (p.role !== "assistant") return NONE;
      return { lines: own(firstLines(resultText(p.content), TEXT_LINES)), unknown: false };
    case "function_call":
    case "custom_tool_call":
      return { lines: own([`${String(p.name ?? "tool")} ${firstLines(String(p.arguments ?? p.input ?? ""), 1)[0] ?? ""}`]), unknown: false };
    case "function_call_output":
    case "custom_tool_call_output": {
      const out = p.output;
      const text = typeof out === "string" ? out : typeof (out as { content?: unknown })?.content === "string" ? (out as { content: string }).content : JSON.stringify(out ?? "");
      return { lines: output(firstLines(text, RESULT_LINES)), unknown: false };
    }
    case "reasoning":
      return NONE;
    default:
      return { lines: [], unknown: true };
  }
}

/**
 * Reads what was appended to `path` after `offset`, records stamped before `since` left out (the
 * first read of a hand-off may start inside older history). A file shorter than `offset` was
 * replaced and is read from its start. Null when the file cannot be opened.
 */
export function readAppended(path: string, offset: number, providerId: string, since: number): AppendedRead | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const { size, mtimeMs } = fstatSync(fd);
    let from = offset > size ? 0 : offset;
    let skipFirst = false;
    if (size - from > MAX_READ_BYTES) {
      from = size - MAX_READ_BYTES;
      skipFirst = true; // the window starts mid-record
    }
    const length = size - from;
    if (length <= 0) return { lines: [], offset: from, unknown: false, mtimeMs };
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    const lastNewline = buf.lastIndexOf(10, got - 1);
    if (lastNewline < 0) return { lines: [], offset: from, unknown: false, mtimeMs };
    let text = buf.toString("utf8", 0, lastNewline);
    if (skipFirst) text = text.slice(text.indexOf("\n") + 1);
    const lines: TranscriptLine[] = [];
    let unknown = false;
    const extract = providerId === "codex" ? codexRecordLines : claudeRecordLines;
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      const at = timeOf(rec);
      if (at !== null && at < since) continue;
      const got = extract(rec);
      unknown ||= got.unknown;
      for (const l of got.lines) lines.push({ text: l.text, at, quotable: l.quotable });
    }
    return { lines, offset: from + lastNewline + 1, unknown, mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** Forms seen recently, with when each was last seen; stored as JSON pairs. */
export type RecentForms = Array<[form: string, seenAt: number]>;

export function parseRecentForms(json: string | null): RecentForms {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number") : [];
  } catch {
    return [];
  }
}

/**
 * Judges new lines against the recent forms: progress is a line whose form was not seen within
 * `expireMs` before the line itself (its own time, else `now`), so when a check happens to run
 * does not change the answer. Returns when the latest progress happened and the forms to keep
 * (the 64 seen most recently, none older than `expireMs`).
 */
export function judgeProgress(lines: readonly TranscriptLine[], recent: RecentForms, now: number, expireMs: number): { progressAt: number | null; recent: RecentForms } {
  const seen = new Map(recent);
  let progressAt: number | null = null;
  for (const line of lines) {
    const form = normalizeLine(line.text);
    if (!form) continue;
    const at = line.at ?? now;
    const before = seen.get(form);
    if (before === undefined || at - before >= expireMs) progressAt = Math.max(progressAt ?? 0, at);
    seen.set(form, Math.max(at, before ?? 0));
  }
  const kept = [...seen.entries()].filter(([, at]) => now - at < expireMs).sort((a, b) => a[1] - b[1]).slice(-RECENT_FORMS);
  return { progressAt, recent: kept };
}
