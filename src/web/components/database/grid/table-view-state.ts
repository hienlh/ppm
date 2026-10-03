/**
 * How a table tab's grid was left, kept in the tab's metadata so a reload opens it the same way:
 * the columns the Columns panel hides, the panel's width, the widths dragged on the header, and
 * whether the rows were shown as a form. The metadata comes back from storage, so anything not
 * shaped as it should be is dropped.
 */

export const TAB_VIEW_FIELD = "gridView";

/** The left panel's width, which its edge drags between these. */
export const PANEL_WIDTH = { min: 170, max: 420, initial: 300 } as const;
/** A tab narrower than this floats the panel over the grid, and starts with it hidden. */
export const FLOATING_PANEL_TAB_WIDTH = 860;

/** What a damaged tab may hand back: not megabytes of column names. */
const CAPS = { columns: 1_000, name: 1_000 } as const;
const COLUMN_WIDTH = { min: 40, max: 2_000 } as const;

export interface TableViewState {
  /** Columns hidden from the grid; they are still read. */
  hidden: string[];
  panelWidth: number;
  columnWidths: Record<string, number>;
  /** DBGate's Form view (F4) in place of the grid: a desktop's; a phone opens a row in its sheet. */
  form: boolean;
}

export const DEFAULT_TABLE_VIEW: TableViewState = { hidden: [], panelWidth: PANEL_WIDTH.initial, columnWidths: {}, form: false };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= CAPS.name;

export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_WIDTH.initial;
  return Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, width)));
}

export function readTabView(metadata: Record<string, unknown> | undefined): TableViewState {
  const kept = metadata?.[TAB_VIEW_FIELD];
  if (!isRecord(kept)) return DEFAULT_TABLE_VIEW;
  const hidden = Array.isArray(kept.hidden) ? [...new Set(kept.hidden.slice(0, CAPS.columns).filter(isName))] : [];
  const panelWidth = typeof kept.panelWidth === "number" ? clampPanelWidth(kept.panelWidth) : PANEL_WIDTH.initial;
  const widths = isRecord(kept.columnWidths)
    ? Object.entries(kept.columnWidths)
      .slice(0, CAPS.columns)
      .flatMap(([name, w]): [string, number][] => (
        isName(name) && typeof w === "number" && Number.isFinite(w) && w >= COLUMN_WIDTH.min && w <= COLUMN_WIDTH.max ? [[name, Math.round(w)]] : []
      ))
    : [];
  // Built from entries, so a column named `__proto__` is a column and not the object's prototype.
  return { hidden, panelWidth, columnWidths: Object.fromEntries(widths), form: kept.form === true };
}

/** The metadata with `view` in it; a view with nothing to keep leaves no field behind. */
export function withTabView(metadata: Record<string, unknown> | undefined, view: TableViewState): Record<string, unknown> {
  const { [TAB_VIEW_FIELD]: _drop, ...rest } = metadata ?? {};
  const keep: Partial<TableViewState> = {};
  if (view.hidden.length) keep.hidden = view.hidden;
  if (view.panelWidth !== PANEL_WIDTH.initial) keep.panelWidth = view.panelWidth;
  if (Object.keys(view.columnWidths).length) keep.columnWidths = view.columnWidths;
  if (view.form) keep.form = true;
  return Object.keys(keep).length ? { ...rest, [TAB_VIEW_FIELD]: keep } : rest;
}
