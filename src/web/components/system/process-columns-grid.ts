/** Pure grid-template builder for the process table. No React, so the visibility
 *  rules (which optional columns exist, which one survives below `@lg`) are
 *  unit-testable without mounting a component.
 *
 *  Two responsive templates are computed up front and switched via CSS custom
 *  properties + a `@lg:` Tailwind class (see `PROCESS_ROW_GRID_CLASS` below) —
 *  Tailwind's arbitrary-value scan only needs the class NAME to be a static
 *  string; the var() value itself can vary at runtime. This mirrors the fixed
 *  two-template approach the process table already used for the trend/age
 *  track, just parameterised by which optional columns the host can measure. */
import type { CSSProperties } from "react";
import type { ProcessColumnAvailability, SortKey } from "../../../types/system-metrics";

export type OptionalColumnKey = "disk" | "gpu" | "net";

/** Alias kept local so call sites don't need to know the exact server-contract
 *  type name — this module only cares about the three boolean flags. */
export type ProcessColumnsFlags = ProcessColumnAvailability;

const OPTIONAL_COLUMN_ORDER: OptionalColumnKey[] = ["disk", "gpu", "net"];

/** Disk/Net cells show two values ("↓ read ↑ write"); GPU shows one composite
 *  ("12% · 1.1 GB") and fits narrower. */
const OPTIONAL_COLUMN_WIDTH: Record<OptionalColumnKey, string> = {
  disk: "120px",
  gpu: "90px",
  net: "120px",
};

/** Fixed tracks that exist regardless of optional columns: Process name (flexible),
 *  CPU, RAM at the start; the trend/age track (wide only) and the kill button at
 *  the end. */
const NAME_CPU_RAM = ["minmax(0,1fr)", "64px", "80px"];
const TREND_TRACK = "130px";
const KILL_TRACK = "44px";

export interface ProcessGridResult {
  /** Grid template for `@lg` and up: Name/CPU/RAM + every enabled optional column
   *  in a fixed order + the trend/age track + kill button. */
  wideTemplate: string;
  /** Grid template below `@lg`: Name/CPU/RAM + AT MOST the one optional column
   *  currently sorted by (if enabled) + kill button. No trend/age track. */
  narrowTemplate: string;
  /** Which optional columns are enabled at all (host can measure them). */
  columns: ProcessColumnsFlags;
  /** The single optional column visible below `@lg`, or null when the current
   *  sort isn't on an optional column (or that column isn't enabled). */
  narrowExtra: OptionalColumnKey | null;
}

function isOptionalColumnKey(key: SortKey): key is OptionalColumnKey {
  return key === "disk" || key === "gpu" || key === "net";
}

export function buildProcessGrid(columns: ProcessColumnsFlags, sortKey: SortKey): ProcessGridResult {
  const enabled = OPTIONAL_COLUMN_ORDER.filter((k) => columns[k]);
  const narrowExtra = isOptionalColumnKey(sortKey) && columns[sortKey] ? sortKey : null;

  const wideTemplate = [
    ...NAME_CPU_RAM,
    ...enabled.map((k) => OPTIONAL_COLUMN_WIDTH[k]),
    TREND_TRACK,
    KILL_TRACK,
  ].join(" ");

  const narrowTemplate = [
    ...NAME_CPU_RAM,
    ...(narrowExtra ? [OPTIONAL_COLUMN_WIDTH[narrowExtra]] : []),
    KILL_TRACK,
  ].join(" ");

  return { wideTemplate, narrowTemplate, columns, narrowExtra };
}

/** Static class names (Tailwind can see both arbitrary-value strings at build
 *  time); the actual template text is supplied per-render via the two CSS
 *  custom properties in `gridCssVars`. */
export const PROCESS_ROW_GRID_CLASS = "grid-cols-[var(--sysmon-grid-n)] @lg:grid-cols-[var(--sysmon-grid-w)]";

export function gridCssVars(grid: ProcessGridResult): CSSProperties {
  return {
    "--sysmon-grid-n": grid.narrowTemplate,
    "--sysmon-grid-w": grid.wideTemplate,
  } as CSSProperties;
}

/** Visibility className for an optional column's cell: always visible when it is
 *  the narrow-mode survivor, otherwise hidden below `@lg` and shown at `@lg`+.
 *  Caller must only render the cell at all when `columns[key]` is true — when
 *  disabled, the column has no track in either template. */
export function optionalCellClassName(grid: ProcessGridResult, key: OptionalColumnKey): string {
  return grid.narrowExtra === key ? "block" : "hidden @lg:block";
}
