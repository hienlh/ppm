/**
 * Centralized mobile detection hook.
 * Returns true when viewport width < 768px (Tailwind md breakpoint).
 * Reactive — updates on window resize.
 */
import { useSyncExternalStore } from "react";

function subscribe(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

function getSnapshot() {
  return typeof window !== "undefined" && window.innerWidth < 768;
}

function getServerSnapshot() {
  return false;
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Non-hook check for use outside React components */
export function isMobileDevice() {
  return typeof window !== "undefined" && window.innerWidth < 768;
}
