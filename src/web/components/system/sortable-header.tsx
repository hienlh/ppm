import { ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortDir, SortKey } from "../../../types/system-metrics";
import type { ResizableColumnKey } from "./process-columns-grid";

export interface ColumnResizeHandlers {
  onResizeStart: (key: ResizableColumnKey, e: { clientX: number; preventDefault: () => void }) => void;
  onResizeReset: (key: ResizableColumnKey) => void;
}

/** Sortable column header shared by the process table toolbar. Renders as a
 *  `columnheader` `<div>`, not a `<th>` — the parent row is a CSS-grid
 *  `<div role="row">`, and a `<th>` inside a non-table ancestor both triggers React's
 *  DOM-nesting warning and makes `aria-sort` meaningless to assistive tech outside
 *  an actual table. */
export function SortableHeader({
  label,
  field,
  activeKey,
  activeDir,
  onClick,
  align = "right",
  testId,
  className,
  resizeKey,
  resize,
}: {
  label: string;
  field: Exclude<SortKey, null>;
  activeKey: SortKey;
  activeDir: SortDir;
  onClick: (field: Exclude<SortKey, null>) => void;
  /** Text/justify alignment — the "Process" column is left-aligned over the name
   *  cell, every numeric column stays right-aligned. */
  align?: "left" | "right";
  testId?: string;
  /** Extra classes on the outer `columnheader` — e.g. the `hidden @lg:block`
   *  visibility rule an optional (Disk/GPU/Net) column needs below `@lg`. */
  className?: string;
  /** Present for fixed-width columns: renders the drag handle on the right edge. */
  resizeKey?: ResizableColumnKey;
  resize?: ColumnResizeHandlers;
}) {
  const isActive = activeKey === field;
  const Arrow = isActive ? (activeDir === "asc" ? ArrowUp : ArrowDown) : null;
  const ariaSort = isActive ? (activeDir === "asc" ? "ascending" : "descending") : "none";

  return (
    <div
      role="columnheader"
      aria-sort={ariaSort}
      className={cn(
        "relative py-1.5 px-2 font-medium select-none",
        align === "left" ? "text-left" : "text-right",
        className,
      )}
    >
      {/* The test id sits on the interactive element: a synthetic `click()` on the
          wrapper never reaches the button (events bubble up, not down), so a harness
          targeting the div would silently not sort. */}
      <button
        type="button"
        data-testid={testId}
        onClick={() => onClick(field)}
        className={cn(
          "flex items-center gap-0.5 w-full min-h-11 md:min-h-0 cursor-pointer hover:text-text-primary transition-colors",
          align === "left" ? "justify-start" : "justify-end",
          isActive && "text-text-primary",
        )}
      >
        <span className="truncate">{label}</span>
        {Arrow && <Arrow className="size-3 shrink-0" />}
      </button>
      {/* Drag handle: pointer-only (hidden below `md`, where the table is a
          single narrow column set and there is nothing worth resizing). Double-click
          returns the column to its default width. */}
      {resizeKey && resize && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label} column`}
          data-testid={testId ? `${testId}-resize` : undefined}
          onPointerDown={(e) => resize.onResizeStart(resizeKey, e)}
          onDoubleClick={() => resize.onResizeReset(resizeKey)}
          className="hidden md:block absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-primary/40 active:bg-primary/60"
        />
      )}
    </div>
  );
}
