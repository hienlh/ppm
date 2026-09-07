/**
 * Opens the Remote Desktop viewer: a floating window on desktop, the full-screen mobile sheet
 * below `md` (`WindowLayer` renders nothing there — same split `open-explorer.ts` makes for the
 * file explorer). There is one host to control, so a second call on desktop focuses the
 * existing window instead of opening another; on mobile the sheet is a singleton already.
 */
import { useCallback } from "react";
import { useWindowStore } from "@/components/floating-window/window-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { useRemoteDesktopMobileOpenState } from "./use-remote-desktop-mobile-open-state";

export function useOpenRemoteDesktop(): () => void {
  const openWindow = useWindowStore((s) => s.open);
  const focusWindow = useWindowStore((s) => s.focus);
  const openMobileSheet = useRemoteDesktopMobileOpenState((s) => s.open);

  return useCallback(() => {
    if (isMobileDevice()) {
      openMobileSheet();
      return;
    }
    const existing = Object.values(useWindowStore.getState().windows).find((w) => w.kind === "remote-desktop");
    if (existing) focusWindow(existing.id);
    else openWindow("remote-desktop");
  }, [openWindow, focusWindow, openMobileSheet]);
}
