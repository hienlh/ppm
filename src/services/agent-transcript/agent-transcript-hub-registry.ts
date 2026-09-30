/**
 * Cross-hub bookkeeping for `agent-transcript-hub.ts`: which `SessionHub` a
 * client's `subId` currently lives in (needed because a `subId` carries no
 * session info on `unsubscribe`, and the same client can hold subscriptions
 * on several different sessions at once), the server-wide subscription count,
 * and dropping a client from every hub it touches at once.
 */
import { configService } from "../config.service.ts";
import type { OwnedSession } from "./session-ownership.ts";
import type { AgentTranscriptWsLike } from "./agent-transcript-ws-like.ts";
import {
  activitySubCount, createSessionHub, hubIsEmpty, transcriptSubCount, type SessionHub,
} from "./agent-transcript-session-hub-types.ts";
import { dropAllTranscriptForWs, removeTranscriptSubscription } from "./agent-transcript-session-hub.ts";
import { dropAllActivityForWs, removeActivitySubscription } from "./agent-transcript-session-hub-activity.ts";

const sessionHubs = new Map<string, SessionHub>();
/** Which session hub a client's transcript/activity `subId` currently lives in. */
const clientTranscriptSubs = new Map<AgentTranscriptWsLike, Map<string, string>>();
const clientActivitySubs = new Map<AgentTranscriptWsLike, Map<string, string>>();

export function hubKey(providerId: string, sessionId: string): string {
  return `${providerId}\0${sessionId}`;
}

/** `ws.data.token` (snapshotted at upgrade) against the live config — see `server/index.ts` and `ws/global.ts`. */
export function tokenStillValid(ws: AgentTranscriptWsLike): boolean {
  const auth = configService.get("auth");
  if (!auth.enabled) return true;
  return (ws.data?.token ?? null) === auth.token;
}

export function totalTranscriptSubs(): number {
  let n = 0;
  for (const hub of sessionHubs.values()) n += transcriptSubCount(hub);
  return n;
}

export function totalActivitySubs(): number {
  let n = 0;
  for (const hub of sessionHubs.values()) n += activitySubCount(hub);
  return n;
}

export function projectPathFor(projectName: string): string | null {
  return configService.get("projects").find((p) => p.name === projectName)?.path ?? null;
}

/**
 * `owned` must come from an `assertSessionInProject` call made for THIS
 * request's own claimed project — a hub already cached under the same
 * `(providerId, sessionId)` is only ever reused once the caller has
 * independently proven that pairing resolves to a project it may read,
 * never trusted just because some earlier, different caller created it.
 */
export function getOrCreateHub(owned: OwnedSession): SessionHub {
  const key = hubKey(owned.providerId, owned.sessionId);
  const existing = sessionHubs.get(key);
  if (existing) return existing;
  const hub = createSessionHub(key, owned, dropClientEverywhere, tokenStillValid);
  sessionHubs.set(key, hub);
  return hub;
}

export function maybeDropHub(key: string): void {
  const hub = sessionHubs.get(key);
  if (hub && hubIsEmpty(hub)) sessionHubs.delete(key);
}

export function registerTranscriptSub(ws: AgentTranscriptWsLike, subId: string, key: string): void {
  let bySubId = clientTranscriptSubs.get(ws);
  if (!bySubId) {
    bySubId = new Map();
    clientTranscriptSubs.set(ws, bySubId);
  }
  bySubId.set(subId, key);
}

export function registerActivitySub(ws: AgentTranscriptWsLike, subId: string, key: string): void {
  let bySubId = clientActivitySubs.get(ws);
  if (!bySubId) {
    bySubId = new Map();
    clientActivitySubs.set(ws, bySubId);
  }
  bySubId.set(subId, key);
}

export function transcriptSubCountForClient(ws: AgentTranscriptWsLike): number {
  return clientTranscriptSubs.get(ws)?.size ?? 0;
}

export function activitySubCountForClient(ws: AgentTranscriptWsLike): number {
  return clientActivitySubs.get(ws)?.size ?? 0;
}

export function unregisterTranscriptSub(ws: AgentTranscriptWsLike, subId: string): void {
  const key = clientTranscriptSubs.get(ws)?.get(subId);
  if (!key) return;
  clientTranscriptSubs.get(ws)!.delete(subId);
  if (clientTranscriptSubs.get(ws)!.size === 0) clientTranscriptSubs.delete(ws);
  const hub = sessionHubs.get(key);
  if (hub) {
    removeTranscriptSubscription(hub, ws, subId);
    maybeDropHub(key);
  }
}

export function unregisterActivitySub(ws: AgentTranscriptWsLike, subId: string): void {
  const key = clientActivitySubs.get(ws)?.get(subId);
  if (!key) return;
  clientActivitySubs.get(ws)!.delete(subId);
  if (clientActivitySubs.get(ws)!.size === 0) clientActivitySubs.delete(ws);
  const hub = sessionHubs.get(key);
  if (hub) {
    removeActivitySubscription(hub, ws, subId);
    maybeDropHub(key);
  }
}

/** Drop everything a socket holds, in every hub it touches. Called on close, a stale token, or a failed send. */
export function dropClientEverywhere(ws: AgentTranscriptWsLike): void {
  const hubKeys = new Set<string>([
    ...(clientTranscriptSubs.get(ws)?.values() ?? []),
    ...(clientActivitySubs.get(ws)?.values() ?? []),
  ]);
  clientTranscriptSubs.delete(ws);
  clientActivitySubs.delete(ws);
  for (const key of hubKeys) {
    const hub = sessionHubs.get(key);
    if (!hub) continue;
    dropAllTranscriptForWs(hub, ws);
    dropAllActivityForWs(hub, ws);
    maybeDropHub(key);
  }
}

/** Test-only: forget every hub and client mapping between cases. */
export function _resetAgentTranscriptHubForTest(): void {
  sessionHubs.clear();
  clientTranscriptSubs.clear();
  clientActivitySubs.clear();
}

/** Test-only: peek at a hub's existence/subscription counts without exporting internal state. */
export function _debugHubSnapshotForTest(providerId: "claude" | "codex", sessionId: string): { exists: boolean; transcriptSubs: number } {
  const hub = sessionHubs.get(hubKey(providerId, sessionId));
  return { exists: !!hub, transcriptSubs: hub ? transcriptSubCount(hub) : 0 };
}

/** Test-only: the raw hub, so a test can drive its tick functions directly instead of waiting on real timers. */
export function _getSessionHubForTest(providerId: "claude" | "codex", sessionId: string): SessionHub | undefined {
  return sessionHubs.get(hubKey(providerId, sessionId));
}
