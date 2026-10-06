/**
 * One compaction segment of a Claude transcript, read without parsing the rest.
 *
 * Scrolling to the top of a chat asks for the segment that ends at the compact
 * summary heading the view — the stretch between that summary and the one
 * before it. `parseJsonlTranscript` finds it by parsing every record from the
 * start of the file and throwing away each segment it passes, so the cost of
 * one scroll was the size of the whole transcript. A session that had run for
 * five days reached 543MB and 141 compactions, where the newest segment is
 * 3.5MB: the route refused the file outright at its 256MB bound, and without
 * the bound that one segment cost 1.5s of `JSON.parse` over 100,611 records.
 *
 * Here the file is scanned as bytes for the two markers that decide where the
 * segment is, and only that range is parsed. A marker found as bytes is still
 * confirmed by parsing its record, so a tool output that happens to quote one
 * cannot move the window.
 */

import { statSync } from "node:fs";
import type { ChatMessage } from "../types/chat.ts";
import { parseJsonlTranscript } from "./jsonl-transcript-parser.ts";

/**
 * How many bytes one expand may parse.
 *
 * The bound is on what is parsed, not on the file it comes from, which is only
 * scanned as bytes up to the segment's end. It is the same
 * sanity bound `validateJsonlPath` used to put on the file, and measured against
 * the session above it is far out of reach: its largest segment is 14.9MB and
 * the median 2.8MB.
 */
export const MAX_SEGMENT_BYTES = 256 * 1024 * 1024; // 256MB

const NEWLINE = 0x0a;
const SUMMARY_MARKER = Buffer.from('"isCompactSummary":true');

/** A byte range of a transcript; `toByte` absent means the end of the file. */
export interface SegmentWindow {
  fromByte: number;
  toByte?: number;
}

/**
 * Where to read the segment that ends at `beforeUuid`.
 *
 * `toByte` is the start of the record whose uuid is `beforeUuid`, or absent when
 * no record has it — the parse then runs to the end of the file, as it always
 * did. `fromByte` is the start of the *second*-to-last compact summary before
 * that point, not the last: the `compact_boundary` record that carries the
 * figures for the segment's own summary is written a few records ahead of it
 * (four in current Claude Code), and `readCompactions` has to see it. The extra
 * segment this pulls in is dropped by `oneSegment`, exactly as every earlier one
 * was when the whole file was parsed.
 */
export async function compactSegmentWindow(filePath: string, beforeUuid?: string): Promise<SegmentWindow> {
  const beforeMarker = beforeUuid ? Buffer.from(`"uuid":${JSON.stringify(beforeUuid)}`) : null;
  let lastSummary: number | undefined;
  let previousSummary: number | undefined;

  /** Scan whole lines starting at file offset `at`; the `beforeUuid` record's offset if it is here. */
  const scan = (lines: Buffer, at: number): number | undefined => {
    let stop: number | undefined;
    if (beforeMarker) {
      for (let i = lines.indexOf(beforeMarker); i !== -1; i = lines.indexOf(beforeMarker, i + 1)) {
        const [start, end] = lineAround(lines, i);
        if (parseRecord(lines, start, end)?.uuid === beforeUuid) {
          stop = start;
          break;
        }
        i = end;
      }
    }
    // The `beforeUuid` record is usually a summary itself, and it must not count:
    // the full parse stops on it before looking at what it is.
    for (let i = lines.indexOf(SUMMARY_MARKER); i !== -1; i = lines.indexOf(SUMMARY_MARKER, i + 1)) {
      const [start, end] = lineAround(lines, i);
      if (stop !== undefined && start >= stop) break;
      if (parseRecord(lines, start, end)?.isCompactSummary === true) {
        previousSummary = lastSummary;
        lastSummary = at + start;
      }
      i = end;
    }
    return stop === undefined ? undefined : at + stop;
  };

  const window = (toByte?: number): SegmentWindow => ({ fromByte: previousSummary ?? 0, toByte });

  // The line still being read, kept in pieces: concatenating it on every chunk
  // instead would copy a long record once per chunk it spans.
  const pending: Uint8Array[] = [];
  let at = 0; // file offset of the first pending byte
  const reader = Bun.file(filePath).stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lastNewline = value.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        pending.push(value);
        continue;
      }
      const lines = Buffer.concat([...pending, value.subarray(0, lastNewline + 1)]);
      const stop = scan(lines, at);
      if (stop !== undefined) return window(stop);
      at += lines.length;
      pending.length = 0;
      pending.push(value.subarray(lastNewline + 1));
    }
  } finally {
    // Not only `releaseLock`: a stream let go of before its end keeps the file open.
    await reader.cancel().catch(() => {});
  }
  // A last line with no newline yet is still a record the full parse would read.
  const stop = scan(Buffer.concat(pending), at);
  return window(stop);
}

/**
 * The messages of the compaction segment that ends at `beforeUuid` — what one
 * scroll to the top of a chat loads. Same answer as
 * `parseJsonlTranscript(filePath, beforeUuid, { oneSegment: true })`, at the
 * cost of one segment rather than of the file.
 *
 * `maxBytes` is a parameter only so a test can assert the bound with a small
 * fixture.
 */
export async function parseCompactSegment(
  filePath: string,
  beforeUuid?: string,
  maxBytes = MAX_SEGMENT_BYTES,
): Promise<ChatMessage[]> {
  const window = await compactSegmentWindow(filePath, beforeUuid);
  const bytes = (window.toByte ?? statSync(filePath).size) - window.fromByte;
  if (bytes > maxBytes) {
    throw new Error(
      `Segment too large: ${Math.round(bytes / 1024 / 1024)}MB exceeds ` +
      `${Math.round(maxBytes / 1024 / 1024)}MB limit`,
    );
  }
  return parseJsonlTranscript(filePath, beforeUuid, { oneSegment: true, ...window });
}

/** Start and end (exclusive, before the newline) of the line holding byte `i`. */
function lineAround(lines: Buffer, i: number): [number, number] {
  const end = lines.indexOf(NEWLINE, i);
  return [lines.lastIndexOf(NEWLINE, i) + 1, end === -1 ? lines.length : end];
}

function parseRecord(lines: Buffer, start: number, end: number): Record<string, unknown> | null {
  try {
    return JSON.parse(lines.subarray(start, end).toString());
  } catch {
    return null;
  }
}
