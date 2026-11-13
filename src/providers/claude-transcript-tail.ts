/**
 * A Claude session's messages without reading the whole transcript.
 *
 * The SDK's `getSessionMessages` builds the conversation by walking `parentUuid` back from the
 * newest message, and that walk ends at the newest `compact_boundary` (its `parentUuid` is
 * null). So the answer is the last segment, but the SDK reads the file *forward* from its
 * first byte to get there. Past 5 MB it can skip what precedes a boundary — unless the
 * boundary preserves messages from before it (`preservedSegment` / `preservedMessages`),
 * which every auto-compaction of current Claude Code does. Then nothing is skipped.
 *
 * One week-long session reached 1.77 GB and 217 compactions, all of them preserving: each
 * open of the chat read 1.77 GB (8.5 s, RSS +5.7 GB) to return 31 messages, and since the
 * session kept writing, the history cache never held — up to 45 s per open, past the
 * browser's 30 s timeout, which left the chat looking empty until Reload messages.
 *
 * Here the file is read *backward* from its end to the newest boundary, and on past it until
 * every record that boundary preserves has been seen. The bytes from there to the end are
 * handed to the SDK as a `sessionStore`, whose path runs the same code over the records as its
 * file path (chain building, compaction relinking, filtering), so the answer is the SDK's own.
 * For that session the read is 0.9 MB.
 */

import { open, stat } from "node:fs/promises";
import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";

/** Below this the SDK's own read is cheap enough to leave alone (its pre-compact skip threshold). */
export const TAIL_READ_MIN_BYTES = 5 * 1024 * 1024;

const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const BOUNDARY_MARKER = Buffer.from('"compact_boundary"');
/**
 * The SDK only treats a line as a boundary when the marker starts this close to its start.
 * Every candidate is confirmed by parsing anyway; this keeps a multi-MB tool output that
 * mentions the marker from being parsed for nothing.
 */
const MARKER_WINDOW = 256;

/**
 * File offset from which the SDK's answer can be built: the start of the newest
 * `compact_boundary` line, or of the earliest record it preserves if that is further back.
 * 0 when there is no boundary, or a preserved record cannot be found — the whole file, as
 * the SDK reads it.
 *
 * A boundary met on the way back to a preserved record is in the range too, so what it
 * preserves is searched for as well: every relink the SDK makes inside the range then has
 * its records.
 */
export async function segmentReadStart(filePath: string, size: number): Promise<number> {
  const file = await open(filePath, "r");
  try {
    /** Records still to find, by uuid, and the byte pattern a record's own uuid has. */
    const needed = new Map<string, Buffer>();
    let boundarySeen = false;
    // The head of a line cut by the previous chunk's start, read again with the next chunk.
    let carry: Buffer = Buffer.alloc(0);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const chunk = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, start);
      const buf = carry.length ? Buffer.concat([chunk.subarray(0, bytesRead), carry]) : chunk.subarray(0, bytesRead);
      end = start;
      // Lines that start after the first newline are whole; the one before it may begin
      // in an earlier chunk, unless this chunk is the start of the file.
      const firstNewline = start === 0 ? -1 : buf.indexOf(NEWLINE);
      if (start > 0 && firstNewline === -1) {
        carry = buf;
        continue;
      }
      // Walk the candidate lines of this chunk newest first; `pos` is where the unvisited part ends.
      let pos = buf.length;
      // Each pattern's last hit below `pos`, searched again only once the walk has passed it: a
      // boundary can preserve 45 records, and searching every pattern again at every candidate
      // line took 227 ms for a 1.5 MB range (about 2,000 searches) where this takes a few.
      const hits = new Map<Buffer, number>();
      const hitBelow = (pattern: Buffer): number => {
        let hit = hits.get(pattern);
        if (hit === undefined || hit >= pos) {
          hit = pos > 0 ? buf.lastIndexOf(pattern, pos - 1) : -1;
          hits.set(pattern, hit);
        }
        return hit;
      };
      for (;;) {
        let at = hitBelow(BOUNDARY_MARKER);
        for (const pattern of needed.values()) at = Math.max(at, hitBelow(pattern));
        if (at <= firstNewline) break;
        const lineStart = buf.lastIndexOf(NEWLINE, at) + 1;
        const lineEnd = buf.indexOf(NEWLINE, at);
        pos = lineStart;
        const first = buf.indexOf(BOUNDARY_MARKER, lineStart);
        // The SDK tests the line's first occurrence of the marker, not its last.
        const maybeBoundary = first !== -1 && first - lineStart < MARKER_WINDOW && (lineEnd === -1 || first < lineEnd);
        const entry = parseLine(buf, lineStart, lineEnd === -1 ? buf.length : lineEnd);
        if (!entry) continue;
        if (typeof entry.uuid === "string") needed.delete(entry.uuid);
        if (maybeBoundary && entry.type === "system" && entry.subtype === "compact_boundary") {
          boundarySeen = true;
          for (const uuid of preservedUuids(entry)) needed.set(uuid, Buffer.from(`"uuid":${JSON.stringify(uuid)}`));
        }
        if (boundarySeen && needed.size === 0) return start + lineStart;
      }
      carry = start === 0 ? Buffer.alloc(0) : buf.subarray(0, firstNewline + 1);
    }
    return 0;
  } finally {
    await file.close();
  }
}

/**
 * The records a boundary needs for the SDK's relink, as it decides: `preservedMessages` when
 * present (relinked only if every one is there), otherwise the head of `preservedSegment`
 * (whose records up to the boundary are in the range by then).
 */
function preservedUuids(entry: Record<string, any>): string[] {
  const meta = entry.compactMetadata;
  const messages = meta?.preservedMessages;
  if (messages) return Array.isArray(messages.uuids) ? messages.uuids.filter((u: unknown) => typeof u === "string") : [];
  const head = meta?.preservedSegment?.headUuid;
  return typeof head === "string" ? [head] : [];
}

function parseLine(buf: Buffer, from: number, to: number): Record<string, any> | null {
  try {
    const entry = JSON.parse(buf.toString("utf-8", from, to));
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

/** Every record from `fromByte` to `size`; a line still being written does not parse and is skipped, as the SDK does. */
async function readEntries(filePath: string, fromByte: number, size: number): Promise<unknown[]> {
  const file = await open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(size - fromByte);
    const { bytesRead } = await file.read(buf, 0, buf.length, fromByte);
    const entries: unknown[] = [];
    let pos = 0;
    while (pos < bytesRead) {
      let lineEnd = buf.indexOf(NEWLINE, pos);
      if (lineEnd === -1 || lineEnd > bytesRead) lineEnd = bytesRead;
      const entry = lineEnd > pos ? parseLine(buf, pos, lineEnd) : null;
      if (entry) entries.push(entry);
      pos = lineEnd + 1;
    }
    return entries;
  } finally {
    await file.close();
  }
}

export interface SessionMessagesRead {
  messages: SessionMessage[];
  /** Where the range read starts in the transcript, for readers that window the same file. */
  fromByte: number;
}

/**
 * `getSessionMessages(sessionId)`, reading only the end of the transcript it needs.
 *
 * `transcriptPath` is the session's `.jsonl` as PPM resolves it. Without one, for a small file,
 * or when no boundary bounds the read, the SDK is asked exactly as before.
 */
export async function readSessionMessages(sessionId: string, transcriptPath: string | null | undefined): Promise<SessionMessagesRead> {
  const size = transcriptPath ? await stat(transcriptPath).then((s) => s.size, () => 0) : 0;
  const fromByte = transcriptPath && size > TAIL_READ_MIN_BYTES ? await segmentReadStart(transcriptPath, size) : 0;
  if (!transcriptPath || fromByte === 0) {
    return { messages: await getSessionMessages(sessionId), fromByte: 0 };
  }
  const entries = await readEntries(transcriptPath, fromByte, size);
  const messages = await getSessionMessages(sessionId, {
    sessionStore: {
      load: async () => entries as never,
      append: async () => {},
    },
  });
  return { messages, fromByte };
}
