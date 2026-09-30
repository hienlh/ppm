/**
 * The read-and-push half of a transcript subscription: one tick's worth of
 * "what's new across every file this subscription watches, including any
 * file the set itself grew by" turned into paged WS pushes with an exact
 * per-page cursor. Split out from `agent-transcript-session-hub.ts` (the
 * subscribe/unsubscribe/tick-scheduling half) to keep both files within the
 * project's file-size guideline.
 */
import { resolveCodexDescendantFile, resolveSources } from "./agent-transcript-sources.ts";
import { createFileTailState } from "./agent-transcript-file-tail-state.ts";
import { processFileTail, type ProcessFileResult } from "./agent-transcript-file-tail-feed.ts";
import { paginateTagged, type TaggedEnvelope } from "./agent-transcript-envelope.ts";
import type { SessionHub, TranscriptSubscription } from "./agent-transcript-session-hub-types.ts";
import { sendWsMessage, type AgentTranscriptWsLike } from "./agent-transcript-ws-like.ts";
import {
  IDLE_AFTER_MS, type AgentTranscriptCursor, type AgentTranscriptEventsMsg,
} from "../../shared/agent-transcript-protocol.ts";

type FileEntry = { key: string; result: ProcessFileResult };

export function buildCursor(sub: TranscriptSubscription): AgentTranscriptCursor {
  const cursor: AgentTranscriptCursor = {};
  for (const [key, f] of sub.files) cursor[key] = f.offset;
  return cursor;
}

export function isIdle(sub: TranscriptSubscription, now: number): boolean {
  if (sub.files.size === 0) return false;
  let latestGrowth = 0;
  for (const f of sub.files.values()) latestGrowth = Math.max(latestGrowth, f.lastGrowthAt);
  return now - latestGrowth >= IDLE_AFTER_MS;
}

/** Re-derive every file in a subscription from byte 0, for the rare case where any one of them reset. */
function fullResync(sub: TranscriptSubscription, now: number): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const [key, f] of sub.files) {
    const fresh = createFileTailState(f.ref, 0, now);
    const result = processFileTail(fresh, now);
    sub.files.set(key, fresh);
    entries.push({ key, result });
  }
  return entries;
}

/**
 * Bring a Claude card subscription's file set up to date with the card's
 * current group — a grandchild whose own transcript appears after subscribe
 * must join the stream rather than wait for the window to be reopened. Runs
 * every tick but stays cheap: `resolveSources` caches its own result for ~2s.
 */
function refreshClaudeCardFiles(hub: SessionHub, sub: TranscriptSubscription, now: number): void {
  if (hub.owned.providerId !== "claude" || sub.source.kind !== "card") return;
  const resolved = resolveSources(hub.owned, sub.source);
  if (!Array.isArray(resolved)) return;
  for (const ref of resolved) {
    if (sub.files.has(ref.key)) continue;
    sub.files.set(ref.key, createFileTailState(ref, 0, now));
  }
}

/**
 * Fold newly-discovered Codex descendant threads — surfaced as `links` from
 * this tick's own reads — into the subscription, each re-validated through
 * the exact same fail-closed descendant chain a directly-requested card goes
 * through (`resolveCodexDescendantFile`), never a weaker check invented for
 * the live-discovery path.
 */
function addDiscoveredCodexFiles(hub: SessionHub, sub: TranscriptSubscription, entries: FileEntry[], now: number): FileEntry[] {
  if (hub.owned.providerId !== "codex" || sub.source.kind !== "card") return [];
  const seen = new Set<string>();
  const added: FileEntry[] = [];
  for (const { result } of entries) {
    for (const threadId of result.links) {
      if (seen.has(threadId) || sub.files.has(threadId)) continue;
      seen.add(threadId);
      const ref = resolveCodexDescendantFile(hub.owned, threadId);
      if (!ref) continue;
      const fresh = createFileTailState(ref, 0, now);
      sub.files.set(threadId, fresh);
      added.push({ key: threadId, result: processFileTail(fresh, now) });
    }
  }
  return added;
}

function tagEntries(entries: FileEntry[]): TaggedEnvelope[] {
  const out: TaggedEnvelope[] = [];
  for (const { key, result } of entries) {
    for (let i = 0; i < result.envelopes.length; i++) {
      out.push({ envelope: result.envelopes[i]!, fileKey: key, consumedThrough: result.consumedThrough[i]! });
    }
  }
  return out;
}

/**
 * One read across every file in the subscription, plus whatever the file set
 * itself grew by this tick (new Claude group entries, newly-linked Codex
 * descendants). If any file reports a reset, every file is re-derived from 0
 * — a client wiping its view on `reset: true` must not lose content from a
 * file that did not itself change.
 */
function readSubscription(hub: SessionHub, sub: TranscriptSubscription, now: number): { items: TaggedEnvelope[]; reset: boolean; hasMoreBacklog: boolean } {
  refreshClaudeCardFiles(hub, sub, now);

  let entries: FileEntry[] = [...sub.files.entries()].map(([key, f]) => ({ key, result: processFileTail(f, now) }));
  const reset = entries.some(({ result }) => result.reset);
  if (reset) entries = fullResync(sub, now);

  entries = [...entries, ...addDiscoveredCodexFiles(hub, sub, entries, now)];

  const hasMoreBacklog = entries.some(({ result }) => result.hasMoreBacklog);
  return { items: tagEntries(entries), reset, hasMoreBacklog };
}

interface PushOutcome {
  sent: boolean;
  /** Whether a per-tick read budget left bytes unread — the caller must keep
   *  polling at the live cadence, even for an otherwise-idle subscription. */
  hasMoreBacklog: boolean;
}

/**
 * Drain and send a subscription's current backlog, paging large ones. Every
 * page's `cursor` reflects exactly the file offsets consumed by that page's
 * own content — not the subscription's final offset after the whole tick's
 * read — so a client that only received page k of a multi-page push before
 * dropping resumes at page k+1 on reconnect, never past it.
 *
 * `alwaysSend` covers the subscribe-time call: a client that subscribed
 * already caught up (cursor === current size) still gets one confirming
 * message — silence would be indistinguishable from a subscribe that never
 * reached the hub at all. A live tick with nothing new AND nothing left to
 * catch up on sends nothing, or every idle subscription would cost a message
 * every 250ms/2s forever.
 */
function pushUpdate(hub: SessionHub, ws: AgentTranscriptWsLike, sub: TranscriptSubscription, now: number, alwaysSend: boolean): PushOutcome {
  const preTickCursor = buildCursor(sub);
  const { items, reset, hasMoreBacklog } = readSubscription(hub, sub, now);
  const pages = paginateTagged(items);
  if (pages.length === 0) {
    if (!reset && !alwaysSend && !hasMoreBacklog) return { sent: true, hasMoreBacklog: false };
    pages.push([]);
  }
  const running = !isIdle(sub, now);
  // On reset every file is being replaced from scratch, so the cursor for
  // this push starts empty rather than carrying over pre-tick offsets that
  // no longer describe what a client holding them has actually been sent.
  const runningCursor: AgentTranscriptCursor = reset ? {} : { ...preTickCursor };
  for (let i = 0; i < pages.length; i++) {
    for (const item of pages[i]!) runningCursor[item.fileKey] = item.consumedThrough;
    const msg: AgentTranscriptEventsMsg = {
      type: "agent-transcript:events",
      subId: sub.subId,
      events: pages[i]!.map((item) => item.envelope),
      cursor: { ...runningCursor },
      available: true,
      running,
      // Not just "another page is already queued behind this one" — also
      // true on the LAST page when the read budget left bytes unread, so the
      // client keeps showing "still catching up" instead of "done".
      ...(i < pages.length - 1 || hasMoreBacklog ? { more: true as const } : {}),
      ...(reset && i === 0 ? { reset: true as const } : {}),
    };
    if (!sendWsMessage(ws, msg)) return { sent: false, hasMoreBacklog };
  }
  return { sent: true, hasMoreBacklog };
}

export type PushResult =
  | { outcome: "ok"; hasMoreBacklog: boolean }
  | { outcome: "send-failed"; hasMoreBacklog: boolean }
  | { outcome: "error"; hasMoreBacklog: false };

/**
 * `pushUpdate`, but a throw anywhere in the read/parse/send path is caught
 * and reported as `outcome: "error"` instead of reaching the caller — a
 * single malformed record or a raced file error must never climb out of a
 * WS message handler or a `setInterval` tick into an uncaught exception that
 * takes the whole server down. Distinct from `"send-failed"` (the socket
 * itself is gone) because the caller must react very differently: a
 * send failure means the WHOLE client is unreachable and every hub should
 * drop it; a thrown error means only THIS subscription's own read/parse
 * broke, and every other subscription on the same socket must keep working.
 */
export function safePushUpdate(hub: SessionHub, ws: AgentTranscriptWsLike, sub: TranscriptSubscription, now: number, alwaysSend: boolean): PushResult {
  try {
    const { sent, hasMoreBacklog } = pushUpdate(hub, ws, sub, now, alwaysSend);
    return sent ? { outcome: "ok", hasMoreBacklog } : { outcome: "send-failed", hasMoreBacklog };
  } catch {
    return { outcome: "error", hasMoreBacklog: false };
  }
}
