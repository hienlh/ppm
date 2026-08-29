/**
 * Drag-to-select for xterm on touch devices.
 *
 * xterm has no touch selection at all: `SelectionService` is driven by a
 * `mousedown` on the `.xterm` element followed by `mousemove`/`mouseup` on the
 * owning document, and nothing translates touch into those. This hook feeds it
 * synthetic mouse events from a one-finger drag, so selection, its highlight and
 * `term.getSelection()` all behave exactly as they do with a mouse.
 *
 * Only active while the caller has select mode switched on — the same gesture
 * otherwise scrolls the viewport, and silently stealing it would strand the user
 * with no way to scroll back.
 */
import { useEffect, type RefObject } from "react";

function mouseEventFrom(type: string, touch: Touch, buttons: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: touch.clientX,
    clientY: touch.clientY,
    screenX: touch.screenX,
    screenY: touch.screenY,
    button: 0,
    buttons,
    // Click count. xterm branches on it to pick single/word/line selection and
    // ignores the event entirely at the default of 0, so a drag would start no
    // selection at all without this.
    detail: 1,
  });
}

export function useTerminalTouchSelection(
  containerRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    // `.xterm` is where SelectionService listens for mousedown; dispatching on
    // the screen element would work too but this keeps the target explicit.
    const xterm = container.querySelector(".xterm");
    if (!xterm) return;

    // Capture phase so these run before xterm's own document-level touch
    // gesture handler, and stopPropagation keeps that handler from scrolling
    // the viewport out from under the drag.
    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch || e.touches.length > 1) return;
      e.preventDefault();
      e.stopPropagation();
      xterm.dispatchEvent(mouseEventFrom("mousedown", touch, 1));
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(mouseEventFrom("mousemove", touch, 1));
    };

    const onTouchEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0];
      if (!touch) return;
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(mouseEventFrom("mouseup", touch, 0));
    };

    const opts = { capture: true, passive: false } as const;
    container.addEventListener("touchstart", onTouchStart, opts);
    container.addEventListener("touchmove", onTouchMove, opts);
    container.addEventListener("touchend", onTouchEnd, opts);
    container.addEventListener("touchcancel", onTouchEnd, opts);

    return () => {
      container.removeEventListener("touchstart", onTouchStart, opts);
      container.removeEventListener("touchmove", onTouchMove, opts);
      container.removeEventListener("touchend", onTouchEnd, opts);
      container.removeEventListener("touchcancel", onTouchEnd, opts);
    };
  }, [containerRef, enabled]);
}
