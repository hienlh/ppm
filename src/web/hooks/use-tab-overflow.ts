import { useState, useEffect, useCallback, type RefObject } from "react";

interface TabOverflow {
  canScrollLeft: boolean;
  canScrollRight: boolean;
  scrollLeft: () => void;
  scrollRight: () => void;
}

/**
 * Detects overflow on a scrollable tab container and provides scroll helpers.
 * Uses scroll events + ResizeObserver for accurate, performant updates.
 */
export function useTabOverflow(scrollRef: RefObject<HTMLDivElement | null>): TabOverflow {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScroll();
    el.addEventListener("scroll", updateScroll, { passive: true });
    const ro = new ResizeObserver(updateScroll);
    ro.observe(el);
    // Also observe children changes (tabs added/removed)
    const mo = new MutationObserver(updateScroll);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", updateScroll);
      ro.disconnect();
      mo.disconnect();
    };
  }, [scrollRef, updateScroll]);

  const scrollLeft = useCallback(() => {
    scrollRef.current?.scrollBy({ left: -150, behavior: "smooth" });
  }, [scrollRef]);

  const scrollRight = useCallback(() => {
    scrollRef.current?.scrollBy({ left: 150, behavior: "smooth" });
  }, [scrollRef]);

  return { canScrollLeft, canScrollRight, scrollLeft, scrollRight };
}

/** Priority for picking most urgent type */
const TYPE_PRIORITY: Record<string, number> = { done: 0, question: 1, approval_request: 2 };

/**
 * Check if any hidden (off-screen) tab has unread notifications.
 * Returns the most urgent notification type per direction (null = none).
 */
export function getHiddenUnreadDirection(
  scrollEl: HTMLDivElement | null,
  tabRefs: Map<string, HTMLElement>,
  tabs: { id: string; type: string; metadata?: Record<string, unknown> }[],
  notifications: Map<string, { count: number; type: string }>,
): { left: string | null; right: string | null } {
  if (!scrollEl) return { left: null, right: null };
  const viewLeft = scrollEl.scrollLeft;
  const viewRight = viewLeft + scrollEl.clientWidth;
  let leftType: string | null = null;
  let leftPri = -1;
  let rightType: string | null = null;
  let rightPri = -1;

  for (const tab of tabs) {
    if (tab.type !== "chat") continue;
    const sessionId = tab.metadata?.sessionId as string;
    const entry = sessionId ? notifications.get(sessionId) : undefined;
    if (!entry || entry.count === 0) continue;
    const tabEl = tabRefs.get(tab.id);
    if (!tabEl) continue;
    const pri = TYPE_PRIORITY[entry.type] ?? 0;
    if (tabEl.offsetLeft + tabEl.offsetWidth < viewLeft && pri > leftPri) {
      leftPri = pri; leftType = entry.type;
    }
    if (tabEl.offsetLeft > viewRight && pri > rightPri) {
      rightPri = pri; rightType = entry.type;
    }
  }

  return { left: leftType, right: rightType };
}
