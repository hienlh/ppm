/**
 * Maps a window `kind` to the component that fills its body.
 *
 * The registry is the only coupling point between the generic window layer and real
 * features: adding a kind means adding an entry here plus a title resolver, and nothing in
 * the frame, store or gestures changes. Entries are lazy so a window's content (and its
 * icon/virtualisation deps) never lands in the initial bundle.
 */

import { lazyWithPreload, type PreloadableComponent } from "@/lib/lazy-with-preload";
import type { WindowKind } from "./window-store-types";

export interface WindowContentProps {
  /** Window id — content may call the store to close/retitle itself. */
  id: string;
  /** Kind-specific state persisted with the window (e.g. the explorer's current path). */
  payload?: Record<string, unknown>;
}

export const WINDOW_CONTENT: Record<WindowKind, PreloadableComponent<WindowContentProps>> = {
  explorer: lazyWithPreload(() => import("@/components/os-explorer/explorer-window-content")),
  "agent-session": lazyWithPreload(() => import("@/components/chat/agent-session-window-content")),
  "system-monitor": lazyWithPreload(() => import("@/components/system/system-monitor-window-content")),
  "tab-host": lazyWithPreload(() => import("./tab-host-window-content")),
  "remote-desktop": lazyWithPreload(() => import("@/components/remote-desktop/remote-desktop-window-content")),
  settings: lazyWithPreload(() => import("@/components/settings/settings-window-content")),
  logs: lazyWithPreload(() => import("@/components/logs/logs-window-content")),
};

/** Titlebar text for a window. Falls back to the kind's generic name. */
export function windowTitle(kind: WindowKind, payload?: Record<string, unknown>): string {
  const explicit = payload?.title;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  // Every agent-session window is opened with an explicit title (member name or card
  // description) by its opener, so this only fires for a malformed/legacy payload.
  if (kind === "agent-session") return "Agent session";
  if (kind === "system-monitor") return "System Monitor";
  if (kind === "remote-desktop") return "Remote Desktop";
  if (kind === "settings") return "Settings";
  if (kind === "logs") return "Logs";
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
