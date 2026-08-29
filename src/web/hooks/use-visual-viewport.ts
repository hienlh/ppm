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
  /**
   * Roughly how much the keyboard covers, in px.
   *
   * Approximate on purpose: `innerHeight` on iOS counts space behind browser
   * chrome, so this can be off by a bar's height. Use it to inset content, never
   * to place a background — an inset that is slightly wrong shifts content a
   * little, whereas a background placed the same way leaves a visible hole.
   */
  keyboardInset: number;
  /** Whether the missing height is big enough to be a keyboard, not browser chrome. */
  keyboardOpen: boolean;
}

/** Below this, the missing height is a collapsed address bar, not a keyboard. */
const KEYBOARD_MIN_INSET = 120;

function measure(viewport: VisualViewport): ViewportInsets {
  const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  return {
    height: viewport.height,
    keyboardInset: inset,
    keyboardOpen: inset >= KEYBOARD_MIN_INSET,
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
        return prev && prev.height === next.height && prev.keyboardInset === next.keyboardInset
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
