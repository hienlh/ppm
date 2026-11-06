/**
 * Takes up a "show this place" request for one chat (`chat-jump-store.ts`): a call's card or the
 * prompt that asked for it (the Review tab), or the start of a turn (a turn chip, a `?turn=` link).
 *
 * Where it lands depends on which container the reader is looking at:
 * - **Live list.** A turn already drawn is pinned 16 px from the top (follow-to-bottom stopped
 *   first) and flashed. A turn not loaded opens the history window around it. A call or a message
 *   that is not drawn falls back to its turn when the request names one (the Review tab does), so
 *   an old turn opens the window instead of waiting for pages that will not come.
 * - **History window.** Every request goes to the window — the live list underneath is hidden and
 *   is never the target. A call the window draws is shown there; otherwise a request naming a turn
 *   is pinned there when the window holds it, and refetches the window around it when not; one
 *   naming no turn leaves the window, and the next attempt looks for it in the live list.
 *
 * The wait for the place to appear is counted from when the chat is on screen with its history
 * in, not from the click, so a tab still opening — another project's, over a slow tunnel — is not
 * given up on before it could look; a request nothing takes up within a minute is dropped anyway.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ChatMessage } from "../../types/chat";
import { requestIsFor, useChatJumpStore } from "@/stores/chat-jump-store";
import { jumpToEdit, resolveAnchor } from "@/components/chat/jump-to-edit";
import { flashRow } from "@/components/chat/flash-row";
import { attrSelector } from "@/components/chat/scroll-row-anchor";
import type { HistoryWindowHandle } from "@/components/chat/chat-history-window";
import type { HistoryWindowControls } from "./use-history-window";
import type { AnchorPinHandle } from "./use-scroll-anchor-pin";

/** How long a request waits for its place, counted from when this chat is on screen with its history in. */
const CHAT_JUMP_GIVE_UP_MS = 8_000;
/** The longest a request waits in all, for a tab that never shows or never finishes loading. */
const CHAT_JUMP_MAX_WAIT_MS = 60_000;
const RETRY_MS = 150;

export function useChatTurnJump(p: {
  sessionId?: string;
  /** The live list's scroll container. */
  scrollEl: HTMLDivElement | null;
  filtered: ChatMessage[];
  messagesLoading?: boolean;
  stopScroll: () => void;
  /** Jump to a call's card in the live list. */
  handleJumpToEdit: (editRef: string) => void;
  /** Scroll to and flash the live list's row at an index; false when it is not drawn. */
  showMessageAt: (index: number) => boolean;
  livePin: AnchorPinHandle;
  history: HistoryWindowControls;
  windowHandle: React.RefObject<HistoryWindowHandle | null>;
}): void {
  const { sessionId, scrollEl, filtered, messagesLoading, stopScroll, handleJumpToEdit, showMessageAt, livePin, history, windowHandle } = p;
  const jumpRequest = useChatJumpStore((s) => (requestIsFor(s.request, sessionId, s.aliases) ? s.request : null));
  // When this chat was first on screen with its history in, for the request being served.
  const readySince = useRef<{ request: object; at: number } | null>(null);
  // The request whose window is being fetched: its answer, not another attempt, settles it.
  const opening = useRef<object | null>(null);
  const flashCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => flashCleanup.current?.(), []);
  const inWindow = history.view.mode === "window";
  const { open, exit, canOpen } = history;

  useEffect(() => {
    if (!jumpRequest || !scrollEl || opening.current === jumpRequest) return;
    const request = jumpRequest;
    const finish = () => useChatJumpStore.getState().done(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const container = inWindow ? windowHandle.current?.scrollElement() ?? null : scrollEl;
    const visible = () => !!container && container.clientHeight > 0;
    const giveUp = () => {
      const now = Date.now();
      if (visible() && !messagesLoading && readySince.current?.request !== request) readySince.current = { request, at: now };
      const ready = readySince.current?.request === request ? readySince.current.at : null;
      return (ready !== null && now - ready > CHAT_JUMP_GIVE_UP_MS) || now - request.at > CHAT_JUMP_MAX_WAIT_MS;
    };
    const land = (row: HTMLElement) => {
      livePin.pin(row);
      flashCleanup.current?.();
      flashCleanup.current = flashRow(row);
    };
    const openWindow = (turnId: string) => {
      opening.current = request;
      void open(turnId).then((result) => {
        if (opening.current === request) opening.current = null;
        if (result === "gone") toast.error("This turn is no longer available");
        else if (result === "failed") toast.error("Could not load this turn");
        finish();
      });
    };
    const attempt = (): void => {
      const call = request.toolUseId && `${request.toolUseId}-0`;
      if (container && visible()) {
        if (inWindow) {
          if (call && resolveAnchor(container, call)) {
            flashCleanup.current?.();
            flashCleanup.current = jumpToEdit(container, call);
            return finish();
          }
          if (request.turnId) {
            if (windowHandle.current?.showTurn(request.turnId)) return finish();
            return openWindow(request.turnId);
          }
          // A place the window does not hold: the live list looks for it once it is back.
          return exit();
        }
        if (call && resolveAnchor(container, call)) {
          stopScroll();
          handleJumpToEdit(call);
          return finish();
        }
        if (request.messageId) {
          const index = filtered.findIndex((m) => m.id === request.messageId);
          if (index >= 0 && showMessageAt(index)) return finish();
        }
        if (request.turnId) {
          const row = container.querySelector<HTMLElement>(attrSelector("data-turn-start", request.turnId));
          if (row) {
            stopScroll();
            land(row);
            return finish();
          }
          // Not loaded here: read it from the turn index instead of waiting for pages to reach it.
          if (!messagesLoading && canOpen) return openWindow(request.turnId);
        }
      }
      if (giveUp()) return finish();
      timer = setTimeout(attempt, RETRY_MS);
    };
    attempt();
    return () => clearTimeout(timer);
  }, [jumpRequest, scrollEl, filtered, messagesLoading, inWindow, open, exit, canOpen, stopScroll, handleJumpToEdit, showMessageAt, livePin, windowHandle]);
}
