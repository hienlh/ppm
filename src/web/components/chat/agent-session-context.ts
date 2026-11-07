/**
 * Which session an Agent/Task card's one-line summary belongs to.
 *
 * `ToolCard`/`AgentCardSummary` need `{projectName, providerId, sessionId}` to
 * build the `openAgentSession` payload, but a card has no such identity of its
 * own — it only ever knows its `toolUseId`. `chat-tab.tsx` provides this once
 * per conversation; a read-only surface with no real session (the group-chat
 * transcript viewer) provides none, and the consumer falls back to a synthetic,
 * never-resolvable identity so the card still opens in memory-only mode instead
 * of doing nothing on tap.
 */
import { createContext, createElement, useContext, type ReactNode } from "react";
import type { AgentTranscriptProviderId } from "../../../shared/agent-transcript-protocol";

export interface AgentSessionIdentity {
  projectName: string;
  providerId: AgentTranscriptProviderId;
  sessionId: string;
}

/** Normalize a session provider id into one of the supported agent-transcript hubs. */
export function normalizeProviderId(id: string | undefined | null): AgentTranscriptProviderId {
  if (id === "codex" || id === "antigravity") return id;
  return "claude";
}

const AgentSessionContext = createContext<AgentSessionIdentity | null>(null);

export function useAgentSessionContext(): AgentSessionIdentity | null {
  return useContext(AgentSessionContext);
}

export function AgentSessionProvider({ value, children }: { value: AgentSessionIdentity; children: ReactNode }) {
  return createElement(AgentSessionContext.Provider, { value }, children);
}
