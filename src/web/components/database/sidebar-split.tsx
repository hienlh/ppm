/**
 * The line between the Connections section and the object list, as DBGate draws it: dragged, or
 * moved with the arrow keys, it gives one section more of the sidebar's height. A drag is saved
 * when it ends rather than on every move, which would write the setting at the pointer's rate.
 * Not drawn on a phone, where both sections share the drawer at the saved proportion.
 */
import { useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { SPLIT_MAX, SPLIT_MIN } from "../../../shared/db-explorer-prefs";

/** How far one arrow key moves the line. */
const STEP = 0.05;

/** A share of the height within bounds, to the percent: the keys would otherwise pile up float error. */
export function clampSplit(v: number): number {
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)) * 100) / 100;
}

export function SidebarSplit({ split, containerRef, onMove, onCommit }: {
  /** The Connections section's share of the height, as shown. */
  split: number;
  /** The box both sections share: the share is measured against it. */
  containerRef: RefObject<HTMLElement | null>;
  /** During a drag: the share to show, not saved yet. */
  onMove: (split: number) => void;
  /** A drag ended or a key moved the line: the share to keep. */
  onCommit: (split: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  // Read by the handlers: a pointerup and the lostpointercapture after it land before a re-render.
  const drag = useRef<{ share: number } | null>(null);

  const end = () => {
    if (!drag.current) return;
    const { share } = drag.current;
    drag.current = null;
    setDragging(false);
    onCommit(share);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the two sections"
      aria-valuemin={Math.round(SPLIT_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_MAX * 100)}
      aria-valuenow={Math.round(split * 100)}
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { share: split };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const box = containerRef.current?.getBoundingClientRect();
        if (!drag.current || !box || box.height <= 0) return;
        drag.current.share = clampSplit((e.clientY - box.top) / box.height);
        onMove(drag.current.share);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        const next = e.key === "ArrowUp" ? split - STEP
          : e.key === "ArrowDown" ? split + STEP
          : e.key === "Home" ? SPLIT_MIN
          : e.key === "End" ? SPLIT_MAX
          : null;
        if (next === null) return;
        e.preventDefault();
        onCommit(clampSplit(next));
      }}
      className="group/split relative h-[7px] shrink-0 cursor-row-resize touch-none outline-none max-md:hidden"
    >
      <span className={cn(
        "absolute inset-x-0 top-[3px] h-px bg-border group-hover/split:bg-primary group-focus-visible/split:bg-primary",
        dragging && "bg-primary",
      )} />
      <span className={cn(
        "absolute top-0.5 left-1/2 -ml-3.5 h-[3px] w-7 rounded-sm bg-primary opacity-0 group-hover/split:opacity-100 group-focus-visible/split:opacity-100",
        dragging && "opacity-100",
      )} />
    </div>
  );
}
