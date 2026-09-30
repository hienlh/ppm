/**
 * Transcript-subscription half of a session hub: subscribe → catch-up pages →
 * live tick, all through the same read-from-offset operation
 * (`processFileTail`) so there is only one code path to get right.
 */
import { resolveSources } from "./agent-transcript-sources.ts";
import { statSizeSafe } from "./agent-transcript-fs-io.ts";
import { agentTranscriptClock, agentTranscriptTimers } from "./agent-transcript-hub-clock.ts";
import { createFileTailState, processFileTail, type FileTailState } from "./agent-transcript-file-tail-state.ts";
import { paginateEnvelopes } from "./agent-transcript-envelope.ts";
import { mapSourceErrorCode } from "./agent-transcript-error-map.ts";
import type { SessionHub, TranscriptSubscription } from "./agent-transcript-session-hub-types.ts";
import { sendWsMessage, type AgentTranscriptWsLike } from "./agent-transcript-ws-like.ts";
import {
  IDLE_AFTER_MS, IDLE_TICK_MS, LIVE_TICK_MS,
  type AgentTranscriptCursor, type AgentTranscriptEnvelope, type AgentTranscriptErrorCode,
  type AgentTranscriptEventsMsg, type AgentTranscriptSourceKind,
} from "../../shared/agent-transcript-protocol.ts";

function buildCursor(sub: TranscriptSubscription): AgentTranscriptCursor {
  const cursor: AgentTranscriptCursor = {};
  for (const [key, f] of sub.files) cursor[key] = f.offset;
  return cursor;
}

function isIdle(sub: TranscriptSubscription, now: number): boolean {
  if (sub.files.size === 0) return false;
  let latestGrowth = 0;
  for (const f of sub.files.values()) latestGrowth = Math.max(latestGrowth, f.lastGrowthAt);
  return now - latestGrowth >= IDLE_AFTER_MS;
}

/** Re-derive every file in a subscription from byte 0, for the rare case where any one of them reset. */
function fullResync(sub: TranscriptSubscription, now: number): AgentTranscriptEnvelope[] {
  const envelopes: AgentTranscriptEnvelope[] = [];
  for (const [key, f] of sub.files) {
    const fresh = createFileTailState(f.ref, 0, now);
    envelopes.push(...processFileTail(fresh, now).envelopes);
    sub.files.set(key, fresh);
  }
  return envelopes;
}

/**
 * One read across every file in the subscription. If any file reports a
 * reset, every file is re-derived from 0 — a client wiping its view on
 * `reset: true` must not lose content from a file that did not itself change.
 */
function readSubscription(sub: TranscriptSubscription, now: number): { envelopes: AgentTranscriptEnvelope[]; reset: boolean } {
  const perFile: FileTailState[] = [...sub.files.values()];
  const results = perFile.map((f) => processFileTail(f, now));
  if (results.some((r) => r.reset)) return { envelopes: fullResync(sub, now), reset: true };
  return { envelopes: results.flatMap((r) => r.envelopes), reset: false };
}

/**
 * Drain and send a subscription's current backlog, paging large ones.
 * `alwaysSend` covers the subscribe-time call: a client that subscribed
 * already caught up (cursor === current size) still gets one confirming
 * message — silence would be indistinguishable from a subscribe that never
 * reached the hub at all. A live tick with nothing new sends nothing, or
 * every idle subscription would cost a message every 250ms/2s forever.
 */
function pushUpdate(ws: AgentTranscriptWsLike, sub: TranscriptSubscription, now: number, alwaysSend: boolean): boolean {
  const { envelopes, reset } = readSubscription(sub, now);
  const pages = paginateEnvelopes(envelopes);
  if (pages.length === 0) {
    if (!reset && !alwaysSend) return true;
    pages.push([]);
  }
  for (let i = 0; i < pages.length; i++) {
    const msg: AgentTranscriptEventsMsg = {
      type: "agent-transcript:events",
      subId: sub.subId,
      events: pages[i]!,
      cursor: buildCursor(sub),
      available: true,
      running: !isIdle(sub, now),
      ...(i < pages.length - 1 ? { more: true as const } : {}),
      ...(reset && i === 0 ? { reset: true as const } : {}),
    };
    if (!sendWsMessage(ws, msg)) return false;
  }
  return true;
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
    const requested = cursor && typeof cursor[ref.key] === "number" ? cursor[ref.key]! : 0;
    const start = Math.max(0, Math.min(requested, size));
    sub.files.set(ref.key, createFileTailState(ref, start, now));
  }

  let bySubId = hub.subscriptions.get(ws);
  if (!bySubId) {
    bySubId = new Map();
    hub.subscriptions.set(ws, bySubId);
  }
  bySubId.set(subId, sub);
  ensureTicker(hub);

  const sent = pushUpdate(ws, sub, now, true);
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
      if (!pushUpdate(ws, sub, now, false)) {
        failedClients.add(ws);
        break;
      }
      sub.nextTickAt = now + (isIdle(sub, now) ? IDLE_TICK_MS : LIVE_TICK_MS);
    }
  }

  for (const ws of failedClients) hub.onSendFailure(ws);
}
