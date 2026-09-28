/**
 * The Services table's columns — Mission Center's own set, in its own order:
 * Name, PID, CPU, Memory, Swap, Drive, GPU, GPU Memory.
 *
 * One table drives three things that have to agree or the page silently
 * misaligns: the header labels, each cell's visibility, and the grid template at
 * each width. They are derived from this list rather than written out three
 * times, because a column added to the header and forgotten in the template does
 * not fail — it shifts every cell after it one track to the left.
 *
 * Widths are fixed pixels for every column but the name. They cannot be `auto`:
 * each row is its own grid element, so an `auto` track is sized by *that row's*
 * content and two rows with different-length numbers would not line up.
 *
 * Pure, React-free, relative imports only.
 */
import type { CSSProperties } from "react";

export type ServiceColumnKey = "name" | "pid" | "cpu" | "ram" | "swap" | "disk" | "gpu" | "gpuMem";

/** The container width at which a column appears. `base` is always present. */
export type ColumnBreakpoint = "base" | "@2xl" | "@3xl" | "@4xl";

export interface ServiceColumn {
  key: ServiceColumnKey;
  label: string;
  /** Track width in px; `null` is the one flexible column (the name). */
  width: number | null;
  from: ColumnBreakpoint;
  align: "left" | "right";
}

/**
 * The ladder is by *usefulness per pixel*: CPU and Memory are the two figures
 * worth a narrow window, PID and Swap come next, and the three widest cells
 * (Drive carries two rates) only once there is room for them beside a readable
 * unit name. A 60-character unit name squeezed into 90px to show a GPU column
 * that reads 0% for almost every unit is a worse table, not a fuller one.
 */
export const SERVICE_COLUMNS: readonly ServiceColumn[] = [
  { key: "name", label: "Name", width: null, from: "base", align: "left" },
  { key: "pid", label: "PID", width: 56, from: "@3xl", align: "right" },
  { key: "cpu", label: "CPU", width: 56, from: "@2xl", align: "right" },
  { key: "ram", label: "Memory", width: 72, from: "@2xl", align: "right" },
  { key: "swap", label: "Swap", width: 72, from: "@3xl", align: "right" },
  { key: "disk", label: "Drive", width: 112, from: "@4xl", align: "right" },
  { key: "gpu", label: "GPU", width: 56, from: "@4xl", align: "right" },
  { key: "gpuMem", label: "GPU Memory", width: 80, from: "@4xl", align: "right" },
];

/** Narrowest first; a column appears at its own breakpoint and every wider one. */
export const BREAKPOINT_ORDER: readonly ColumnBreakpoint[] = ["base", "@2xl", "@3xl", "@4xl"];

/**
 * Written out as literal strings, never built from `col.from` at runtime:
 * Tailwind scans source text for class names, so a class assembled as
 * `` `hidden ${bp}:block` `` emits no rule at all and the column would be
 * visible at every width — the same silent failure as a colour class naming a
 * token that does not exist.
 */
const VISIBILITY: Record<ColumnBreakpoint, string> = {
  base: "",
  "@2xl": "hidden @2xl:block",
  "@3xl": "hidden @3xl:block",
  "@4xl": "hidden @4xl:block",
};

export function columnVisibilityClass(column: ServiceColumn): string {
  return VISIBILITY[column.from];
}

export function visibleColumnsAt(breakpoint: ColumnBreakpoint): ServiceColumn[] {
  const width = BREAKPOINT_ORDER.indexOf(breakpoint);
  return SERVICE_COLUMNS.filter((c) => BREAKPOINT_ORDER.indexOf(c.from) <= width);
}

export function gridTemplateAt(breakpoint: ColumnBreakpoint): string {
  return visibleColumnsAt(breakpoint)
    .map((c) => (c.width === null ? "minmax(0,1fr)" : `${c.width}px`))
    .join(" ");
}

/**
 * Static class names for the four templates; the templates themselves arrive as
 * CSS custom properties set once on the panel and inherited by every row, which
 * is the same arrangement the process table uses. `gap-2` rather than `gap-3`:
 * eight columns pay seven gaps, and 28px of them is a tenth of the name column.
 */
export const SERVICE_ROW_GRID_CLASS = [
  "grid gap-2 grid-cols-[var(--svc-cols-base)]",
  "@2xl:grid-cols-[var(--svc-cols-2xl)]",
  "@3xl:grid-cols-[var(--svc-cols-3xl)]",
  "@4xl:grid-cols-[var(--svc-cols-4xl)]",
].join(" ");

export function serviceGridCssVars(): CSSProperties {
  return {
    "--svc-cols-base": gridTemplateAt("base"),
    "--svc-cols-2xl": gridTemplateAt("@2xl"),
    "--svc-cols-3xl": gridTemplateAt("@3xl"),
    "--svc-cols-4xl": gridTemplateAt("@4xl"),
  } as CSSProperties;
}
