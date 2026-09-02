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
  explorer: lazy(() => import("./explorer-window-placeholder")),
};

/** Titlebar text for a window. Falls back to the kind's generic name. */
export function windowTitle(kind: WindowKind, payload?: Record<string, unknown>): string {
  const explicit = payload?.title;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const path = payload?.path;
  if (kind === "explorer" && typeof path === "string" && path) {
    const segments = path.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? path;
  }
  return "Explorer";
}
