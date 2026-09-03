/**
 * "What is this agent doing right now" from a transcript, without reading it all.
 *
 * A single teammate transcript reaches 6 MB, and a team has ~25 of them. The
 * members list is polled while the panel is open, so a full parse per poll would
 * read tens of MB every few seconds. Only the head (for the start time) and a
 * bounded tail (for the latest activity) are read here; the full transcript is
 * parsed lazily, and only for the one member whose window is open.
 */

import { open, stat } from "node:fs/promises";

/** Tail budget. Big enough to hold several records, small enough to stay cheap. */
const TAIL_BYTES = 256 * 1024;
/** Head budget — the first record carries the earliest timestamp. */
const HEAD_BYTES = 64 * 1024;

export interface TranscriptTailSummary {
  /** ISO timestamp of the transcript's first record. */
  startedAt?: string;
  /** ISO timestamp of the most recent record. */
  lastEventAt?: string;
  /** Most recent tool the agent invoked, e.g. `PowerShell`. */
  lastTool?: string;
  /** Compact argument of that tool call — command, path or pattern. */
  lastToolArg?: string;
  /** Most recent prose the agent wrote about what it is doing. */
  lastNarrative?: string;
}

/** Read a byte range as utf-8, tolerating a short or missing file. */
async function readRange(path: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Parse whole JSONL lines out of a possibly-truncated chunk. */
function parseRecords(chunk: string, dropFirstPartial: boolean): Record<string, unknown>[] {
  const lines = chunk.split("\n");
  // A mid-file read almost always starts inside a record — that fragment is not JSON.
  if (dropFirstPartial) lines.shift();
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* truncated tail record or mid-write line */
    }
  }
  return out;
}

/** The most informative single argument of a tool call, for a one-line preview. */
function toolArg(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "description", "prompt", "url"]) {
    const v = i[key];
    if (typeof v === "string" && v.trim()) {
      // Multi-line commands are common; the first line identifies the action.
      return v.trim().split("\n")[0]!.slice(0, 160);
    }
  }
  return undefined;
}

/** Pull the latest tool call and prose out of records in stream order. */
function summarizeRecords(records: Record<string, unknown>[], into: TranscriptTailSummary): void {
  for (const rec of records) {
    const ts = rec.timestamp;
    if (typeof ts === "string") into.lastEventAt = ts;
    const content = (rec.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        into.lastTool = block.name;
        into.lastToolArg = toolArg(block.input);
      } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        into.lastNarrative = block.text.trim().split("\n")[0]!.slice(0, 200);
      }
    }
  }
}

/** Latest activity in a transcript, reading only its head and tail. */
export async function summarizeTranscriptTail(path: string): Promise<TranscriptTailSummary> {
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return {};
  }
  const summary: TranscriptTailSummary = {};

  const head = parseRecords(await readRange(path, 0, Math.min(HEAD_BYTES, size)), false);
  const firstTs = head.find((r) => typeof r.timestamp === "string")?.timestamp;
  if (typeof firstTs === "string") summary.startedAt = firstTs;

  // When the file fits in one read, head already holds everything.
  if (size <= HEAD_BYTES) {
    summarizeRecords(head, summary);
    return summary;
  }

  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = parseRecords(await readRange(path, tailStart, size - tailStart), tailStart > 0);
  summarizeRecords(tail, summary);
  return summary;
}
