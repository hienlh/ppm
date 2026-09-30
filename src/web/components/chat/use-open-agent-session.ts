/**
 * Opening an agent's or teammate's work session, on whichever presentation the device has.
 *
 * `WindowLayer` renders nothing below the `md` breakpoint, so `openWindow("agent-session")`
 * is a silent no-op on a phone — the tap looked broken. Desktop keeps the floating window,
 * spawning portrait top-right; mobile gets the full-screen sheet. Both host the same content.
 *
 * Every session opens by its own `(sessionId, source)` identity: a second open for the one
 * already showing focuses that window instead of spawning a duplicate. At the window cap the
 * oldest *agent-session* window is replaced — not some unrelated window the user is still
 * using — and if there is no agent-session window to replace, the open is refused instead of
 * silently evicting something else (red-team decision: focus-and-do-nothing is worse).
 */
import { useCallback } from "react";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useWindowStore } from "@/components/floating-window/window-store";
import { MAX_WINDOWS, portraitSpawnRect } from "@/components/floating-window/window-geometry";
import type { ChatEvent } from "../../../types/chat";
import type { AgentSessionWindowPayload } from "./agent-session-window-content";
import { useAgentSessionSheetStore } from "./agent-session-sheet-store";
import { fallbackKey, setFallbackEvents } from "./agent-session-fallback-store";

function samePayloadSource(
  a: Record<string, unknown> | undefined,
  b: AgentSessionWindowPayload,
): boolean {
  const p = a as Partial<AgentSessionWindowPayload> | undefined;
  if (typeof p?.sessionId !== "string" || !p.source) return false;
  return fallbackKey(p.sessionId, p.source) === fallbackKey(b.sessionId, b.source);
}

/** Callback that opens a session the right way for this viewport and the current windows. */
export function useOpenAgentSession(): (payload: AgentSessionWindowPayload, fallbackEvents?: ChatEvent[]) => void {
  const isMobile = useIsMobile();
  const windows = useWindowStore((s) => s.windows);
  const bounds = useWindowStore((s) => s.bounds);
  const openWindow = useWindowStore((s) => s.open);
  const closeWindow = useWindowStore((s) => s.close);
  const focusWindow = useWindowStore((s) => s.focus);
  const openSheet = useAgentSessionSheetStore((s) => s.open);

  return useCallback(
    (payload: AgentSessionWindowPayload, fallbackEvents?: ChatEvent[]) => {
      if (!payload.sessionId) return; // nothing the hub can stream without a session id

      if (fallbackEvents) {
        setFallbackEvents(fallbackKey(payload.sessionId, payload.source), fallbackEvents);
      }

      if (isMobile) {
        openSheet(payload);
        return;
      }

      const asRecord = payload as unknown as Record<string, unknown>;
      const all = Object.values(windows);
      const existing = all.find((w) => w.kind === "agent-session" && samePayloadSource(w.payload, payload));
      if (existing) {
        focusWindow(existing.id);
        return;
      }

      if (all.length >= MAX_WINDOWS) {
        const agentWindows = all.filter((w) => w.kind === "agent-session").sort((a, b) => a.rank - b.rank);
        if (agentWindows.length === 0) {
          toast.error("Too many windows open", { description: "Close one to open this session." });
          return;
        }
        closeWindow(agentWindows[0]!.id);
      }

      const afterClose = Object.values(useWindowStore.getState().windows);
      const rect = portraitSpawnRect(afterClose.map((w) => w.rect), bounds);
      openWindow("agent-session", asRecord, rect);
    },
    [isMobile, windows, bounds, openWindow, closeWindow, focusWindow, openSheet],
  );
}
