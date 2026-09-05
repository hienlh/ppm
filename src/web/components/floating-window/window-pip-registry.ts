/**
 * The one piece of state a floating window's chrome and its body must agree on, for every
 * window kind.
 *
 * The titlebar and the body are DOM siblings rendered by the window frame, not parent and
 * child, so React context cannot bridge them: the titlebar needs the body element to hand it
 * to the PiP host, and the frame needs the resulting handle to show its placeholder. Both
 * live here, keyed by WINDOW id, and both are dropped in the frame's layout cleanup.
 *
 * A tab is a third party — TabPool renders it through a portal into a slot inside the body,
 * so it reads the handle from here too (by panel id) to point its Radix portals at the PiP
 * document instead of the main one.
 */

import { useCallback, useSyncExternalStore } from "react";
import { windowIdFromPanelId } from "@/stores/panel-utils";
import type { PipHandle } from "./pip/pip-host";

const slots = new Map<string, HTMLElement>();
const handles = new Map<string, PipHandle>();
const listeners = new Set<() => void>();

/** Publish (or, with `null`, retract) the body element a window would pop out. */
export function publishWindowSlot(windowId: string, el: HTMLElement | null): void {
  if (el) slots.set(windowId, el);
  else slots.delete(windowId);
}

/** The body element of a mounted window, or null. */
export function windowSlot(windowId: string): HTMLElement | null {
  return slots.get(windowId) ?? null;
}

/** Record the PiP handle a window's body is currently living in (`null` clears it). */
export function setWindowPip(windowId: string, handle: PipHandle | null): void {
  const current = handles.get(windowId) ?? null;
  if (current === handle) return;
  if (handle) handles.set(windowId, handle);
  else handles.delete(windowId);
  for (const notify of listeners) notify();
}

/** The PiP handle for a window, or null when its body is docked in the window. */
export function windowPip(windowId: string | null | undefined): PipHandle | null {
  return windowId ? (handles.get(windowId) ?? null) : null;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Re-renders when the window's PiP handle appears or goes away. */
export function useWindowPip(windowId: string | null | undefined): PipHandle | null {
  const snapshot = useCallback(() => windowPip(windowId), [windowId]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Portal target for a tab rendered into `panelId`: the PiP document's body while that
 * panel's window is popped out, otherwise `undefined` (the document default). Never `null` —
 * Radix reads `null` as "render no portal at all".
 */
export function usePipPortalContainer(panelId: string): HTMLElement | undefined {
  const handle = useWindowPip(windowIdFromPanelId(panelId));
  return handle?.pipWindow.document.body;
}
