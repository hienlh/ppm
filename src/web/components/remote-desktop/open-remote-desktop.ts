/**
 * Opens the Remote Desktop floating window. Desktop-only for this slice (no mobile tab
 * route — `WindowLayer` renders nothing below `md`, matching the plan's scope). There is one
 * host to control, so a second click focuses the existing window instead of opening another.
 */
import { useCallback } from "react";
import { useWindowStore } from "@/components/floating-window/window-store";

export function useOpenRemoteDesktop(): () => void {
  const openWindow = useWindowStore((s) => s.open);
  const focusWindow = useWindowStore((s) => s.focus);

  return useCallback(() => {
    const existing = Object.values(useWindowStore.getState().windows).find((w) => w.kind === "remote-desktop");
    if (existing) focusWindow(existing.id);
    else openWindow("remote-desktop");
  }, [openWindow, focusWindow]);
}
