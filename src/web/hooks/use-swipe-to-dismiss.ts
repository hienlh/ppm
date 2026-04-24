/**
 * Hook for swipe-down-to-dismiss gesture on mobile bottom sheets.
 * Returns touch handlers, drag offset, and style helpers.
 */
import { useRef, useCallback, useState } from "react";

const DISMISS_THRESHOLD = 80;

export function useSwipeToDismiss(onDismiss: () => void) {
  const [dragY, setDragY] = useState(0);
  const startYRef = useRef(0);
  const draggingRef = useRef(false);
  const dragYRef = useRef(0);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startYRef.current = e.touches[0]!.clientY;
    draggingRef.current = true;
    dragYRef.current = 0;
    setDragY(0);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!draggingRef.current) return;
    const dy = e.touches[0]!.clientY - startYRef.current;
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
