import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown, ChevronsDown, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { ownsGlobalShortcut } from "@/lib/owns-global-shortcut";

/** Collapse delay after opening or after the last navigation. */
const AUTO_COLLAPSE_MS = 3200;
/** Shorter collapse used when a keyboard shortcut opens the cluster just as feedback. */
const KEYBOARD_PEEK_MS = 1000;

interface NavState {
  hasAbove: boolean;
  atBottom: boolean;
  /** 1-based position of the last user message at or above the viewport top. */
  idx: number;
  total: number;
}

const INITIAL: NavState = { hasAbove: false, atBottom: true, idx: 0, total: 0 };

/**
 * Floating bottom-right navigation between the user's own messages.
 *
 * At rest this is a single dim 30px puck so it reads as chrome and stops covering
 * the tail of long user bubbles. Clicking it expands a vertical cluster
 * (previous · position · next · latest) that auto-collapses after use.
 *
 * Every bubble is in the real DOM (no virtualization), so navigation queries the
 * rendered rows by their `data-msg-index`. Scrolling stays `behavior: "auto"` to
 * avoid fighting `use-stick-to-bottom`.
 */
export function ChatScrollNav({ scrollElement, userIndices, scrollToBottom }: {
  scrollElement: HTMLDivElement | null;
  userIndices: number[];
  scrollToBottom: (opts?: { animation?: "instant" | "smooth" }) => void | Promise<boolean> | boolean;
}) {
  const isMobile = useIsMobile();
  const [nav, setNav] = useState<NavState>(INITIAL);
  const [open, setOpen] = useState(false);
  /** Bumped on every jump so the collapse timer restarts even when `idx` is unchanged. */
  const [jumpTick, setJumpTick] = useState(0);
  const collapseMsRef = useRef(AUTO_COLLAPSE_MS);
  const clusterRef = useRef<HTMLDivElement>(null);
  const puckRef = useRef<HTMLButtonElement>(null);
  /** Set while focus lives inside the cluster, so collapsing can hand it back. */
  const heldFocusRef = useRef(false);
  /** True when the cluster was opened by activating the puck rather than by a shortcut. */
  const focusOnOpenRef = useRef(false);

  // Top of a row in the scroll container's content coordinates (scrollTop space).
  const rowTop = (el: HTMLElement, row: HTMLElement, elTop: number) =>
    row.getBoundingClientRect().top - elTop + el.scrollTop;

  const userRows = useCallback((el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLElement>("[data-msg-index]"))
      .filter((r) => userIndices.includes(Number(r.dataset.msgIndex))),
    [userIndices]);

  useEffect(() => {
    const el = scrollElement;
    if (!el) return;
    let raf = 0;
    const recompute = () => {
      const top = el.scrollTop;
      const elTop = el.getBoundingClientRect().top;
      const tops = userRows(el).map((r) => rowTop(el, r, elTop));
      let idx = 0;
      for (let i = 0; i < tops.length; i++) if (tops[i]! <= top + 12) idx = i + 1;
      const next: NavState = {
        hasAbove: tops.some((t) => t < top - 4),
        atBottom: el.scrollHeight - top - el.clientHeight < 8,
        idx,
        total: tops.length,
      };
      setNav((prev) => (
        prev.hasAbove === next.hasAbove && prev.atBottom === next.atBottom
          && prev.idx === next.idx && prev.total === next.total
      ) ? prev : next);
    };
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    recompute();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [scrollElement, userRows]);

  // Auto-collapse. Restarts on every jump so a burst of navigation keeps it open.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), collapseMsRef.current);
    return () => clearTimeout(t);
  }, [open, nav.idx, jumpTick]);

  // Opening unmounts the puck, so focus would otherwise fall to <body> and restart
  // tab order at the document top. Only pull focus when the puck was activated —
  // the keyboard shortcut fires while the user is reading and must not steal it.
  useEffect(() => {
    if (!open || !focusOnOpenRef.current) return;
    focusOnOpenRef.current = false;
    const box = clusterRef.current;
    (box?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? box)?.focus();
  }, [open]);

  // Collapsing unmounts whatever the user was on — hand focus back to the puck.
  useEffect(() => {
    if (open || !heldFocusRef.current) return;
    heldFocusRef.current = false;
    puckRef.current?.focus();
  }, [open]);

  const afterJump = useCallback(() => {
    collapseMsRef.current = AUTO_COLLAPSE_MS;
    setJumpTick((n) => n + 1);
  }, []);

  const goUp = useCallback(() => {
    const el = scrollElement;
    if (!el) return;
    const top = el.scrollTop;
    const elTop = el.getBoundingClientRect().top;
    let target: number | undefined;
    for (const r of userRows(el)) {
      const t = rowTop(el, r, elTop);
      if (t < top - 4) target = t; // ascending — keep the last one still above
      else break;
    }
    if (target != null) el.scrollTo({ top: target, behavior: "auto" });
    afterJump();
  }, [scrollElement, userRows, afterJump]);

  const goDown = useCallback(() => {
    const el = scrollElement;
    if (!el) return;
    const top = el.scrollTop;
    const elTop = el.getBoundingClientRect().top;
    const next = userRows(el).map((r) => rowTop(el, r, elTop)).find((t) => t > top + 4);
    if (next != null) el.scrollTo({ top: next, behavior: "auto" });
    else scrollToBottom({ animation: "instant" });
    afterJump();
  }, [scrollElement, userRows, scrollToBottom, afterJump]);

  const goBottom = useCallback(() => {
    scrollToBottom({ animation: "instant" });
    afterJump();
  }, [scrollToBottom, afterJump]);

  // Global Alt+Arrow shortcuts arrive as window events from useGlobalKeybindings.
  useEffect(() => {
    const el = scrollElement;
    if (!el) return;
    const run = (fn: () => void) => () => {
      if (!ownsGlobalShortcut(el)) return;
      fn();
      // Must follow the jump — the jump handlers reset the delay to the full value.
      collapseMsRef.current = KEYBOARD_PEEK_MS;
      setOpen(true);
    };
    const onPrev = run(goUp);
    const onNext = run(goDown);
    window.addEventListener("chat-nav-prev", onPrev);
    window.addEventListener("chat-nav-next", onNext);
    return () => {
      window.removeEventListener("chat-nav-prev", onPrev);
      window.removeEventListener("chat-nav-next", onNext);
    };
  }, [scrollElement, goUp, goDown]);

  const rowClass = cn(
    "w-[34px] flex items-center justify-center rounded-[9px] text-text-secondary",
    "motion-safe:transition-colors hover:bg-surface-elevated hover:text-foreground",
    "disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-text-secondary",
    isMobile ? "h-9" : "h-[30px]",
  );

  return (
    <div className="absolute bottom-3 right-2.5 z-10 flex flex-col items-end gap-1.5">
      {open ? (
        <div
          ref={clusterRef}
          tabIndex={-1}
          className="flex flex-col p-[3px] rounded-xl border border-border bg-surface-elevated/95 backdrop-blur-[8px] shadow-lg outline-none"
          onFocus={() => { heldFocusRef.current = true; }}
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
        >
          <button type="button" onClick={goUp} disabled={!nav.hasAbove} aria-label="Jump to previous message" className={rowClass}>
            <ChevronUp className="size-[15px]" />
          </button>
          <span
            className="font-mono text-[10px] font-medium text-text-subtle text-center py-px"
            aria-label={`Message ${nav.idx || 1} of ${nav.total}`}
          >
            {nav.total ? `${nav.idx || 1}/${nav.total}` : "0/0"}
          </span>
          <button type="button" onClick={goDown} disabled={nav.atBottom} aria-label="Jump to next message" className={rowClass}>
            <ChevronDown className="size-[15px]" />
          </button>
          <button type="button" onClick={goBottom} disabled={nav.atBottom} aria-label="Jump to latest" className={rowClass}>
            <ChevronsDown className="size-[13px]" />
          </button>
        </div>
      ) : (
        <button
          ref={puckRef}
          type="button"
          onClick={() => { collapseMsRef.current = AUTO_COLLAPSE_MS; focusOnOpenRef.current = true; setOpen(true); }}
          aria-label="Navigate messages"
          aria-expanded={false}
          title="Navigate messages"
          // Mobile keeps a 36px circle inside a 44px hit area.
          className={cn("group flex items-center justify-center", isMobile ? "size-11" : "size-[30px]")}
        >
          <span
            className={cn(
              "flex items-center justify-center rounded-full border border-border bg-surface-elevated/55 backdrop-blur-[6px] text-text-subtle",
              "motion-safe:transition-colors group-hover:bg-surface-elevated group-hover:text-foreground",
              isMobile ? "size-9" : "size-[30px]",
            )}
          >
            <ChevronsUpDown className="size-[15px]" />
          </span>
        </button>
      )}
    </div>
  );
}
