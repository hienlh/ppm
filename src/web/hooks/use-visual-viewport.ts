/**
 * Measures the part of the screen the user can actually see, and how much of it
 * the on-screen keyboard is occupying.
 *
 * `vh`/`dvh` units and a `fixed` element both resolve against the layout
 * viewport, which does not shrink when a keyboard opens — so anything anchored
 * to the bottom ends up behind it. Only `visualViewport` reports the truth.
 *
 * Updates are applied on the frame they arrive rather than after a settle
 * delay: iOS emits intermediate sizes throughout the keyboard's slide and its
 * final event can land before the layout has finished moving, so deferring is
 * what leaves geometry stale — visibly, as a strip of untouched page below a
 * panel that should be flush with the keyboard.
 */
import { useEffect, useState } from "react";

export interface ViewportInsets {
  /** Height of the visible area, in px. */
  height: number;
  /** Distance from the top of the layout viewport to the visible area. */
  offsetTop: number;
  /** Whether the missing height is big enough to be a keyboard, not browser chrome. */
  keyboardOpen: boolean;
}

/** Below this, the missing height is a collapsed address bar, not a keyboard. */
const KEYBOARD_MIN_INSET = 120;

function measure(viewport: VisualViewport): ViewportInsets {
  return {
    height: viewport.height,
    offsetTop: viewport.offsetTop,
    // Only a threshold, never a position: `innerHeight` on iOS counts space
    // behind browser chrome that a `fixed` element cannot reach, so it is too
    // unreliable to place anything with.
    keyboardOpen: window.innerHeight - viewport.height - viewport.offsetTop >= KEYBOARD_MIN_INSET,
  };
}

/** Live viewport insets, or null when unsupported or while `active` is false. */
export function useVisualViewport(active: boolean): ViewportInsets | null {
  const [insets, setInsets] = useState<ViewportInsets | null>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) {
      setInsets(null);
      return;
    }

    // Several resize/scroll events can fire per frame; one read per frame is
    // enough and keeps React from rendering the same geometry repeatedly.
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setInsets((prev) => {
        const next = measure(viewport);
        return prev && prev.height === next.height && prev.offsetTop === next.offsetTop
          ? prev
          : next;
      });
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };

    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
    };
  }, [active]);

  return insets;
}
