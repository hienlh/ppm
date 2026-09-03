/**
 * Opening a teammate's work session, on whichever presentation the device has.
 *
 * `WindowLayer` renders nothing below the `md` breakpoint, so `openWindow("team-member")`
 * is a silent no-op on a phone — the tap looked broken. Desktop keeps the floating window;
 * mobile gets the full-screen sheet, both hosting the same content component.
 */

import { useCallback } from "react";
import { create } from "zustand";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useWindowStore } from "@/components/floating-window/window-store";
import type { TeamMemberWindowPayload } from "./team-member-window-content";

interface TeamMemberSheetState {
  payload: TeamMemberWindowPayload | null;
  open: (payload: TeamMemberWindowPayload) => void;
  close: () => void;
}

/** Mobile-only: which teammate the full-screen sheet is showing, if any. */
export const useTeamMemberSheet = create<TeamMemberSheetState>((set) => ({
  payload: null,
  open: (payload) => set({ payload }),
  close: () => set({ payload: null }),
}));

/** Callback that opens a teammate's session the right way for this viewport. */
export function useOpenTeamMember(): (payload: TeamMemberWindowPayload) => void {
  const isMobile = useIsMobile();
  const openWindow = useWindowStore((s) => s.open);
  const openSheet = useTeamMemberSheet((s) => s.open);

  return useCallback(
    (payload: TeamMemberWindowPayload) => {
      if (isMobile) openSheet(payload);
      else openWindow("team-member", payload as unknown as Record<string, unknown>);
    },
    [isMobile, openSheet, openWindow],
  );
}
