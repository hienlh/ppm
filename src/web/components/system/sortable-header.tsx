import { ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortDir, SortKey } from "../../../types/system-metrics";

/** Sortable column header shared by the process table toolbar, salvaged from
 *  the deleted `system-monitor-group-row.tsx`. Renders as a `columnheader` `<div>`,
 *  not a `<th>` — the parent row is a CSS-grid `<div role="row">`, and a `<th>`
 *  inside a non-table ancestor both triggers React's DOM-nesting warning and makes
 *  `aria-sort` meaningless to assistive tech outside an actual table. */
export function SortableHeader({
  label,
  field,
  activeKey,
  activeDir,
  onClick,
  align = "right",
  testId,
  className,
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
}) {
  const isActive = activeKey === field;
  const Arrow = isActive ? (activeDir === "asc" ? ArrowUp : ArrowDown) : null;
  const ariaSort = isActive ? (activeDir === "asc" ? "ascending" : "descending") : "none";

  return (
    <div
      role="columnheader"
      aria-sort={ariaSort}
      className={cn(
        "py-1.5 px-2 font-medium select-none",
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
        <span>{label}</span>
        {Arrow && <Arrow className="size-3" />}
      </button>
    </div>
  );
}
