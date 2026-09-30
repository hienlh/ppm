/**
 * Transcript-subscription lifecycle for a session hub: subscribe → catch-up
 * → live tick scheduling. The per-tick read-and-push mechanics (exact per-page
 * cursors, dynamic file-set growth) live in `agent-transcript-session-hub-read.ts`.
 */
import { resolveSources } from "./agent-transcript-sources.ts";
import { statSizeSafe } from "./agent-transcript-fs-io.ts";
import { agentTranscriptClock, agentTranscriptTimers } from "./agent-transcript-hub-clock.ts";
import { createFileTailState } from "./agent-transcript-file-tail-state.ts";
import { isIdle, safePushUpdate } from "./agent-transcript-session-hub-read.ts";
import { mapSourceErrorCode } from "./agent-transcript-error-map.ts";
import type { SessionHub, TranscriptSubscription } from "./agent-transcript-session-hub-types.ts";
import { type AgentTranscriptWsLike } from "./agent-transcript-ws-like.ts";
import {
  IDLE_TICK_MS, LIVE_TICK_MS,
  type AgentTranscriptCursor, type AgentTranscriptErrorCode, type AgentTranscriptSourceKind,
} from "../../shared/agent-transcript-protocol.ts";

/**
 * A client-supplied cursor offset, sanitized: only a safe non-negative
 * integer is trusted, and the result is clamped to the file's current size
 * either way. A fractional, negative, NaN or absurdly large value degrades
 * to "start from the beginning" rather than ever reaching a raw file read —
 * `fs.readSync`'s position argument throws on anything but a real integer.
 */
function sanitizeOffset(value: unknown, size: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, size);
}

export interface SubscribeResult {
  ok: boolean;
  code?: AgentTranscriptErrorCode;
  /** A push failed mid-catch-up (send returned 0 or threw) — caller drops the whole client. */
  sendFailed?: boolean;
}

function ensureTicker(hub: SessionHub): void {
  if (hub.tickHandle !== null) return;
  hub.tickHandle = agentTranscriptTimers.setInterval(() => tickTranscripts(hub), LIVE_TICK_MS);
}

function stopTickerIfEmpty(hub: SessionHub): void {
  if (hub.subscriptions.size > 0 || hub.tickHandle === null) return;
  agentTranscriptTimers.clearInterval(hub.tickHandle);
  hub.tickHandle = null;
}

export function addTranscriptSubscription(
  hub: SessionHub,
  ws: AgentTranscriptWsLike,
  subId: string,
  source: AgentTranscriptSourceKind,
  cursor: AgentTranscriptCursor | undefined,
): SubscribeResult {
  const resolved = resolveSources(hub.owned, source);
  if (!Array.isArray(resolved)) return { ok: false, code: mapSourceErrorCode(resolved.code) };

  const now = agentTranscriptClock.now();
  const sub: TranscriptSubscription = { subId, source, files: new Map(), nextTickAt: now + LIVE_TICK_MS };
  for (const ref of resolved) {
    const size = statSizeSafe(ref.path) ?? 0;
    const start = sanitizeOffset(cursor?.[ref.key], size);
    sub.files.set(ref.key, createFileTailState(ref, start, now));
  }

  // Registered in the hub BEFORE the first push, so a throw from that push
  // (caught below and treated as a failed send) still leaves the subscription
  // reachable for cleanup — never an entry the registry never learns about
  // and no unsubscribe or disconnect path can then find.
  let bySubId = hub.subscriptions.get(ws);
  if (!bySubId) {
    bySubId = new Map();
    hub.subscriptions.set(ws, bySubId);
  }
  bySubId.set(subId, sub);
  ensureTicker(hub);

  const sent = safePushUpdate(hub, ws, sub, now, true);
  sub.nextTickAt = now + (isIdle(sub, now) ? IDLE_TICK_MS : LIVE_TICK_MS);
  return { ok: true, sendFailed: !sent };
}

/** Remove one subscription. Returns whether it existed. */
export function removeTranscriptSubscription(hub: SessionHub, ws: AgentTranscriptWsLike, subId: string): boolean {
  const bySubId = hub.subscriptions.get(ws);
  if (!bySubId?.delete(subId)) return false;
  if (bySubId.size === 0) hub.subscriptions.delete(ws);
  stopTickerIfEmpty(hub);
  return true;
}

/** Drop every transcript subscription a socket holds on this hub. Returns how many existed. */
export function dropAllTranscriptForWs(hub: SessionHub, ws: AgentTranscriptWsLike): number {
  const bySubId = hub.subscriptions.get(ws);
  if (!bySubId) return 0;
  hub.subscriptions.delete(ws);
  stopTickerIfEmpty(hub);
  return bySubId.size;
}

export function transcriptSubIdsForWs(hub: SessionHub, ws: AgentTranscriptWsLike): string[] {
  return [...(hub.subscriptions.get(ws)?.keys() ?? [])];
}

/** One 250ms wake: push only the subscriptions whose own cadence is due (live or idle-slowed). */
export function tickTranscripts(hub: SessionHub): void {
  const now = agentTranscriptClock.now();
  const failedClients = new Set<AgentTranscriptWsLike>();

  for (const [ws, bySubId] of hub.subscriptions) {
    if (failedClients.has(ws)) continue;
    if (!hub.tokenStillValid(ws)) {
      failedClients.add(ws);
      continue;
    }
    for (const sub of bySubId.values()) {
      if (now < sub.nextTickAt) continue;
      if (!safePushUpdate(hub, ws, sub, now, false)) {
        failedClients.add(ws);
        break;
      }
      sub.nextTickAt = now + (isIdle(sub, now) ? IDLE_TICK_MS : LIVE_TICK_MS);
    }
  }

  for (const ws of failedClients) hub.onSendFailure(ws);
}
