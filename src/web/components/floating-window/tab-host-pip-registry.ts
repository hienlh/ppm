/**
 * The one piece of state a tab-host window's chrome and its body must agree on.
 *
 * They are DOM siblings rendered by the window frame, not parent and child, so React
 * context cannot bridge them: the titlebar needs the body's slot element to hand it to the
 * PiP host, and the body needs the resulting handle to show its placeholder. Both live here,
 * keyed by window id, and both are dropped in the body's layout cleanup.
 *
 * The tab itself is a third party — TabPool renders it through a portal into the slot, so it
 * reads the handle from here too (by panel id) to point its Radix portals at the PiP
 * document instead of the main one.
 */

import { useCallback, useSyncExternalStore } from "react";
import { windowIdFromPanelId } from "@/stores/panel-utils";
import type { PipHandle } from "./pip/pip-host";

const slots = new Map<string, HTMLElement>();
const handles = new Map<string, PipHandle>();
const listeners = new Set<() => void>();

/** Publish (or, with `null`, retract) the body's slot element for a window. */
export function publishTabHostSlot(windowId: string, el: HTMLElement | null): void {
  if (el) slots.set(windowId, el);
  else slots.delete(windowId);
}

/** The slot element of a mounted tab-host window body, or null. */
export function tabHostSlot(windowId: string): HTMLElement | null {
  return slots.get(windowId) ?? null;
}

/** Record the PiP handle a window's tab is currently living in (`null` clears it). */
export function setTabHostPip(windowId: string, handle: PipHandle | null): void {
  const current = handles.get(windowId) ?? null;
  if (current === handle) return;
  if (handle) handles.set(windowId, handle);
  else handles.delete(windowId);
  for (const notify of listeners) notify();
}

/** The PiP handle for a window, or null when its tab is docked in the window. */
export function tabHostPip(windowId: string | null | undefined): PipHandle | null {
  return windowId ? (handles.get(windowId) ?? null) : null;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Re-renders when the window's PiP handle appears or goes away. */
export function useTabHostPip(windowId: string | null | undefined): PipHandle | null {
  const snapshot = useCallback(() => tabHostPip(windowId), [windowId]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Portal target for a tab rendered into `panelId`: the PiP document's body while that
 * panel's window is popped out, otherwise `undefined` (the document default). Never `null` —
 * Radix reads `null` as "render no portal at all".
 */
export function usePipPortalContainer(panelId: string): HTMLElement | undefined {
  const handle = useTabHostPip(windowIdFromPanelId(panelId));
  return handle?.pipWindow.document.body;
}
