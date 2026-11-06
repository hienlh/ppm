/**
 * The history window's container: a block of a session's turns, scrolled on its own, laid over the
 * live list (which stays mounted underneath, hidden, still streaming).
 *
 * There is no stick-to-bottom here; this container only moves when the reader moves it or a jump
 * lands. Pages arrive at either end as the reader nears it (sentinels with a 400 px margin, so the
 * next block is usually in before the end is reached), and the place being read is held by
 * element-relative anchoring (`scroll-row-anchor.ts`): the row at the top is measured before a page
 * goes in and put back at the same offset after it is laid out, before paint. While a landing is
 * pinned the pin does that job instead, so the two never both write.
 *
 * Messages here carry only Copy and Copy turn link. A Codex message id names its position in the
 * view that parsed it, so the window's ids (prefixed with their turn by the route) are not the live
 * list's, and Reply, Edit and Fork — which send an id back — are offered only in the live list.
 *
 * The "Loading earlier turns" notice floats over the top rather than sitting above the rows: in the
 * flow it would push the rows being read down by its height the moment it appeared, before any page
 * had arrived to measure against.
 */
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReplyReference } from "../../../shared/chat-reply";
import type { WindowView } from "@/lib/history-window-model";
import type { HistoryWindowControls } from "@/hooks/use-history-window";
import { useScrollAnchorPin } from "@/hooks/use-scroll-anchor-pin";
import { useEdgeSentinels } from "@/hooks/use-edge-sentinels";
import { useHistoryWindowFocus } from "@/hooks/use-history-window-focus";
import { GALLERY_ROOT_ATTR } from "@/lib/image-gallery";
import { MessageRows } from "./message-rows";
import { resolveReplyMessage } from "./message-reply-reference";
import { BackToLatestPill } from "./back-to-latest-pill";
import { HistoryWindowSpinner, LoadErrorBanner, LoadingOlderNotice } from "./history-window-status";
import { flashRow } from "./flash-row";
import { attrSelector, firstVisibleRow, restoreRow, turnStartAt, type RowAnchor } from "./scroll-row-anchor";

export interface HistoryWindowHandle {
  /** Land on a turn the window holds; false when it does not hold it. */
  showTurn(turnId: string): boolean;
  scrollElement(): HTMLDivElement | null;
}

/** What the live list needs to take the reader over at the same place. */
export interface MergeAnchor extends RowAnchor {
  /** The row was pinned by a landing, so the live list should keep it pinned. */
  pinned: boolean;
}

const NO_ORDINALS: number[] = [];

function rendered(m: { role: string; content: string; events?: unknown[] }): boolean {
  const hasContent = !!m.content && m.content.trim().length > 0;
  return m.role === "user" ? hasContent : hasContent || (m.events?.length ?? 0) > 0;
}

/** Memoised: the live list underneath re-renders on every streamed token, and nothing here changes with it. */
export const ChatHistoryWindow = memo(function ChatHistoryWindow({ view, controls, canMerge, onMerge, onBackToLatest, liveActivity, projectName, sessionId, providerId, handleRef }: {
  view: WindowView;
  controls: Pick<HistoryWindowControls, "loadOlder" | "loadNewer" | "retry">;
  /** The live list now holds the window's last turn whole (`canMergeToLive`). */
  canMerge: boolean;
  /** Hand the reader to the live list at `anchor`; false when the live list cannot show it. */
  onMerge: (anchor: MergeAnchor | null) => boolean;
  onBackToLatest: () => void;
  liveActivity: boolean;
  projectName?: string;
  sessionId?: string;
  providerId?: string;
  handleRef?: React.Ref<HistoryWindowHandle>;
}) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((el: HTMLDivElement | null) => { scrollElRef.current = el; setScrollEl(el); }, []);
  // Bumped when the reader takes over from a landing, so the bottom check below runs again.
  const [unpins, setUnpins] = useState(0);
  const pin = useScrollAnchorPin(scrollEl, () => setUnpins((n) => n + 1));
  useHistoryWindowFocus(scrollEl);
  const rows = useMemo(() => view.messages.filter(rendered), [view.messages]);
  const flashCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => flashCleanup.current?.(), []);

  const land = useCallback((row: HTMLElement) => {
    pin.pin(row);
    flashCleanup.current?.();
    flashCleanup.current = flashRow(row);
  }, [pin]);
  const showTurn = useCallback((turnId: string) => {
    const row = scrollElRef.current?.querySelector<HTMLElement>(attrSelector("data-turn-start", turnId));
    if (!row) return false;
    land(row);
    return true;
  }, [land]);
  useImperativeHandle(handleRef, () => ({ showTurn, scrollElement: () => scrollElRef.current }), [showTurn]);

  // The place being read, measured from the DOM as it still is — before this render commits the
  // new rows — the way getSnapshotBeforeUpdate would. Read again only when the rows change.
  const seenMessages = useRef(view.messages);
  const snapshot = useRef<RowAnchor | null>(null);
  if (seenMessages.current !== view.messages) {
    seenMessages.current = view.messages;
    const el = scrollElRef.current;
    snapshot.current = el && el.clientHeight > 0 && !pin.pinned() ? firstVisibleRow(el) : null;
  }
  useLayoutEffect(() => {
    const el = scrollElRef.current;
    if (pin.pinned()) pin.apply();
    else if (el && snapshot.current) restoreRow(el, snapshot.current);
    snapshot.current = null;
  }, [view.messages, pin]);

  // A jump into the window lands on its turn once the rows are laid out; every new jump lands again.
  useLayoutEffect(() => {
    const el = scrollElRef.current;
    if (!el) return;
    const row = el.querySelector<HTMLElement>(attrSelector("data-turn-start", view.targetTurnId))
      ?? el.querySelector<HTMLElement>("[data-msg-id]");
    if (row) land(row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.landing, scrollEl]);

  // The pill names the turn at the top of the viewport.
  const nByTurn = useMemo(() => new Map(view.turns.map((t) => [t.turnId, t.n])), [view.turns]);
  const [topTurn, setTopTurn] = useState<string | null>(view.targetTurnId);
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    let frame = 0;
    const read = () => { frame = 0; const at = turnStartAt(el); if (at) setTopTurn(at.key); };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    el.addEventListener("scroll", onScroll, { passive: true });
    read();
    return () => { el.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, [scrollEl, view.turns]);

  const topRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const { loadOlder, loadNewer, retry } = controls;
  const bottomInView = useEdgeSentinels(scrollEl, topRef, bottomRef, loadOlder,
    `${view.hasOlder}:${view.loadingOlder}:${view.hasNewer}:${view.loadingNewer}:${!!view.loadError}`);

  // At the bottom: hand over to the live list once it holds everything shown here, else read on.
  useEffect(() => {
    const el = scrollElRef.current;
    if (!bottomInView || !el) return;
    if (canMerge) {
      const pinned = pin.pinned();
      const turnId = pinned?.dataset.turnStart;
      const anchor: MergeAnchor | null = pinned && turnId
        ? { key: turnId, offset: pinned.getBoundingClientRect().top - el.getBoundingClientRect().top, pinned: true }
        : (() => { const at = turnStartAt(el); return at ? { ...at, pinned: false } : null; })();
      if (onMerge(anchor)) return;
    }
    if (view.hasNewer && !view.loadingNewer && !view.loadError) loadNewer();
  }, [bottomInView, canMerge, onMerge, pin, view.hasNewer, view.loadingNewer, view.loadError, loadNewer, view.messages, unpins, topTurn]);

  const jumpToReply = useCallback((reply: ReplyReference) => {
    const message = resolveReplyMessage(rows, reply, sessionId, providerId);
    const row = message && scrollElRef.current?.querySelector<HTMLElement>(attrSelector("data-msg-id", message.id));
    if (row) land(row);
  }, [rows, sessionId, providerId, land]);

  const error = view.loadError;
  return (
    <div className="absolute inset-0 flex flex-col bg-background" data-history-window="">
      {error && <LoadErrorBanner error={error} onRetry={retry} />}
      {view.loadingOlder && <LoadingOlderNotice />}
      <div
        ref={setScrollRef}
        {...{ [GALLERY_ROOT_ATTR]: "" }}
        tabIndex={0}
        aria-label="Earlier turns"
        className="flex-1 overflow-y-auto overflow-x-hidden outline-none [overflow-anchor:none] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40"
        style={{ WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}
      >
        <div className="w-full pb-20">
          {view.hasOlder && <div ref={topRef} aria-hidden className="h-px" />}
          <MessageRows
            rows={rows}
            userOrdinals={NO_ORDINALS}
            userOrdinalOffset={0}
            isStreaming={false}
            projectName={projectName}
            sessionId={sessionId}
            providerId={providerId}
            historyPredecessorId={null}
            onJumpToReply={jumpToReply}
          />
          {view.loadingNewer && <HistoryWindowSpinner label="Loading later turns" />}
          <div ref={bottomRef} aria-hidden className="h-px" />
        </div>
      </div>
      <BackToLatestPill turnN={topTurn ? nByTurn.get(topTurn) ?? null : null} liveActivity={liveActivity} onClick={onBackToLatest} />
    </div>
  );
});

