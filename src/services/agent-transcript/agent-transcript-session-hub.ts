/**
 * Transcript-subscription lifecycle for a session hub: subscribe → catch-up
 * → live tick scheduling. The per-tick read-and-push mechanics (exact per-page
 * cursors, dynamic file-set growth) live in `agent-transcript-session-hub-read.ts`.
 */
import { CODEX_THREAD_ID_RE, resolveCodexDescendantFile, resolveSources } from "./agent-transcript-sources.ts";
import { statSizeSafe } from "./agent-transcript-fs-io.ts";
import { agentTranscriptClock, agentTranscriptTimers } from "./agent-transcript-hub-clock.ts";
import { createFileTailState } from "./agent-transcript-file-tail-state.ts";
import { isIdle, safePushUpdate } from "./agent-transcript-session-hub-read.ts";
import { mapSourceErrorCode } from "./agent-transcript-error-map.ts";
import { sendWsMessage, type AgentTranscriptWsLike } from "./agent-transcript-ws-like.ts";
import type { SessionHub, TranscriptSubscription } from "./agent-transcript-session-hub-types.ts";
import {
  IDLE_TICK_MS, LIVE_TICK_MS,
  type AgentTranscriptCursor, type AgentTranscriptErrorCode,
  type AgentTranscriptErrorMsg, type AgentTranscriptSourceKind,
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

/**
 * Codex only: a cursor can name descendant thread ids the server derived for
 * this same card in an EARLIER subscription — added live via a tail parser's
 * own `links` after the initial subscribe — that a fresh `resolveSources`
 * call has no way to rediscover on its own (it only ever returns the card's
 * own thread). Each such key is re-validated through the exact same
 * fail-closed descendant chain a directly-requested card goes through; a
 * forged or unrelated key is simply ignored, never trusted just because the
 * client echoed it back.
 */
function seedCodexDescendantsFromCursor(
  hub: SessionHub,
  sub: TranscriptSubscription,
  source: AgentTranscriptSourceKind,
  cursor: AgentTranscriptCursor | undefined,
  now: number,
): void {
  if (hub.owned.providerId !== "codex" || source.kind !== "card" || !cursor) return;
  for (const key of Object.keys(cursor)) {
    if (sub.files.has(key) || !CODEX_THREAD_ID_RE.test(key)) continue;
    const ref = resolveCodexDescendantFile(hub.owned, key);
    if (!ref) continue;
    const size = statSizeSafe(ref.path) ?? 0;
    const start = sanitizeOffset(cursor[key], size);
    sub.files.set(key, createFileTailState(ref, start, now));
  }
}

/** How long until the next tick: the live cadence while idle-but-still-catching-up
 *  on a read-budget-truncated backlog, else the usual idle/live split. */
function nextCadence(sub: TranscriptSubscription, now: number, hasMoreBacklog: boolean): number {
  return now + (hasMoreBacklog || !isIdle(sub, now) ? LIVE_TICK_MS : IDLE_TICK_MS);
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
  seedCodexDescendantsFromCursor(hub, sub, source, cursor, now);

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

  const result = safePushUpdate(hub, ws, sub, now, true);
  if (result.outcome === "error") {
    // The subscription never reached the top-level registry (that happens
    // only once this function returns `ok: true`), so undoing the hub-local
    // registration here is enough — nothing else has learned about it yet.
    bySubId.delete(subId);
    stopTickerIfEmpty(hub);
    console.warn(`[agent-transcript] hub=${hub.key} subId=${subId} subscribe-time read failed`);
    return { ok: false, code: "bad_request" };
  }
  sub.nextTickAt = nextCadence(sub, now, result.hasMoreBacklog);
  return { ok: true, sendFailed: result.outcome === "send-failed" };
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

function sendSubscriptionError(ws: AgentTranscriptWsLike, subId: string): void {
  sendWsMessage(ws, { type: "agent-transcript:error", subId, code: "bad_request" } satisfies AgentTranscriptErrorMsg);
}

/**
 * One 250ms wake: push only the subscriptions whose own cadence is due (live
 * or idle-slowed).
 *
 * A thrown read/parse error is scoped to the ONE subscription that threw —
 * logged once, reported to the client as a normal `agent-transcript:error`,
 * and dropped — never treated like a dead socket. `erroredSubs` mirrors
 * `failedClients`'s defer-to-after-the-loop pattern: `onSubscriptionError`
 * mutates `hub.subscriptions` (via the registry's `unregisterTranscriptSub`),
 * which must not happen while this function is still iterating that same map.
 */
export function tickTranscripts(hub: SessionHub): void {
  const now = agentTranscriptClock.now();
  const failedClients = new Set<AgentTranscriptWsLike>();
  const erroredSubs: { ws: AgentTranscriptWsLike; subId: string }[] = [];

  for (const [ws, bySubId] of hub.subscriptions) {
    if (failedClients.has(ws)) continue;
    if (!hub.tokenStillValid(ws)) {
      failedClients.add(ws);
      continue;
    }
    for (const [subId, sub] of bySubId) {
      if (now < sub.nextTickAt) continue;
      const result = safePushUpdate(hub, ws, sub, now, false);
      if (result.outcome === "send-failed") {
        failedClients.add(ws);
        break;
      }
      if (result.outcome === "error") {
        console.warn(`[agent-transcript] hub=${hub.key} subId=${subId} tick failed, dropping this subscription`);
        sendSubscriptionError(ws, subId);
        erroredSubs.push({ ws, subId });
        continue;
      }
      sub.nextTickAt = nextCadence(sub, now, result.hasMoreBacklog);
    }
  }

  for (const ws of failedClients) hub.onSendFailure(ws);
  for (const { ws, subId } of erroredSubs) hub.onSubscriptionError(ws, subId);
}
