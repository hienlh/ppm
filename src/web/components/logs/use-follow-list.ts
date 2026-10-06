/**
 * A log list that follows new lines while it is scrolled to the end, stops the moment the
 * person scrolls up, and counts what arrives meanwhile for the "N new lines" pill. Coming back
 * from another sub-tab, a list that was not following opens where it was left, rather than at
 * its oldest line. Shared by the desktop list and the phone's.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { LogsFeed } from "./use-logs-feed";

/** Within this of the end counts as at the end, and following resumes. */
const AT_END_PX = 24;
/** A scroll the list made itself is not the person scrolling away. */
const PROGRAMMATIC_MS = 200;

export function useFollowList(
  listRef: RefObject<HTMLElement | null>,
  { follow, setFollow, feed, size, virtualizer, keep }: {
    follow: boolean;
    setFollow(follow: boolean): void;
    feed: Pick<LogsFeed, "key" | "batch">;
    /** Anything that moves the end: the list's total height, its item count. */
    size: number;
    virtualizer: Virtualizer<HTMLDivElement, Element>;
    /** The key of the item at the top when the list was last shown, kept by the shell. */
    keep: MutableRefObject<string | null>;
  },
) {
  const progUntil = useRef(0);
  const [newCount, setNewCount] = useState(0);

  /** Marks the next `ms` of scrolling as the list's own. */
  const ownScroll = useCallback((ms = PROGRAMMATIC_MS) => {
    progUntil.current = performance.now() + ms;
  }, []);

  const scrollToBottom = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    ownScroll();
    list.scrollTop = list.scrollHeight;
  }, [listRef, ownScroll]);

  // Once per mount: put back where the previous mount was left, and remember where this one is.
  useLayoutEffect(() => {
    const key = keep.current;
    if (key != null && !follow) {
      const { count, getItemKey } = virtualizer.options;
      for (let i = 0; i < count; i++) {
        if (getItemKey(i) !== key) continue;
        ownScroll();
        virtualizer.scrollToIndex(i, { align: "start" });
        break;
      }
    }
    return () => {
      const top = virtualizer.getVirtualItemForOffset(virtualizer.scrollOffset ?? 0);
      keep.current = top ? String(top.key) : null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Following: anything that changes how tall the list is pins it to the end again.
  useLayoutEffect(() => {
    if (follow) scrollToBottom();
  }, [follow, size, scrollToBottom]);

  // A different filter is a different list: nothing in it is new yet.
  useEffect(() => setNewCount(0), [feed.key]);

  useEffect(() => {
    if (follow) setNewCount(0);
  }, [follow]);

  const batch = feed.batch;
  useEffect(() => {
    if (batch && !follow) setNewCount((n) => n + batch.count);
    // A batch is counted once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.seq]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list || performance.now() < progUntil.current) return;
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < AT_END_PX;
    if (atEnd !== follow) setFollow(atEnd);
  }, [listRef, follow, setFollow]);

  return { newCount, onScroll, ownScroll };
}
