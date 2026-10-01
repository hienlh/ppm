/**
 * Pure event-buffer reducer for the agent session stream hook.
 *
 * Split out from the hook itself so the ordering/de-dupe/replace/reset/cap rules are
 * testable under `bun:test` with no WebSocket, no React and no store to mount. Two pushes
 * for the same subscription are not guaranteed to arrive in `ts` order (a live tick can
 * land while a catch-up backlog is still draining), and a Codex `replace` updates a step
 * already shown in place rather than appending a new one.
 */
import type { AgentTranscriptEventsMsg } from "../../shared/agent-transcript-protocol";
import type { ChatEvent } from "../../types/chat";

/** One accumulated step, kept alongside its de-dupe key and timestamp for re-ordering. */
export interface StreamEntry {
  k: string;
  ts: number;
  ev: ChatEvent;
}

/** Mirrors the hub's own per-subscription cap so a long session stays renderable. */
export const MAX_STREAM_ENTRIES = 2000;

/**
 * Apply one `agent-transcript:events` page to the entries accumulated so far.
 *
 * `reset` discards everything first — a truncated/rotated file or a Codex compaction means
 * the server is telling us history itself changed, not just that more of it arrived.
 * Otherwise: a `k` already held is either a `replace` (update in place) or a plain duplicate
 * from an overlapping catch-up/live-tick window (skipped); a new `k` is inserted at the
 * position its `ts` sorts into rather than appended blindly.
 */
export function applyEnvelopeBatch(
  current: StreamEntry[],
  batch: AgentTranscriptEventsMsg,
): StreamEntry[] {
  const next = batch.reset ? [] : current.slice();
  for (const { ev, ts, k, replace } of batch.events) {
    const existingIndex = next.findIndex((e) => e.k === k);
    if (existingIndex !== -1) {
      if (replace) next[existingIndex] = { k, ts, ev };
      continue;
    }
    let insertAt = next.length;
    while (insertAt > 0 && next[insertAt - 1]!.ts > ts) insertAt--;
    next.splice(insertAt, 0, { k, ts, ev });
  }
  return next.length > MAX_STREAM_ENTRIES ? next.slice(next.length - MAX_STREAM_ENTRIES) : next;
}
