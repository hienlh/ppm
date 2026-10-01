/**
 * Steps already held in chat memory, shown until (or unless) a window/sheet's live hub
 * subscription takes over — seeded by the opener, since the window itself never had the
 * chat's in-memory `children` array to fall back to.
 *
 * Pruned reactively rather than left to grow: every close/focus/open on the window store or
 * the mobile sheet re-derives which keys are still on screen and drops the rest, so a
 * session opened once and closed does not keep its whole event buffer alive for the rest of
 * the page's life.
 */
import { create } from "zustand";
import { useWindowStore } from "@/components/floating-window/window-store";
import { useAgentSessionSheetStore } from "./agent-session-sheet-store";
import type { AgentTranscriptSourceKind } from "../../../shared/agent-transcript-protocol";
import type { ChatEvent } from "../../../types/chat";

export function fallbackKey(sessionId: string, source: AgentTranscriptSourceKind): string {
  return source.kind === "card"
    ? `${sessionId}:${source.cardId}`
    : `${sessionId}:${source.teamName}:${source.memberName}`;
}

interface FallbackStoreState {
  entries: Record<string, ChatEvent[]>;
}

export const useAgentSessionFallbackStore = create<FallbackStoreState>(() => ({ entries: {} }));

/** Called by the opener right before it opens a window/sheet for this key. */
export function setFallbackEvents(key: string, events: ChatEvent[]): void {
  useAgentSessionFallbackStore.setState((s) => ({ entries: { ...s.entries, [key]: events } }));
}

function activeKeys(): Set<string> {
  const keys = new Set<string>();
  for (const win of Object.values(useWindowStore.getState().windows)) {
    if (win.kind !== "agent-session") continue;
    const p = win.payload as { sessionId?: unknown; source?: AgentTranscriptSourceKind } | undefined;
    if (typeof p?.sessionId === "string" && p.source) keys.add(fallbackKey(p.sessionId, p.source));
  }
  const sheetPayload = useAgentSessionSheetStore.getState().payload;
  if (sheetPayload) keys.add(fallbackKey(sheetPayload.sessionId, sheetPayload.source));
  return keys;
}

function prune(): void {
  const keep = activeKeys();
  useAgentSessionFallbackStore.setState((s) => {
    const entries: Record<string, ChatEvent[]> = {};
    let changed = false;
    for (const [key, events] of Object.entries(s.entries)) {
      if (keep.has(key)) entries[key] = events;
      else changed = true;
    }
    return changed ? { entries } : s;
  });
}

useWindowStore.subscribe(prune);
useAgentSessionSheetStore.subscribe(prune);
