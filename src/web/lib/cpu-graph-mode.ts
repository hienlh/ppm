/**
 * Which CPU graph the Performance page draws — Mission Center's "Change Top
 * Graph To" menu, ported.
 *
 * Pure and free of store imports on purpose: importing the settings store reads
 * `localStorage` at module scope and throws under `bun:test`, so the parsing and
 * the grid maths would be untestable if they lived beside the component.
 */

export const CPU_GRAPH_MODES = ["overall", "logical", "threads", "threads-stacked"] as const;
export type CpuGraphMode = (typeof CPU_GRAPH_MODES)[number];

export const CPU_GRAPH_LABELS: Record<CpuGraphMode, string> = {
  overall: "Overall utilisation",
  logical: "Logical processors",
  threads: "All threads",
  "threads-stacked": "All threads stacked",
};

/** A mode off localStorage is untrusted the same way one off the wire is. */
export function parseCpuGraphMode(value: unknown): CpuGraphMode {
  return CPU_GRAPH_MODES.includes(value as CpuGraphMode) ? (value as CpuGraphMode) : "overall";
}

/** Mission Center's second, full-width graph under the utilisation one. `none`
 *  removes it rather than drawing an empty frame. */
export const CPU_BOTTOM_GRAPHS = ["temperature", "power", "clock", "none"] as const;
export type CpuBottomGraph = (typeof CPU_BOTTOM_GRAPHS)[number];

export const CPU_BOTTOM_LABELS: Record<CpuBottomGraph, string> = {
  temperature: "Temperature",
  power: "Power draw",
  clock: "Clock speed",
  none: "None",
};

export function parseCpuBottomGraph(value: unknown): CpuBottomGraph {
  return CPU_BOTTOM_GRAPHS.includes(value as CpuBottomGraph)
    ? (value as CpuBottomGraph)
    : "temperature";
}

/** Below this a cell is too narrow to read a curve in, so the grid drops a column
 *  rather than shrinking past it. 24 threads at Mission Center's six columns needs
 *  a ~700px pane; a floating window or a phone routinely has less. */
export const MIN_CELL_PX = 84;

export interface CoreGridLayout {
  cols: number;
  rows: number;
}

/**
 * Mission Center lays the per-thread grid out as `rows = floor(sqrt(n))`, then
 * fills each row — which is what puts a 24-thread i9 in 6 columns of 4 rather
 * than the 5x5 a naive `ceil(sqrt(n))` would give.
 *
 * The width clamp is ours: that layout assumes a window as wide as the screen,
 * and PPM draws this inside a resizable floating window and on a phone. Columns
 * are capped by what fits, never by a breakpoint — the pane's own width is the
 * only thing that knows whether six curves fit side by side.
 */
export function coreGridLayout(count: number, widthPx: number): CoreGridLayout {
  if (count <= 0) return { cols: 0, rows: 0 };
  const missionCenterCols = Math.ceil(count / Math.max(1, Math.floor(Math.sqrt(count))));
  // A width of 0 is "not measured yet" (the element has not laid out), not "no
  // room" — clamping to one column there would draw a 24-row column for a frame.
  const fits = widthPx > 0 ? Math.max(1, Math.floor(widthPx / MIN_CELL_PX)) : missionCenterCols;
  const cols = Math.min(missionCenterCols, fits);
  return { cols, rows: Math.ceil(count / cols) };
}

/**
 * How long the visible history window actually spans, for the "over 1 minute"
 * caption Mission Center writes above each graph. Ours is read from the points
 * themselves rather than assumed: PPM's window is 200 points at the server's own
 * cadence, which is 2s on the full tier and 5s on the light one, so a fixed
 * wording would be wrong on one of them and wrong again on a fresh window that
 * has only collected a few seconds.
 */
export function historySpanLabel(timestamps: readonly number[]): string | undefined {
  if (timestamps.length < 2) return undefined;
  const first = timestamps[0]!;
  const last = timestamps[timestamps.length - 1]!;
  const seconds = Math.round((last - first) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (seconds < 90) return `over ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "over 1 minute" : `over ${minutes} minutes`;
}
