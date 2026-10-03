/** Shared types for the Glide Data Grid wrapper the database tabs use */
import type { Changeset, RowKey } from "../../../shared/db-changeset";
import type { GridSort } from "../../../shared/db-grid";
import type { GridExportTicket } from "../../../shared/db-grid-export";
import type { FilterableColumn } from "../../../shared/db-filter-parser";
import type { DialectName } from "../../../shared/db-types";
import type { ColumnKind } from "../../../shared/db-column-kind";
import type { DbTabPlace } from "./explorer/open-db-tabs";
import type { LookupSource } from "./grid/dictionary-lookup-dialog";
import type { FilterDialogRequest } from "./grid/filter-funnel-menu";
import type { FormNavigation } from "./grid/form-view-model";
import type { ReferencedRow } from "./grid/form-view";
import type { GridFilters } from "./grid/grid-filters";
import type { GridExport } from "./export-button";

/** Every change a grid saves at once: its edited rows, new rows and rows to delete. */
export type GridChanges = Required<Pick<Changeset, "inserts" | "updates" | "deletes">>;

/** A row's key: the values of the columns that address it. */
export function rowKeyOf(row: Record<string, unknown>, keyCols: readonly string[]): RowKey {
  return Object.fromEntries(keyCols.map((c) => [c, row[c]]));
}

/** Unified column schema — superset of DbColumnInfo and sqlite ColumnInfo */
export interface GridColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue?: string | null;
  /** The database fills it in when a row is inserted without it, as the server read the catalog. */
  autoIncrement?: boolean;
  fk?: { table: string; column: string } | null;
}

/** A table view's filters, as the filter row shows and edits them. The server applies them. */
export interface GridFiltering {
  filters: GridFilters;
  /** How every column of the table reads a filter, hidden ones included. */
  columns: readonly FilterableColumn[];
  /** Takes an update rather than a value: two cells can commit before the grid re-renders. */
  onChange: (update: (filters: GridFilters) => GridFilters) => void;
  /** Why the server refused the filter in force on a column, by column name. */
  errors?: Readonly<Record<string, string>>;
  /** A funnel item that opens a dialog — `null` for the Multi column filter's; `returnFocus` puts focus back in the box. */
  onDialog?: (column: string | null, request: FilterDialogRequest, returnFocus: () => void) => void;
  /** ⋮ and — on a foreign key — ⋯ in a column's filter box; `returnFocus` as for `onDialog`. */
  onChooseValues?: (column: string, returnFocus: () => void) => void;
  onLookup?: (column: string, returnFocus: () => void) => void;
  /** On a phone, a column's title and ⌄ open its filter sheet rather than the column menu. */
  onColumnSheet?: (column: string) => void;
}

/** DBGate's "Rows: N" for a table: what is known of its row count. */
export interface RowCountView {
  /** "Rows: 5,231", "Rows: ~1,204,000" (the database's estimate), "Rows: 100+" (a lower bound) or "Rows: Many". */
  text: string;
  /** A count is running. */
  counting: boolean;
  /** The background count gave up or failed: the label counts again, with no short time limit. */
  canCountExactly: boolean;
  /** Why the number is not exact. */
  title?: string;
  /** What the text says as a number, for the form view's "Row: 2 / 14". */
  total?: RowTotal;
}

/** The table's row count as far as it is known. */
export type RowTotal =
  | { kind: "exact"; count: number }
  /** The database's statistics, until the rows are counted. */
  | { kind: "estimate"; count: number }
  /** The rows loaded so far, which the count has not reached past yet. */
  | { kind: "atLeast"; count: number }
  /** The count gave up or failed. */
  | { kind: "many" };

/** What a table's toolbar and panel read from its grid: DBGate's Save, Revert all, New row and Delete row(s). */
export interface GridEditState {
  /** Rows Save would write: edited rows, rows to delete and new rows something was put in. */
  pending: number;
  /** New rows not saved yet: while there are any, no more rows are read. */
  newRows: number;
  /** Rows the selection covers, which Delete row(s) deletes. */
  selectedRows: number;
  /** Columns selected whole, from their titles: the Columns panel lights them. */
  selectedColumns: readonly string[];
  /** Rows can be added and deleted here. */
  canChangeRows: boolean;
  /** A step of the change set to undo, or one undone to redo. */
  canUndo: boolean;
  canRedo: boolean;
  /** DBGate's Cell data view is open beside the grid. */
  cellData: boolean;
  /**
   * Where the form view stands, while it is shown: First and Previous have nowhere to go from the
   * first row, Next and Last from the last one once no more rows can be read.
   */
  form?: { atFirst: boolean; atLast: boolean };
}

/** The grid's actions, for a toolbar outside it. */
export interface GlideGridHandle {
  save(): void;
  revert(): void;
  newRow(): void;
  /** Marks the rows the selection covers for deletion, which Save carries out. */
  deleteSelectedRows(): void;
  undo(): void;
  redo(): void;
  /** Scroll a column into view and put the cursor in it. */
  scrollToColumn(name: string): void;
  focus(): void;
  /** The form view's First, Previous, Next and Last. */
  formNavigate(to: FormNavigation): void;
  /** A phone's form: the current row — the first, with none — in its bottom sheet. */
  openRowForm(): void;
  /** DBGate's Cell Data: the view of the selection's values beside the grid, shown or put away; a phone's sheet opened. */
  toggleCellData(): void;
}

/** Unified props interface for the Glide Data Grid wrapper component */
export interface GlideGridProps {
  /** Column names in display order */
  columns: string[];
  /** The rows: a table's, as many as are read so far; a query's, all of them. */
  rows: Record<string, unknown>[];
  /** Column schema metadata */
  schema: GridColumnSchema[];
  /** Whether data is currently loading */
  loading: boolean;
  /**
   * Saves changes as one changeset, all or nothing: Save sends every edit, new
   * row and row to delete in one call. Rejects when nothing was saved, after
   * saying why; the changes then stay. Without it, cells cannot be changed.
   */
  onSaveChanges?: (changes: GridChanges) => Promise<void>;
  /** The columns that address a row, for `onSaveChanges` (`GridResponse.rowKey`).
   *  Empty when rows cannot be addressed: the grid is then read-only. */
  rowKey?: string[];
  /** With `onSaveChanges`: cells can be edited, but rows cannot be added or deleted. */
  editOnly?: boolean;
  /** Block all cell editing — cells stay viewable/copyable but cannot be changed.
   *  Set when there is nowhere to write the edit back to (ad-hoc query results
   *  whose source table can't be determined, readonly connections). */
  readOnly?: boolean;
  /** The sort in force, in order: the titles show it, the column menu changes it. Absent where rows cannot be sorted. */
  sort?: readonly GridSort[];
  onSortChange?: (sort: GridSort[]) => void;
  /**
   * Changes whenever the rows shown start over — another sort or filter, a refresh — when the grid
   * goes back to its first row and drops its selection, which named rows no longer there.
   */
  viewKey?: unknown;
  /** More rows exist past the ones read: scrolling to the last of them asks for the next ones. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** The next rows are being read: DBGate's "Loading data" under the grid. */
  loadingMore?: boolean;
  /** How many rows a Fetch all has read so far, while it runs. */
  fetchingAll?: number | null;
  /** Columns the Columns panel hides. They are still read — a hidden key still addresses its row. */
  hiddenColumns?: ReadonlySet<string>;
  /** "Every column is hidden"'s Show all columns. */
  onShowAllColumns?: () => void;
  /** DBGate's Hide column: the columns the selection lies in, hidden as the Columns panel hides them. */
  onHideColumns?: (columns: string[]) => void;
  /** DBGate's Find column: the Columns panel's search box, ready to type in. */
  onFindColumn?: () => void;
  /** Widths dragged on the header, by column, kept by the tab. */
  columnWidths?: Readonly<Record<string, number>>;
  onColumnWidthsChange?: (widths: Record<string, number>) => void;
  /** A table's toolbar takes Save and Revert all out of the grid: the grid then draws no save bar. */
  onEditStateChange?: (state: GridEditState) => void;
  /** The tab the grid is in, which shows the unsaved dot and asks before closing while Save has rows to write. */
  tabId?: string;
  /** Which of the tab's grids this is when it holds two — the reference shown under a table: their unsaved rows add up. */
  tabSlot?: string;
  /**
   * The rows the selection covers, as they were read — the form view's, the row it shows — for the
   * reference shown under the grid, which follows them. Called again whenever they change.
   */
  onSelectedRowsChange?: (rows: readonly Record<string, unknown>[]) => void;
  /** "Rows: N" in the grid's corner, where two grids share a tab and the status bar can name only one. */
  rowsLabel?: string;
  /** DBGate's « at the grid's corner, which shows and hides the panel beside it. */
  sidePanel?: { open: boolean; onToggle: () => void };
  /** "No rows loaded"'s Reset filter, shown only while a filter is in force. */
  onResetFilter?: () => void;
  /** "No rows loaded"'s Open Query: a Query tab on the table. */
  onOpenQuery?: () => void;
  /** DBGate's Generate SQL, a table's alone: the SQL its dialog writes, which opens in a new Query tab. */
  onOpenGeneratedSql?: (sql: string) => void;
  /** The cell menu's Export ▸, the toolbar's own: every row the filters select, not only the ones loaded. */
  exporter?: GridExport;
  /**
   * DBGate's focusOnVisible: the grid's tab is the one in front, where the user works. Turning true —
   * the tab just opened or picked — and on mounting so, the grid or the form takes the keys.
   */
  focusOnVisible?: boolean;
  /**
   * Save cell to file for bytes the grid has only the start of: the server finds the row again by
   * `key`, reads `column` whole and answers the ticket its file downloads with — null when no table
   * is shown. Without it, such bytes are refused.
   */
  startCellDownload?: (column: string, key: RowKey, fileName: string) => Promise<GridExportTicket | null>;
  /** Open a table a foreign key refers to: the column menu's last item. */
  onOpenTable?: (table: string) => void;
  /** DBGate's filter row under the column titles; absent where the rows cannot be filtered. */
  filtering?: GridFiltering;
  /** ⋯ in a foreign key cell's editor: the table it refers to, to pick the value from. */
  lookupFor?: (column: string) => { source: LookupSource; kind: ColumnKind } | null;
  /** Where the rows come from: a foreign key followed opens a Query tab there. */
  place?: DbTabPlace;
  selectedTable?: string | null;
  selectedSchema?: string;
  connectionName?: string;
  /** How the connection spells SQL, for the query a foreign key opens. */
  dialect?: DialectName;
  /** DBGate's Form view (F4) in place of the grid, on a desktop. A phone's form is its bottom sheet. */
  view?: "table" | "form";
  /** The form's Switch to table. */
  onViewChange?: (view: "table" | "form") => void;
  /** The form view's Column name filter, which the Filters panel shows and a letter typed on a name adds to. */
  formNameFilter?: string;
  onFormNameFilterChange?: (text: string) => void;
  /** "Rows: N" as the table knows it, for the form's "Row: 2 / 14". */
  rowCount?: RowCountView | null;
  /** Every remaining row, for the form's Last; resolves true once every row is loaded. */
  onFetchAll?: () => Promise<boolean>;
  /** ⊞ on a foreign key in the form: the row it refers to. */
  loadReference?: (column: string, row: Record<string, unknown>) => Promise<ReferencedRow>;
  /** A foreign key followed: the referenced row as a form, in a new tab. Without it, a Query tab reads the row. */
  onOpenReference?: (column: string, row: Record<string, unknown>) => void;
  /** The form's Filter this value: the column's filter set to the value. */
  onFilterValue?: (column: string, value: unknown) => void;
  /** The form's Add to filter: the column's filter box in the Filters panel. */
  onAddToFilter?: (column: string) => void;
  /** The form's Refresh. */
  onRefresh?: () => void;
  /** A narrow tab's: the Cell data view floats over the grid rather than squeezing it. */
  floatCellData?: boolean;
}

/**
 * A column the database fills in itself — serial, identity, AUTO_INCREMENT, SQLite's INTEGER PRIMARY
 * KEY — as the server read it from the catalog. Never guessed from the type: an `integer` key with
 * no default is SQLite's rowid alias, and on Postgres a key nothing fills in.
 */
export function isAutoIncrement(col: GridColumnSchema): boolean {
  return col.autoIncrement === true;
}

/** Format cell value for display — JSON-stringify objects, otherwise String() */
export function formatCellValue(val: unknown): string {
  if (val == null) return "NULL";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}
