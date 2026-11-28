/**
 * Multi-touch gesture engine for the mobile remote-desktop viewer: pinch-zoom/pan (CSS
 * transform on the caller's "stage" element) plus tap/drag → pointer + wheel messages over the
 * shared connection. Two modes (see design doc `research-260907-1538-remote-desktop-mobile-
 * touch.md`): TOUCH maps a 1-finger drag straight to an absolute drag at the touch point;
 * MOUSE keeps a client-side virtual cursor that a 1-finger drag moves *relatively*, with a tap
 * clicking wherever the cursor currently sits. Two-finger gestures are shared by both modes:
 * tap = right click (at the cursor in MOUSE mode, between the fingers in TOUCH mode), pinch =
 * zoom, drag = pan (while zoomed) or scroll wheel (otherwise). One finger held still for
 * `LONG_PRESS_MS` is also a right click, aimed like a tap, and the toolbar's Right click button
 * turns the next one-finger tap into one. The
 * actual decision rules live in `remote-desktop-touch-gesture-tracker.ts`; this file only wires
 * DOM touch events to them and to React state.
 *
 * All touch listeners are native (`addEventListener`, non-passive) rather than React props, so
 * `stopPropagation()` here also stops the ancestor `BottomSheet`'s swipe-to-dismiss (a React
 * synthetic handler) from ever seeing the event — same trick `mobile-explorer-sheet.tsx` uses
 * for its inline-rename case.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { letterboxedContentRect, type ZoomPanTransform, type Fraction, type Rect } from "./remote-desktop-coords";
import {
  beginSingleTouch, advanceSingleTouch, resolveSingleTouchEnd, resolveLongPress,
  beginTwoFingerTouch, advanceTwoFingerTouch, resolveTwoFingerEnd, LONG_PRESS_MS,
  type SingleTrack, type TwoFingerTrack, type RemoteDesktopInputMode,
} from "./remote-desktop-touch-gesture-tracker";

export type { RemoteDesktopInputMode };

const IDENTITY_TRANSFORM: ZoomPanTransform = { scale: 1, panX: 0, panY: 0 };
/** CSS px of two-finger drag per wheel notch (`WHEEL_DELTA` = 120 units, matching a real wheel
 *  "click"). Tune here if a live test finds scrolling too fast/slow. */
const WHEEL_PIXELS_PER_NOTCH = 40;
const WHEEL_DELTA = 120;
/** How long the ring marking where a right click landed stays on screen. */
const CLICK_FEEDBACK_MS = 450;

/** Where a right click just landed, as a fraction of the capture; `id` changes per click so the
 *  ring restarts even when two land on the same spot. */
export interface ClickFeedback {
  at: Fraction;
  id: number;
}

function rightClickTarget(msgs: Record<string, unknown>[]): Fraction | null {
  const first = msgs[0];
  if (!first || first.button !== "right") return null;
  return { xFrac: first.xFrac as number, yFrac: first.yFrac as number };
}

/** A short buzz to say a long press registered. Absent on iOS Safari, and some browsers throw
 *  before the user has interacted with the page; neither is worth more than no buzz. */
function buzz(): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(30);
  } catch { /* no vibration available */ }
}

export interface UseRemoteDesktopTouchOptions {
  /** The never-transformed element touch listeners attach to and whose rect is the reference
   *  frame at `scale=1, pan=0` — must fill the same box the "stage" (canvas) sits in at rest. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** The canvas actually being drawn into. Its CSS box is the same size as `containerRef` (it
   *  fills the stage, which fills the container), but its drawing-buffer size (`.width`/
   *  `.height`, the real capture resolution) is almost never the same *aspect ratio* — a tap
   *  must be measured against the letterboxed video rect this produces inside the container,
   *  not the container's full box, or it lands off by however big the letterbox bars are. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  mode: RemoteDesktopInputMode;
  sendMessage: (msg: Record<string, unknown>) => void;
  enabled: boolean;
  /** The toolbar's Right click button is on: the next one-finger tap right-clicks. */
  rightClickArmed?: boolean;
  /** Called once a tap or long press has used the armed right click, so the button turns off. */
  onRightClickUsed?: () => void;
}

export interface UseRemoteDesktopTouchResult {
  /** Apply as `transform: translate(panXpx, panYpx) scale(scale)` on the stage element. */
  transform: ZoomPanTransform;
  /** Client-side cursor position (mouse mode only) — draw a marker at this fraction inside the
   *  stage. `null` in touch mode (no persistent cursor concept there). */
  virtualCursor: Fraction | null;
  /** Where the last right click landed, for a brief ring; null once it has faded. */
  clickFeedback: ClickFeedback | null;
  resetZoom: () => void;
}

export function useRemoteDesktopTouch({
  containerRef,
  canvasRef,
  mode,
  sendMessage,
  enabled,
  rightClickArmed = false,
  onRightClickUsed,
}: UseRemoteDesktopTouchOptions): UseRemoteDesktopTouchResult {
  const [transform, setTransform] = useState<ZoomPanTransform>(IDENTITY_TRANSFORM);
  const [virtualCursor, setVirtualCursor] = useState<Fraction>({ xFrac: 0.5, yFrac: 0.5 });
  const transformRef = useRef(transform);
  const cursorRef = useRef(virtualCursor);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const armedRef = useRef(rightClickArmed);
  armedRef.current = rightClickArmed;
  const onRightClickUsedRef = useRef(onRightClickUsed);
  onRightClickUsedRef.current = onRightClickUsed;

  const [clickFeedback, setClickFeedback] = useState<ClickFeedback | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackIdRef = useRef(0);
  const showClickFeedback = useCallback((at: Fraction) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackIdRef.current += 1;
    setClickFeedback({ at, id: feedbackIdRef.current });
    feedbackTimerRef.current = setTimeout(() => { feedbackTimerRef.current = null; setClickFeedback(null); }, CLICK_FEEDBACK_MS);
  }, []);
  useEffect(() => () => { if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current); }, []);

  const pendingRef = useRef<{ transform: ZoomPanTransform | null; cursor: Fraction | null; sendCursorMove: boolean; wheelPx: number }>(
    { transform: null, cursor: null, sendCursorMove: false, wheelPx: 0 },
  );
  const rafIdRef = useRef(0);

  const flush = useCallback(() => {
    rafIdRef.current = 0;
    const p = pendingRef.current;
    if (p.transform) { transformRef.current = p.transform; setTransform(p.transform); p.transform = null; }
    if (p.cursor) {
      cursorRef.current = p.cursor;
      setVirtualCursor(p.cursor);
      if (p.sendCursorMove) sendMessage({ type: "pointer", xFrac: p.cursor.xFrac, yFrac: p.cursor.yFrac, button: null, down: null });
      p.cursor = null;
      p.sendCursorMove = false;
    }
    if (p.wheelPx !== 0) {
      // Fingers moving up (negative px) reads as "scroll content up" — a positive (forward)
      // wheel notch, matching a physical wheel rotated away from the user.
      sendMessage({ type: "wheel", dy: -(p.wheelPx / WHEEL_PIXELS_PER_NOTCH) * WHEEL_DELTA });
      p.wheelPx = 0;
    }
  }, [sendMessage]);

  const schedule = useCallback(() => {
    if (!rafIdRef.current) rafIdRef.current = requestAnimationFrame(flush);
  }, [flush]);

  const resetZoom = useCallback(() => {
    transformRef.current = IDENTITY_TRANSFORM;
    setTransform(IDENTITY_TRANSFORM);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    let single: SingleTrack | null = null;
    let two: TwoFingerTrack | null = null;
    const sendAll = (msgs: Record<string, unknown>[]) => msgs.forEach(sendMessage);

    // Every path that ends or changes a one-finger touch clears this, touchcancel included:
    // once the browser takes a gesture over it delivers no touchend, and a timer left armed
    // would right-click into whatever the finger was doing.
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLongPress = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    };
    /** Sends a click and, when it was a right click, shows where it landed and disarms the
     *  toolbar button if that is what made it one. */
    const sendClick = (msgs: Record<string, unknown>[], usedArmed: boolean) => {
      sendAll(msgs);
      const at = rightClickTarget(msgs);
      if (!at) return;
      showClickFeedback(at);
      if (usedArmed) onRightClickUsedRef.current?.();
    };

    // The container's rect (never transformed) is only the OUTER box the video is letterboxed
    // within — `object-fit: contain` (or the matching sizing on the canvas) means the canvas
    // element's CSS box fills that outer box, but the pixels it actually draws are narrower or
    // shorter depending on how the capture's aspect ratio compares to the phone's. Without this,
    // gestures were measured against the full outer box, so a tap landed at the finger's raw
    // screen position instead of the corresponding video pixel whenever there was a letterbox.
    const getVideoRect = (): Rect => {
      const box = container.getBoundingClientRect();
      const canvas = canvasRef.current;
      if (!canvas || !canvas.width || !canvas.height) return box;
      return letterboxedContentRect(box, canvas.width, canvas.height);
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = getVideoRect();
      clearLongPress();
      if (e.touches.length === 1) {
        two = null;
        const t = e.touches[0]!;
        const track = beginSingleTouch(t.clientX, t.clientY, rect);
        single = track;
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (single !== track) return;
          const r = resolveLongPress(track, modeRef.current, transformRef.current, cursorRef.current);
          if (!r) return;
          buzz();
          sendClick(r.messages, armedRef.current);
        }, LONG_PRESS_MS);
      } else if (e.touches.length === 2) {
        // A second finger landing after the first had already started a touch-mode drag would
        // otherwise leave the host's left button held down: that drag never gets its touchend.
        if (single?.moved && modeRef.current === "touch") {
          sendAll(resolveSingleTouchEnd(single, single.last.x, single.last.y, "touch", transformRef.current, cursorRef.current));
        }
        single = null;
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        two = beginTwoFingerTouch({ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }, transformRef.current.scale);
      } else {
        // 3+ fingers: not a gesture this viewer understands — drop tracking rather than guess.
        single = null;
        two = null;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (single && e.touches.length === 1) {
        const t = e.touches[0]!;
        const r = advanceSingleTouch(single, t.clientX, t.clientY, modeRef.current, transformRef.current, cursorRef.current);
        if (single.moved) clearLongPress();
        if (r.message) sendMessage(r.message);
        if (r.cursor) {
          // Mouse mode is DELTA-based (each call moves the cursor *relative* to `cursorRef`).
          // rAF coalesces the state-commit + wire-send below to once per frame, but the delta
          // math itself must not wait for that — updating `cursorRef.current` only inside
          // `flush()` meant back-to-back touchmove events landing in the same animation frame
          // each recomputed their delta against the SAME stale base position, so only the last
          // one "counted" and most of the finger's movement was silently dropped (the host
          // cursor barely moved). Updating the ref here, synchronously, makes every event
          // compound on the last regardless of how many land before the next flush.
          cursorRef.current = r.cursor;
          pendingRef.current.cursor = r.cursor;
          pendingRef.current.sendCursorMove = !!r.sendCursorMove;
          schedule();
        }
        return;
      }
      if (two && e.touches.length === 2) {
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        const r = advanceTwoFingerTouch(two, { x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }, transformRef.current);
        if (r.transform) {
          // Same reasoning as the cursor above: pan is delta-based off `transformRef`, so it
          // must be updated eagerly too, not just inside the throttled flush.
          transformRef.current = r.transform;
          pendingRef.current.transform = r.transform;
          schedule();
        }
        if (r.wheelDeltaPx) { pendingRef.current.wheelPx += r.wheelDeltaPx; schedule(); }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const t = e.changedTouches[0];
      clearLongPress();
      if (single) {
        const x = t ? t.clientX : single.last.x;
        const y = t ? t.clientY : single.last.y;
        const armed = armedRef.current;
        sendClick(resolveSingleTouchEnd(single, x, y, modeRef.current, transformRef.current, cursorRef.current, armed ? "right" : "left"), armed);
        single = null;
      }
      if (two) {
        sendClick(resolveTwoFingerEnd(two, getVideoRect(), transformRef.current, modeRef.current, cursorRef.current), false);
        two = null;
      }
    };

    const onTouchCancel = (e: TouchEvent) => {
      e.stopPropagation();
      clearLongPress();
      // A held button left down on the host would be worse than a dropped click — release it.
      // Only touch mode ever sends a "down" during a drag (mouse mode only moves the virtual
      // cursor until a tap), so only touch mode has anything to release here.
      if (single?.moved && modeRef.current === "touch") {
        sendAll(resolveSingleTouchEnd(single, single.last.x, single.last.y, "touch", transformRef.current, cursorRef.current));
      }
      single = null;
      two = null;
    };

    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: false });
    container.addEventListener("touchcancel", onTouchCancel, { passive: false });

    return () => {
      clearLongPress();
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [containerRef, canvasRef, enabled, sendMessage, schedule, showClickFeedback]);

  return { transform, virtualCursor: mode === "mouse" ? virtualCursor : null, clickFeedback, resetZoom };
}
