/**
 * Shared state for one `(providerId, sessionId)` hub: the subscriptions
 * currently reading it, and the two lazily-started tickers (live transcript
 * push, activity feed) that exist only while something is subscribed.
 */
import type { OwnedSession } from "./session-ownership.ts";
import type { FileTailState } from "./agent-transcript-file-tail-state.ts";
import type { AgentTranscriptWsLike } from "./agent-transcript-ws-like.ts";
import type { AgentTranscriptSourceKind } from "../../shared/agent-transcript-protocol.ts";

export interface TranscriptSubscription {
  subId: string;
  source: AgentTranscriptSourceKind;
  files: Map<string, FileTailState>;
  nextTickAt: number;
}

export interface SessionHub {
  key: string;
  owned: OwnedSession;
  /** By socket, then by that socket's own `subId` — a client may hold several subscriptions. */
  subscriptions: Map<AgentTranscriptWsLike, Map<string, TranscriptSubscription>>;
  activitySubs: Map<AgentTranscriptWsLike, Set<string>>;
  tickHandle: unknown | null;
  activityHandle: unknown | null;
  /**
   * Owned by the top-level registry (`agent-transcript-hub.ts`), which is the
   * only layer that knows a socket's subscriptions can span several session
   * hubs at once. A failed push or a stale auth token must drop the client
   * everywhere, not just in the hub that happened to detect it.
   */
  onSendFailure: (ws: AgentTranscriptWsLike) => void;
  /**
   * Owned by the top-level registry, same reason as `onSendFailure` — drop
   * ONE subscription's bookkeeping everywhere it is tracked (this hub's own
   * map AND the registry's per-client `subId` index), not just here. Used
   * when a single subscription's own tick throws: the rest of that socket's
   * subscriptions, on this hub or any other, must keep working.
   */
  onSubscriptionError: (ws: AgentTranscriptWsLike, subId: string) => void;
  /** True while `ws`'s token snapshot still matches the live config. */
  tokenStillValid: (ws: AgentTranscriptWsLike) => boolean;
}

export function createSessionHub(
  key: string,
  owned: OwnedSession,
  onSendFailure: (ws: AgentTranscriptWsLike) => void,
  onSubscriptionError: (ws: AgentTranscriptWsLike, subId: string) => void,
  tokenStillValid: (ws: AgentTranscriptWsLike) => boolean,
): SessionHub {
  return {
    key,
    owned,
    subscriptions: new Map(),
    activitySubs: new Map(),
    tickHandle: null,
    activityHandle: null,
    onSendFailure,
    onSubscriptionError,
    tokenStillValid,
  };
}

/** Total transcript subscriptions across every client on this hub. */
export function transcriptSubCount(hub: SessionHub): number {
  let n = 0;
  for (const subs of hub.subscriptions.values()) n += subs.size;
  return n;
}

/** Total activity subscriptions across every client on this hub. */
export function activitySubCount(hub: SessionHub): number {
  let n = 0;
  for (const subs of hub.activitySubs.values()) n += subs.size;
  return n;
}

export function hubIsEmpty(hub: SessionHub): boolean {
  return hub.subscriptions.size === 0 && hub.activitySubs.size === 0;
}
