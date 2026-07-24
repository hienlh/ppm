/**
 * Hook for swipe-down-to-dismiss gesture on mobile bottom sheets.
 * Returns touch handlers, drag offset, and style helpers.
 */
import { useRef, useCallback, useState } from "react";

const DISMISS_THRESHOLD = 80;

/** Nearest scrollable ancestor of `start` (within the sheet) that can actually scroll. */
function findScrollableParent(start: HTMLElement | null): HTMLElement | null {
  let el = start;
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

export function useSwipeToDismiss(onDismiss: () => void) {
  const [dragY, setDragY] = useState(0);
  const startYRef = useRef(0);
  const draggingRef = useRef(false);
  const dragYRef = useRef(0);
  const scrollElRef = useRef<HTMLElement | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startYRef.current = e.touches[0]!.clientY;
    draggingRef.current = true;
    dragYRef.current = 0;
    scrollElRef.current = findScrollableParent(e.target as HTMLElement);
    setDragY(0);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!draggingRef.current) return;
    // If the gesture is inside a scroll area that isn't at the top, let it scroll
    // natively instead of dragging the sheet — otherwise scrolling back up from
    // the bottom would dismiss the sheet instead of scrolling the list.
    const currentY = e.touches[0]!.clientY;
    const scrollEl = scrollElRef.current;
    if (scrollEl && scrollEl.scrollTop > 0) {
      // Content is still scrolling — rebase the start so the dismiss drag is only
      // measured from the moment the list reaches the top, not from touch start.
      // Without this, a single long swipe that scrolls to the top would then
      // register a large drag and dismiss the sheet.
      startYRef.current = currentY;
      if (dragYRef.current !== 0) { dragYRef.current = 0; setDragY(0); }
      return;
    }
    const dy = currentY - startYRef.current;
    const val = Math.max(0, dy);
    dragYRef.current = val;
    setDragY(val);
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (dragYRef.current >= DISMISS_THRESHOLD) {
      onDismiss();
    }
    dragYRef.current = 0;
    setDragY(0);
  }, [onDismiss]);

  return {
    dragY,
    swipeHandlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
    dragStyle: dragY > 0 ? { transform: `translateY(${dragY}px)` } as const : undefined,
    backdropOpacity: dragY > 0 ? Math.max(0, 1 - dragY / 300) : 1,
    isDragging: dragY > 0,
  };
}
