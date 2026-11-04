import { decodeReply } from "../../shared/chat-reply.ts";
import { mapRolloutItem } from "./codex-rollout-items.ts";
import { stripSharedContext } from "../../shared/provider-context.ts";

/**
 * Line primitives for a codex rollout JSONL, plus the header a session list
 * needs: which project the thread ran in, whether it is a thread of its own,
 * and what to call it.
 *
 * Kept apart from the transcript parser because listing reads every rollout in
 * the tree while parsing reads one — the listing path must be able to stop at
 * the first few records instead of walking a multi-megabyte transcript.
 */

export interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/** Split into complete, newline-terminated lines only (drop a trailing partial). */
export function completeLines(text: string): string[] {
  const lines = text.split("\n");
  // If the text does not end in a newline, the last element is a partial line.
  if (!text.endsWith("\n")) lines.pop();
  return lines.filter((l) => l.trim() !== "");
}

export function parseLine(line: string): RolloutLine | null {
  try { return JSON.parse(line) as RolloutLine; } catch { return null; }
}

export interface RolloutHeader {
  id?: string;
  cwd?: string;
  timestamp?: string;
  /**
   * The thread that spawned this one. Present ONLY on a subagent's own rollout,
   * which codex writes into the same sessions tree as a real conversation — so
   * this is what separates "a session the user started" from "one step inside
   * one".
   */
  parentThreadId?: string;
  /** First user prompt, trimmed to a session-list label. */
  title?: string;
}

/** How far into a rollout to look for the opening prompt before giving up. */
const TITLE_SCAN_LINES = 2000;
const TITLE_MAX_CHARS = 80;

/** First user prompt → a one-line label. */
function toTitle(text: string): string | undefined {
  const flat = decodeReply(stripSharedContext(text)).content.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > TITLE_MAX_CHARS ? `${flat.slice(0, TITLE_MAX_CHARS - 1)}…` : flat;
}

/**
 * Read the `session_meta` header, and (when `withTitle`) the first user prompt.
 *
 * A subagent rollout has no user prompt at all — its task arrives as encrypted
 * scaffolding — so the title scan is skipped for one rather than walking the
 * whole file to find nothing.
 */
export function readRolloutHeader(text: string, opts?: { withTitle?: boolean }): RolloutHeader | null {
  let header: RolloutHeader | null = null;
  let scanned = 0;

  for (const line of completeLines(text)) {
    const rec = parseLine(line);
    if (!rec) continue;
    const p = rec.payload ?? {};

    if (rec.type === "session_meta" && !header) {
      header = {
        id: typeof p.id === "string" ? p.id : undefined,
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        timestamp: typeof p.timestamp === "string" ? p.timestamp : rec.timestamp,
        parentThreadId: typeof p.parent_thread_id === "string" ? p.parent_thread_id : undefined,
      };
      if (!opts?.withTitle || header.parentThreadId) return header;
      continue;
    }

    if (!header || rec.type !== "event_msg") continue;
    if (++scanned > TITLE_SCAN_LINES) break;

    if (p.type === "user_message" && typeof p.message === "string") {
      header.title = toTitle(p.message);
      if (header.title) return header;
    } else if (p.type === "item_completed") {
      const mapped = mapRolloutItem(p.item);
      if (mapped.kind === "user") {
        header.title = toTitle(mapped.text);
        if (header.title) return header;
      }
    }
  }
  return header;
}

/** First read of a rollout's head: `session_meta` carries the base instructions, measured at 22–27 KB. */
const HEADER_FIRST_READ_BYTES = 32 * 1024;

/** One positional read the header scan asks for; the caller answers with the bytes it got. */
export interface HeaderRead {
  buffer: Buffer;
  offset: number;
  length: number;
  position: number;
}

/**
 * The reads it takes to answer `readRolloutHeader` for a file of `size` bytes, as a plan any
 * reader can drive — synchronously for a single lookup, asynchronously for the session list,
 * which reads thousands of rollouts and must never hold the event loop while the disk answers.
 *
 * The head is read in growing slices, and a slice's unterminated last line — possibly a split
 * multi-byte character — is dropped by `completeLines`, so a partial read never parses a
 * partial record.
 */
export function* rolloutHeaderReads(
  size: number,
  opts?: { withTitle?: boolean },
): Generator<HeaderRead, RolloutHeader | null, number> {
  let buffer = Buffer.alloc(Math.min(size, HEADER_FIRST_READ_BYTES));
  let filled = 0;
  while (true) {
    const read = yield { buffer, offset: filled, length: buffer.length - filled, position: filled };
    filled += read;
    // A file that shrank under us reads short; stop rather than wait for bytes that are gone.
    const eof = filled >= size || read === 0;
    const header = readRolloutHeader(buffer.toString("utf-8", 0, filled), opts);
    const complete = header && (!opts?.withTitle || header.title || header.parentThreadId);
    if (complete || eof) return header;
    const grown = Buffer.alloc(Math.min(size, buffer.length * 4));
    buffer.copy(grown, 0, 0, filled);
    buffer = grown;
  }
}
