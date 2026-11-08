/**
 * Keeps one row of a scroll container at a fixed distance from its top — the landing spot of a
 * jump to a turn — until the reader scrolls.
 *
 * The chat's scrollers opt out of the browser's scroll anchoring (`overflow-anchor: none`, so
 * streaming below the viewport cannot fight the follow-to-bottom), which means nothing keeps a
 * row in place when content above it changes height: an image decoding, code being highlighted,
 * a diagram rendering, a tool card arriving late. Landing on a turn and watching it slide away as
 * those settle is what this prevents. While pinned, a ResizeObserver on the content measures the
 * row again after every layout change and moves the scroll position by however far it drifted;
 * the observer runs after layout and before paint, so the drift is never drawn.
 *
 * Unpinning must happen on the reader's intent only — wheel, touch, a scroll key, a press on the
 * scrollbar, or a scroll position nobody here wrote. Two things move the position that are not
 * the reader, and both are ignored:
 * - A hidden tab (TabPool parks it with `display: none`) has no height; whatever its offset reads
 *   then means nothing, and nothing can be measured.
 * - When a tab is shown again or moved to another panel, `reparenting-tab.tsx` puts the offsets
 *   back that the move reset. Scroll events for that land in the frame the tab reappears, before
 *   the ResizeObserver reports the new height, and the pin waits one more frame before it trusts
 *   the position again.
 *
 * A container that also follows its own bottom (the live list, through use-stick-to-bottom) needs
 * that following held off while a row is pinned: a landing near the bottom is a downward scroll that
 * ends near the bottom, which the follower reads as the reader returning there and locks on again,
 * and its next resize-follow then pulls the row away. `onHold` is called on every write the pin
 * makes and again just after the follower has judged it (it judges a scroll a moment after the
 * event), so the pin stays the one that decides until the reader scrolls.
 *
 * A container with no bottom follower (the history window) can ask for a reading anchor as well:
 * while nothing is pinned, the row at the top of the viewport is remembered on every scroll (once
 * per frame), and a layout change puts it back where the reader left it — what the browser's own
 * scroll anchoring would do. Without it, an image in an older page decoding after the page landed
 * pushed the row being read down by the image's height. Never for a container that follows its
 * bottom: the follower owns the position there.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { firstVisibleRow, restoreRow, type RowAnchor } from "@/components/chat/scroll-row-anchor";

export interface ScrollAnchorPinOptions {
  /** Keep the row being read in place across layout changes while nothing is pinned. */
  readingAnchor?: boolean;
}

/** Where the pinned row's top sits, below the container's top. */
export const PIN_OFFSET_PX = 16;

/** Keys that scroll a focused container; pressing one is the reader taking over. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);

/** A scroll position this far from the one last written is someone else's. */
const OWN_WRITE_TOLERANCE_PX = 1;

/** After the follower's own deferred look at a scroll event (it waits 1 ms), so the hold lands last. */
const HOLD_AFTER_SCROLL_MS = 2;

/** Keys typed into a field are text, not scrolling, even when the field sits inside the container. */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])");
}

export class ScrollAnchorPin {
  private target: HTMLElement | null = null;
  /** The scroll position the pin last wrote, as the browser clamped it. */
  private lastSet: number | null = null;
  /** The container had no height at the last resize report. */
  private hidden: boolean;
  /** Shown again this frame: offsets are still being restored, so nothing is measured or judged. */
  private settling = false;
  private frame = 0;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly ro: ResizeObserver;
  /** The row being read while nothing is pinned (`readingAnchor` only). */
  private reading: RowAnchor | null = null;
  private readingFrame = 0;

  constructor(
    private readonly el: HTMLElement,
    private readonly offset = PIN_OFFSET_PX,
    private readonly onUnpin?: () => void,
    private readonly onHold?: () => void,
    private readonly options: ScrollAnchorPinOptions = {},
  ) {
    this.hidden = el.clientHeight === 0;
    this.ro = new ResizeObserver(this.onResize);
    this.ro.observe(el);
    // The content wrapper is what grows when something above the row changes height; the
    // container's own box does not.
    if (el.firstElementChild) this.ro.observe(el.firstElementChild);
    el.addEventListener("wheel", this.onIntent, { passive: true });
    el.addEventListener("touchmove", this.onIntent, { passive: true });
    el.addEventListener("keydown", this.onKeyDown);
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("scroll", this.onScroll, { passive: true });
  }

  get pinned(): HTMLElement | null {
    return this.target;
  }

  pin(target: HTMLElement): void {
    this.target = target;
    this.apply();
  }

  unpin(): void {
    if (!this.target) return;
    this.target = null;
    this.lastSet = null;
    this.rememberReading();
    this.onUnpin?.();
  }

  /** Measure the row again now — after a change the caller made and knows about. */
  apply(): void {
    const target = this.target;
    if (!target) return;
    if (!target.isConnected) return this.unpin();
    if (this.suspended()) return;
    const drift = target.getBoundingClientRect().top - this.el.getBoundingClientRect().top - this.offset;
    this.onHold?.();
    if (Math.abs(drift) >= 0.5) this.el.scrollTop += drift;
    this.lastSet = this.el.scrollTop;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.readingFrame);
    clearTimeout(this.holdTimer);
    this.ro.disconnect();
    this.el.removeEventListener("wheel", this.onIntent);
    this.el.removeEventListener("touchmove", this.onIntent);
    this.el.removeEventListener("keydown", this.onKeyDown);
    this.el.removeEventListener("pointerdown", this.onPointerDown);
    this.el.removeEventListener("scroll", this.onScroll);
    this.target = null;
  }

  private suspended(): boolean {
    return this.hidden || this.settling || this.el.clientHeight === 0;
  }

  /** Records the row at the top of the viewport, when a reading anchor is kept and nothing is pinned. */
  private rememberReading(): void {
    if (!this.options.readingAnchor || this.target || this.suspended()) return;
    this.reading = firstVisibleRow(this.el);
  }

  /** Puts the row being read back where the reader left it after a layout change. */
  private restoreReading(): void {
    if (!this.options.readingAnchor || this.target || !this.reading) return;
    // A row that is gone (a page dropped from the window) leaves the position as it is.
    restoreRow(this.el, this.reading);
    this.reading = firstVisibleRow(this.el);
  }

  private readonly onResize = (): void => {
    if (this.el.clientHeight === 0) {
      this.hidden = true;
      return;
    }
    if (this.hidden) {
      this.hidden = false;
      this.settling = true;
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        this.settling = false;
        if (this.target) this.apply();
        else this.rememberReading();
      });
      return;
    }
    if (this.settling) return;
    if (this.target) this.apply();
    else this.restoreReading();
  };

  private readonly onIntent = (): void => {
    if (!this.suspended()) this.unpin();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (SCROLL_KEYS.has(e.key) && !isEditable(e.target)) this.onIntent();
  };

  /** Only a press on the container itself, i.e. its scrollbar: a click on a row is not a scroll. */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.target === this.el) this.onIntent();
  };

  private readonly onScroll = (): void => {
    if (this.options.readingAnchor && !this.target && !this.readingFrame) {
      // Once per frame: scroll events come at most once a frame anyway, before the layout the
      // ResizeObserver reports on, so the row read here is the one a resize in this frame restores.
      this.readingFrame = requestAnimationFrame(() => {
        this.readingFrame = 0;
        this.rememberReading();
      });
    }
    if (!this.target || this.suspended() || this.lastSet === null) return;
    if (Math.abs(this.el.scrollTop - this.lastSet) > OWN_WRITE_TOLERANCE_PX) return this.unpin();
    if (!this.onHold) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => { if (this.target) this.onHold?.(); }, HOLD_AFTER_SCROLL_MS);
  };
}

export interface AnchorPinHandle {
  pin(target: HTMLElement): void;
  unpin(): void;
  apply(): void;
  /** The row held in place, or null once the reader has taken over. */
  pinned(): HTMLElement | null;
}

/**
 * A pin for `scrollEl`, rebuilt whenever the container element changes. `onUnpin` hears the reader
 * take over (it is not called for an `unpin()` made here). `readingAnchor` is fixed per container.
 */
export function useScrollAnchorPin(scrollEl: HTMLElement | null, onUnpin?: () => void, onHold?: () => void, options?: ScrollAnchorPinOptions): AnchorPinHandle {
  const pinRef = useRef<ScrollAnchorPin | null>(null);
  const onUnpinRef = useRef(onUnpin);
  onUnpinRef.current = onUnpin;
  const onHoldRef = useRef(onHold);
  onHoldRef.current = onHold;
  const holds = !!onHold;
  const readingAnchor = !!options?.readingAnchor;
  // A layout effect, so a pin asked for in the same commit (a landing) finds the instance ready.
  useLayoutEffect(() => {
    if (!scrollEl) return;
    const pin = new ScrollAnchorPin(scrollEl, PIN_OFFSET_PX, () => onUnpinRef.current?.(), holds ? () => onHoldRef.current?.() : undefined, { readingAnchor });
    pinRef.current = pin;
    return () => {
      pin.dispose();
      if (pinRef.current === pin) pinRef.current = null;
    };
  }, [scrollEl, holds, readingAnchor]);
  return useMemo(() => ({
    pin: (target) => pinRef.current?.pin(target),
    unpin: () => pinRef.current?.unpin(),
    apply: () => pinRef.current?.apply(),
    pinned: () => pinRef.current?.pinned ?? null,
  }), []);
}
