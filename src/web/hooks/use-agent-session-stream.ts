/**
 * Follow one Agent card's or teammate's work session live, from the transcript hub on
 * `/ws/global`.
 *
 * Generalises the old per-teammate HTTP poll (`use-member-transcript-tail.ts`) to the hub
 * protocol: a subscription is never queued while the socket is down — `sendIfOpen` drops it
 * instead, because a queued subscribe would replay later with a cursor that is already
 * stale by the time the flush happens. `onGlobalReady` (fired on every connect and every
 * reconnect) is what actually (re)subscribes, using the cursor the last response handed
 * back, so a reconnect resumes with no gap and no duplicate instead of going quiet.
 */
import { useEffect, useMemo, useState } from "react";
import { onGlobalReady, sendIfOpen } from "@/lib/global-ws-channel";
import { applyEnvelopeBatch, type StreamEntry } from "@/lib/agent-session-stream-merge";
import type {
  AgentTranscriptCursor,
  AgentTranscriptErrorCode,
  AgentTranscriptErrorMsg,
  AgentTranscriptEventsMsg,
  AgentTranscriptProviderId,
  AgentTranscriptSourceKind,
} from "../../shared/agent-transcript-protocol";
import type { ChatEvent } from "../../types/chat";

export interface UseAgentSessionStreamOptions {
  projectName: string;
  providerId: AgentTranscriptProviderId;
  sessionId: string;
  source: AgentTranscriptSourceKind;
  /** Steps already held in chat memory — shown while the transcript stream is unavailable. */
  fallbackEvents?: ChatEvent[];
}

export interface UseAgentSessionStream {
  events: ChatEvent[];
  /** True only once the server has answered with at least one readable file for this
   *  source. False before the first response, and after one that found no transcript (old
   *  session, never had one, or an error) — `events` falls back to `fallbackEvents` both
   *  times, so a window shows what is already known rather than a blank list while the
   *  first page is still in flight. */
  available: boolean;
  running: boolean;
  loading: boolean;
  error: AgentTranscriptErrorCode | null;
}

function newSubId(): string {
  return `ats-${Math.random().toString(36).slice(2, 10)}`;
}

export function useAgentSessionStream(opts: UseAgentSessionStreamOptions): UseAgentSessionStream {
  const { projectName, providerId, sessionId, source, fallbackEvents } = opts;
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  // False until the first response says otherwise, so a window opened with fallback events
  // shows them immediately instead of a blank list while the first page is in flight.
  const [available, setAvailable] = useState(false);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AgentTranscriptErrorCode | null>(null);

  // Any of these changing is a different subscription, not a resume of the same one —
  // JSON-stringified so the effect only re-runs when the actual identity changes, not on
  // every render a caller passes a fresh `source` object literal.
  const sourceKey = JSON.stringify([projectName, providerId, sessionId, source]);

  useEffect(() => {
    const subId = newSubId();
    let entriesBuf: StreamEntry[] = [];
    let cursor: AgentTranscriptCursor | undefined;
    setEntries([]);
    setAvailable(false);
    setRunning(false);
    setLoading(true);
    setError(null);

    const subscribe = () => {
      sendIfOpen(
        JSON.stringify({
          type: "agent-transcript:subscribe",
          subId,
          projectName,
          providerId,
          sessionId,
          source,
          ...(cursor ? { cursor } : {}),
        }),
      );
    };

    const onEvents = (e: Event) => {
      const data = (e as CustomEvent<AgentTranscriptEventsMsg>).detail;
      if (data.subId !== subId) return;
      entriesBuf = applyEnvelopeBatch(entriesBuf, data);
      cursor = data.cursor;
      setEntries(entriesBuf);
      setAvailable(data.available);
      setRunning(data.running);
      setLoading(false);
      setError(null);
    };

    const onError = (e: Event) => {
      const data = (e as CustomEvent<AgentTranscriptErrorMsg>).detail;
      if (data.subId !== subId) return;
      setAvailable(false);
      setLoading(false);
      setError(data.code);
    };

    window.addEventListener("agent-transcript:events", onEvents);
    window.addEventListener("agent-transcript:error", onError);
    const stopResubscribing = onGlobalReady(subscribe);
    subscribe();

    return () => {
      window.removeEventListener("agent-transcript:events", onEvents);
      window.removeEventListener("agent-transcript:error", onError);
      stopResubscribing();
      sendIfOpen(JSON.stringify({ type: "agent-transcript:unsubscribe", subId }));
    };
    // sourceKey captures every real dependency (projectName/providerId/sessionId/source).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  const events = useMemo(() => entries.map((e) => e.ev), [entries]);

  return {
    events: available ? events : (fallbackEvents ?? []),
    available,
    running,
    loading,
    error,
  };
}
