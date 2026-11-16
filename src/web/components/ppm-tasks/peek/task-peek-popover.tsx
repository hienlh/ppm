/**
 * A task's quick view on a desktop: a floating panel beside the chat's Tasks list (or beside a task
 * chip), placed by `placeTaskPeek` so it never covers what it was opened from when there is room
 * and never leaves the viewport when there is not. It is portalled to the opener's own document
 * (a picture-in-picture window has its own), so no box of the chat clips it.
 *
 * It is a `role=dialog` with `data-state=open`, which is what the Tasks list's popover reads to
 * leave a press inside it and the first Escape alone: Escape closes this panel first and only the
 * next one closes the list. Beside the list, a press outside both closes both — the list's own
 * outside press, which unmounts this with it. Beside a chip (`dismissOnOutside`) it closes itself
 * on a press outside it and the chip.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { peekBox, placeTaskPeek, type PeekPlacement, type PeekSide } from "@/lib/ppm-tasks/task-peek-placement";
import type { TaskTabTarget } from "@/lib/ppm-tasks/open-task-tab";
import { TaskPeekBody } from "./task-peek-body";

/** The quick view's accessible name: "Task #12 Fix login". */
export const taskPeekLabel = (t: TaskTabTarget): string => `Task ${t.number !== undefined ? `#${t.number} ` : ""}${t.title}`;

/** The panel's width when it has room for it. */
export const TASK_PEEK_WIDTH = 340;

export interface TaskPeekPopoverProps {
  target: TaskTabTarget;
  /** What the panel must not cover (the list's panel, the chip). */
  avoidRef: RefObject<HTMLElement | null>;
  /** What it lines up with (the clicked row, the chip); `avoidRef` when absent. */
  alignRef?: RefObject<HTMLElement | null>;
  sides: readonly PeekSide[];
  /** × and Escape. */
  onClose(): void;
  /** Open chat leaves for the chat: the opener closes everything. */
  onLeave(): void;
  onOpenWindow(task: TaskTabTarget): void;
  /** A press outside the panel and `avoidRef` closes it (beside a chip; the list closes it itself). */
  dismissOnOutside?: boolean;
}

export function TaskPeekPopover({ target, avoidRef, alignRef, sides, onClose, onLeave, onOpenWindow, dismissOnOutside = false }: TaskPeekPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<PeekPlacement | null>(null);
  // The row it was opened from may leave the list (closed by a status the panel set): the panel
  // then stays where it was rather than jumping.
  const lastAlign = useRef<DOMRect | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const doc = avoidRef.current?.ownerDocument ?? document;

  const measure = useCallback(() => {
    const panel = panelRef.current;
    const avoid = avoidRef.current;
    const view = panel?.ownerDocument.defaultView;
    // What it was opened from left the page (a composer chip removed): nothing to show it beside.
    if (avoid && !avoid.isConnected) { onCloseRef.current(); return; }
    if (!panel || !avoid || !view) return;
    const align = alignRef?.current;
    if (align?.isConnected) lastAlign.current = align.getBoundingClientRect();
    const scroller = panel.querySelector<HTMLElement>("[data-task-peek-scroll]");
    // Its natural height: what it would be with nothing scrolled away inside.
    const height = panel.offsetHeight - (scroller?.clientHeight ?? 0) + (scroller?.scrollHeight ?? 0);
    const next = placeTaskPeek({
      avoid: peekBox(avoid.getBoundingClientRect()),
      align: peekBox(lastAlign.current ?? avoid.getBoundingClientRect()),
      size: { width: TASK_PEEK_WIDTH, height },
      viewport: { width: view.innerWidth, height: view.innerHeight },
      sides,
    });
    setPlace((p) => (p && p.side === next.side && p.left === next.left && p.top === next.top && p.width === next.width && p.maxHeight === next.maxHeight ? p : next));
  }, [alignRef, avoidRef, sides]);

  useLayoutEffect(measure, [measure, target.id]);

  useEffect(() => {
    const view = doc.defaultView;
    const panel = panelRef.current;
    // The panel, and its content, which grows once the task has been read.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    for (const el of [panel, panel?.querySelector("[data-task-peek-content]")]) if (el) observer?.observe(el);
    // The list scrolls under its row; a window resize moves everything.
    const onScroll = (e: Event) => { if (!panel?.contains(e.target as Node)) measure(); };
    view?.addEventListener("resize", measure);
    doc.addEventListener("scroll", onScroll, true);
    return () => {
      observer?.disconnect();
      view?.removeEventListener("resize", measure);
      doc.removeEventListener("scroll", onScroll, true);
    };
  }, [doc, measure, target.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A menu or dialog opened over the panel takes its own Escape.
      if (doc.querySelector("[data-radix-popper-content-wrapper], [role=alertdialog]")) return;
      e.preventDefault();
      onCloseRef.current();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || avoidRef.current?.contains(t)) return;
      if ((t as Element).closest?.("[data-radix-popper-content-wrapper]")) return;
      onCloseRef.current();
    };
    doc.addEventListener("keydown", onKey);
    if (dismissOnOutside) doc.addEventListener("pointerdown", onPointer);
    return () => {
      doc.removeEventListener("keydown", onKey);
      doc.removeEventListener("pointerdown", onPointer);
    };
  }, [avoidRef, dismissOnOutside, doc]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={taskPeekLabel(target)}
      data-state="open"
      data-task-peek-popover={target.id}
      data-task-peek-side={place?.side}
      data-task-peek-mode={place?.mode}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        width: place?.width ?? TASK_PEEK_WIDTH,
        maxHeight: place?.maxHeight,
        // Drawn only once it has a place: the first layout pass measures it where nobody sees it.
        visibility: place ? undefined : "hidden",
      }}
      className={cn(
        "popover-solid fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border text-xs text-text shadow-[var(--shadow-float)]",
        place && "footer-pop-in",
      )}
    >
      <TaskPeekBody target={target} layout="popover" onClose={onClose} onLeave={onLeave} onOpenPage={onOpenWindow} />
    </div>,
    doc.body,
  );
}
