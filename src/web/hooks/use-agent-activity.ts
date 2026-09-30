/**
 * "Who is running right now" for one session, from the transcript hub's liveness
 * feed on `/ws/global` (phase 3's `agent-activity` push).
 *
 * Mirrors `use-agent-session-stream.ts`'s subscribe contract exactly: a
 * subscription is never queued while the socket is down (`sendIfOpen` drops it
 * instead — a queued subscribe would flush late, against a state the caller has
 * already moved past), and `onGlobalReady` (fired on every connect and every
 * reconnect) is what actually (re)subscribes. There is no cursor to resume from
 * here — each push is a full snapshot of who is running, not a page of steps —
 * so a resubscribe is just the same message again.
 */
import { useEffect, useState } from "react";
import { onGlobalReady, sendIfOpen } from "@/lib/global-ws-channel";
import type {
  AgentActivityMsg,
  AgentTranscriptProviderId,
  AgentTranscriptRunningEntry,
} from "../../shared/agent-transcript-protocol";

export interface UseAgentActivityOptions {
  projectName: string;
  providerId: AgentTranscriptProviderId;
  /** Empty/absent — a draft chat with no session yet — subscribes to nothing. */
  sessionId: string | null | undefined;
}

function newSubId(): string {
  return `aa-${Math.random().toString(36).slice(2, 10)}`;
}

export function useAgentActivity(opts: UseAgentActivityOptions): AgentTranscriptRunningEntry[] {
  const { projectName, providerId, sessionId } = opts;
  const [running, setRunning] = useState<AgentTranscriptRunningEntry[]>([]);

  useEffect(() => {
    setRunning([]);
    if (!sessionId || !projectName) return;
    const subId = newSubId();

    const subscribe = () => {
      sendIfOpen(JSON.stringify({ type: "agent-activity:subscribe", subId, projectName, providerId, sessionId }));
    };

    const onActivity = (e: Event) => {
      const data = (e as CustomEvent<AgentActivityMsg>).detail;
      if (data.subId !== subId) return;
      setRunning(data.running);
    };

    window.addEventListener("agent-activity", onActivity);
    const stopResubscribing = onGlobalReady(subscribe);
    subscribe();

    return () => {
      window.removeEventListener("agent-activity", onActivity);
      stopResubscribing();
      sendIfOpen(JSON.stringify({ type: "agent-activity:unsubscribe", subId }));
    };
    // projectName/providerId/sessionId are every real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, providerId, sessionId]);

  return running;
}
