/**
 * Maps a window `kind` to the component that fills its body.
 *
 * The registry is the only coupling point between the generic window layer and real
 * features: adding a kind means adding an entry here plus a title resolver, and nothing in
 * the frame, store or gestures changes. Entries are lazy so a window's content (and its
 * icon/virtualisation deps) never lands in the initial bundle.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { WindowKind } from "./window-store-types";

export interface WindowContentProps {
  /** Window id — content may call the store to close/retitle itself. */
  id: string;
  /** Kind-specific state persisted with the window (e.g. the explorer's current path). */
  payload?: Record<string, unknown>;
}

export const WINDOW_CONTENT: Record<WindowKind, LazyExoticComponent<ComponentType<WindowContentProps>>> = {
  explorer: lazy(() => import("@/components/os-explorer/explorer-window-content")),
  "team-member": lazy(() => import("@/components/chat/team-member-window-content")),
  "system-monitor": lazy(() => import("@/components/system/system-monitor-window-content")),
  "tab-host": lazy(() => import("./tab-host-window-content")),
};

/** Titlebar text for a window. Falls back to the kind's generic name. */
export function windowTitle(kind: WindowKind, payload?: Record<string, unknown>): string {
  const explicit = payload?.title;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  if (kind === "team-member") {
    const member = payload?.memberName;
    return typeof member === "string" && member ? `Session — ${member}` : "Team member";
  }
  if (kind === "system-monitor") return "System Monitor";
  // A detached tab carries its title in the payload; the generic name only shows for a
  // window whose tab has not been resolved yet (restore before the layout is loaded).
  if (kind === "tab-host") return "Tab";
  const path = payload?.path;
  if (kind === "explorer" && typeof path === "string" && path) {
    const segments = path.split(/[\\/]/).filter(Boolean);
    // A drive or POSIX root has no last segment worth showing; the raw path is the name.
    return segments[segments.length - 1] ?? path;
  }
  return "Explorer";
}
