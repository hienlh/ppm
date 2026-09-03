import { useEffect, useRef, useState, useCallback } from "react";
import { usePanelStore } from "@/stores/panel-store";
import {
  RUN_IN_TERMINAL_EVENT,
  RUN_IN_TERMINAL_ACK_EVENT,
  type RunInTerminalDetail,
} from "@/lib/run-in-terminal";

interface UseTerminalCommandQueueOptions {
  /** Tab ID — used to drop `pendingCommand` from persisted metadata once consumed. */
  tabId?: string;
  metadata?: Record<string, unknown>;
  /** From `useTerminal` — the shell has printed its prompt and can take input. */
  shellReady: boolean;
  sendData: (data: string) => void;
  focusTerminal: () => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Smallest box treated as a real terminal. Not `> 0`: a terminal parked in the
 * zero-sized tab pool (dock closed, tab inactive) still measures 8×8 from its own
 * padding, and a hidden terminal claiming the command would swallow it silently.
 */
const MIN_VISIBLE_PX = 40;

/** On screen? Must be laid out at a usable size and inside the viewport. */
function isOnScreen(el: HTMLElement | null): boolean {
  if (!el) return false;
  // `visibility: hidden` on the tab pool is the crisp signal where supported.
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) {
    return false;
  }
  const r = el.getBoundingClientRect();
  if (r.width < MIN_VISIBLE_PX || r.height < MIN_VISIBLE_PX) return false;
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

/**
 * Type a command into this terminal, deferred until the shell can accept it.
 *
 * Fed from two directions: `metadata.pendingCommand` on a terminal that was just
 * opened to carry the command, and the `ppm:run-in-terminal` event for a terminal
 * already on screen. Both land in the same one-slot queue, which flushes once
 * `shellReady` turns true — a shell still running its startup files drops
 * anything typed at it, which is why the command cannot be sent on connect.
 *
 * The command is typed WITHOUT a trailing newline: the user reads it and presses
 * Enter. Same semantics as a paste, so a multi-line block behaves like pasting one.
 */
export function useTerminalCommandQueue({
  tabId,
  metadata,
  shellReady,
  sendData,
  focusTerminal,
  containerRef,
}: UseTerminalCommandQueueOptions): void {
  /** Latest command awaiting a ready shell — latest wins, since queued commands
   *  typed back-to-back without a newline would merge into one garbled line. */
  const pendingRef = useRef<string | null>(null);
  /** Incremented per queued command so the flush effect re-runs on repeat clicks. */
  const [revision, setRevision] = useState(0);

  const queue = useCallback((command: string) => {
    pendingRef.current = command;
    setRevision((n) => n + 1);
  }, []);

  // Command handed over by whoever opened this tab. Stripped from the tab's
  // metadata immediately: metadata is persisted to localStorage, and a page
  // reload must not re-inject a command the user already dealt with.
  const pendingCommand = metadata?.pendingCommand;
  useEffect(() => {
    if (typeof pendingCommand !== "string" || !pendingCommand) return;
    queue(pendingCommand);
    if (tabId) {
      const rest = { ...(metadata ?? {}) };
      delete rest.pendingCommand;
      usePanelStore.getState().updateTab(tabId, { metadata: rest });
    }
    // `metadata` is intentionally not a dependency — the strip above already
    // makes this fire exactly once per handed-over command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCommand, tabId, queue]);

  // Claim commands aimed at "whatever terminal the user is looking at".
  useEffect(() => {
    const onRun = (event: Event) => {
      const detail = (event as CustomEvent<RunInTerminalDetail>).detail;
      if (!detail?.command) return;
      if (!isOnScreen(containerRef.current)) return;
      queue(detail.command);
      window.dispatchEvent(new Event(RUN_IN_TERMINAL_ACK_EVENT));
    };
    window.addEventListener(RUN_IN_TERMINAL_EVENT, onRun);
    return () => window.removeEventListener(RUN_IN_TERMINAL_EVENT, onRun);
  }, [containerRef, queue]);

  useEffect(() => {
    if (!shellReady) return;
    const command = pendingRef.current;
    if (!command) return;
    pendingRef.current = null;
    sendData(command);
    focusTerminal();
  }, [shellReady, revision, sendData, focusTerminal]);
}
