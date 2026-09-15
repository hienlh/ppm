import { mapRolloutItem } from "./codex-rollout-items.ts";

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
  const flat = text.replace(/\s+/g, " ").trim();
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
