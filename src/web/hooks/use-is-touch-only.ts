/**
 * A device whose primary pointer is a finger.
 *
 * `useIsMobile` asks how wide the viewport is, which is the right question for a layout and
 * the wrong one for a device: a desktop browser narrowed to half the screen is still a
 * desktop, and a tablet in landscape is still a tablet. Anything deciding what a *machine*
 * should be asked to do — starting a language server that was 854 MB resident — belongs here,
 * because the answer must not change when a window is dragged narrower. It did: the editor
 * tore its language server down at 767px and cold-started a new one on the way back.
 *
 * `hover: none` is the same test `use-inline-blame.ts` uses for the tap-to-open path, and
 * `pointer: coarse` alongside it is what keeps a desktop with a touchscreen on the desktop
 * answer — browsers report the *primary* pointer there, which is still the mouse.
 */
import { useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse) and (hover: none)";

function query(): MediaQueryList | null {
  return typeof window !== "undefined" && window.matchMedia ? window.matchMedia(QUERY) : null;
}

function subscribe(cb: () => void): () => void {
  const list = query();
  // A device does not usually change category mid-session, but a tablet gaining a trackpad
  // does — and Safari only gained `addEventListener` on MediaQueryList in 14.
  list?.addEventListener?.("change", cb);
  return () => list?.removeEventListener?.("change", cb);
}

function getSnapshot(): boolean {
  return query()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIsTouchOnly(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Non-hook check, for code that runs outside a component. */
export function isTouchOnlyDevice(): boolean {
  return getSnapshot();
}
