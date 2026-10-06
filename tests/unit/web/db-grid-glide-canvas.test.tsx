/**
 * What the data grid owes Glide's canvas, which acts on two signals and nothing else.
 *
 * Its region: a table's next 100 rows are read when its last loaded row is scrolled into view, and
 * only then. The rows starting over (F5, a sort, a filter) send the grid back to the top, and Glide
 * reports on the new rows before that happens — in the commit that brings them, from a layout
 * effect, which runs before the grid's own effects, with the scroll position the browser has just
 * cut short at the new rows' end. Taken as it came, that was the new rows' last row in view, and F5
 * at the bottom of a table read 100 more rows nobody had scrolled to (measured in a browser:
 * `[0, 100]` then `[100, 100]`).
 *
 * Its picture: Glide draws again only when its blit check (`computeCanBlit`) finds that one of the
 * props it compares has changed. The rows `getCellContent` reads through refs are not one, nor is
 * the header drawer, so a sort with as many rows as before left the old rows and the old sort's
 * titles on screen — while the accessibility table under the canvas, rendered by React, already
 * read the new ones (seen in a browser, 4 s after the rows had arrived).
 *
 * And its change set across a save: the server refusing one leaves every change where it was, and
 * one that succeeds is emptied only once the rows saved are read again, so F5 alone never loses one.
 * Then DBGate's changes to the selected rows, from the cell menu and the keys, and the marks the
 * grid draws over Glide's cells for them.
 *
 * Glide draws on a canvas and happy-dom lays nothing out, so its editor is replaced by one that
 * reports and draws the way Glide 6.0.3 does (`infinite-scroller.js`, `scrolling-data-grid.js`,
 * `data-grid-render.blit.js`) — only while this file runs: `mock.module` outlives it, and the
 * other database suites mount the real editor.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// The grid's theme follows <html>'s class with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);
// Where the cell menu is portalled to, as in the app.
document.body.insertAdjacentHTML("beforeend", '<div id="portal"></div>');

const { act, createRef, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } = await import("react");

// A copy: the mock replaces the module's exports in place.
const realGlide = { ...(await import("@glideapps/glide-data-grid")) };
const { CompactSelection, GridCellKind } = realGlide;
let stubbing = true;
afterAll(() => { stubbing = false; });

type Item = readonly [number, number];
type Region = { x: number; y: number; width: number; height: number };
type Cell = { displayData?: string; data?: unknown };
type StubProps = {
  rows: number;
  columns: readonly unknown[];
  theme?: unknown;
  headerHeight?: number;
  gridSelection?: unknown;
  getCellContent: (cell: Item) => Cell;
  drawHeader?: unknown;
  onCellsEdited?: (items: readonly { location: Item; value: unknown }[]) => boolean;
  onGridSelectionChange?: (selection: unknown) => void;
  onCellContextMenu?: (cell: Item, event: {
    preventDefault: () => void; localEventX: number; localEventY: number; bounds: { x: number; y: number }; isTouch?: boolean;
  }) => void;
  onCellClicked?: (cell: Item, event: {
    isTouch: boolean; isLongTouch?: boolean; preventDefault: () => void; localEventX?: number; localEventY?: number; bounds?: Region;
  }) => void;
  onMouseMove?: (args: { kind: string; location: Item; localEventX: number; localEventY: number; bounds: Region }) => void;
  getRowThemeOverride?: (row: number) => object | undefined;
  drawCell?: (args: {
    ctx: CanvasRenderingContext2D; rect: Region; row: number; col: number; cell?: object; theme?: object; overrideCursor?: (cursor: string) => void;
  }, drawContent: () => void) => void;
  provideEditor?: (cell: Cell) => unknown;
  onVisibleRegionChanged?: (region: Region, tx: number) => void;
};

/** How many rows the grid has room for. */
let viewRows = 20;
/** The first row scrolled to. */
let scrollRow = 0;
/** What the grid was asked to scroll to. */
let scrollCalls: [number, number, string][] = [];
/** The user scrolling the grid: the scroller moves, and the scroll event reports it. */
let userScrollsTo: (row: number) => void = () => {};
/** What is on the canvas: the cells in view, and the header drawer the titles were drawn with. */
let frames: { cells: string[][]; drawHeader: unknown }[] = [];
/** While set, Glide's scroller is not measured yet: its canvas goes in once the test calls what is left here. */
let measureLater: (() => void)[] | null = null;
/** The props the grid handed the editor last. */
let latest: StubProps | null = null;
/** The cells the grid asked Glide to draw again. */
let updated: Item[] = [];
/** What the grid asked Glide to do as if by a key (`emit`). */
let emitted: string[] = [];

/** Where Glide draws a cell on screen: the row numbers, then 100px columns under a 30px header, 34px rows. */
const LAYOUT = { marker: 40, column: 100, header: 30, row: 34 };

const shown = (cell: Cell) => cell.displayData ?? String(cell.data ?? "");
function cellsInView(p: StubProps) {
  const cells: string[][] = [];
  for (let r = scrollRow; r < Math.min(p.rows, scrollRow + viewRows); r++) cells.push(p.columns.map((_, c) => shown(p.getCellContent([c, r]))));
  return cells;
}

const StubEditor = forwardRef<unknown, StubProps>(function StubEditor(props, ref) {
  latest = props;
  const { rows, columns, theme, headerHeight, gridSelection, getCellContent } = props;
  const last = useRef("");
  const report = useRef(props.onVisibleRegionChanged);
  report.current = props.onVisibleRegionChanged;
  const emit = () => {
    const region = { x: 0, y: scrollRow, width: columns.length, height: viewRows };
    const key = `${region.y}:${region.height}`;
    if (key === last.current) return;
    last.current = key;
    report.current?.(region, 0);
  };
  const emitRef = useRef(emit);
  emitRef.current = emit;
  userScrollsTo = (row) => { scrollRow = row; emitRef.current(); };
  // The selection as of the last render, which is what Glide's focus handler reads.
  const rendered = useRef({ gridSelection, onGridSelectionChange: props.onGridSelectionChange });
  rendered.current = { gridSelection, onGridSelectionChange: props.onGridSelectionChange };
  const focused = useRef(false);
  // Glide puts its canvas in once its scroller has been measured, a few frames after the editor
  // mounts (`infinite-scroller.js`), and focus asked for before then goes nowhere.
  const box = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (measureLater) {
      measureLater.push(() => setDrawn(true));
      return;
    }
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setDrawn(true)); });
    return () => cancelAnimationFrame(frame);
  }, []);
  useImperativeHandle(ref, () => ({
    updateCells: (cells: { cell: Item }[]) => { updated.push(...cells.map((c) => c.cell)); },
    emit: async (what: string) => { emitted.push(what); },
    // In the viewport, as Glide's: row -1 is the header.
    getBounds: (col: number, row: number) => {
      const p = latest!;
      if (col >= p.columns.length || row >= p.rows) return undefined;
      const x = LAYOUT.marker + col * LAYOUT.column;
      return row === -1
        ? { x, y: 0, width: LAYOUT.column, height: LAYOUT.header }
        : { x, y: LAYOUT.header + (row - scrollRow) * LAYOUT.row, width: LAYOUT.column, height: LAYOUT.row };
    },
    // As little as it takes to bring the row into view; reported with the next scroll event.
    scrollTo: (col: number, row: number, dir = "both") => {
      scrollCalls.push([col, row, dir]);
      if (dir === "horizontal") return;
      const next = row < scrollRow ? row : row >= scrollRow + viewRows ? row - viewRows + 1 : scrollRow;
      if (next === scrollRow) return;
      scrollRow = next;
      setTimeout(() => emitRef.current(), 0);
    },
    // `onCanvasFocused` (`data-editor.js`): focused with nothing selected, it puts its cursor on the
    // first cell in view — at once, from the selection it last rendered with.
    focus: () => {
      box.current?.focus();
      if (focused.current) return;
      focused.current = true;
      const s = rendered.current.gridSelection as { current?: unknown; rows: { length: number }; columns: { length: number } } | undefined;
      if (s && (s.current !== undefined || s.rows.length || s.columns.length)) return;
      rendered.current.onGridSelectionChange?.({
        columns: CompactSelection.empty(), rows: CompactSelection.empty(),
        current: { cell: [0, scrollRow], range: { x: 0, y: scrollRow, width: 1, height: 1 }, rangeStack: [] },
      });
    },
  }), []);
  // The first report comes once the scroller has been measured.
  useEffect(() => {
    const timer = setTimeout(() => emitRef.current(), 0);
    return () => clearTimeout(timer);
  }, []);
  // Fewer rows: the browser cuts the scroll position short at their end, and Glide reports from a
  // layout effect in the same commit.
  const firstRows = useRef(true);
  useLayoutEffect(() => {
    if (firstRows.current) { firstRows.current = false; return; }
    scrollRow = Math.max(0, Math.min(scrollRow, rows - viewRows));
    emitRef.current();
  }, [rows]);
  // A new picture only when a prop the blit check compares has changed — of those the grid passes,
  // these: the columns by value (`deepEqual`), the rest by identity. Everything else is drawn with
  // whatever is on hand the next time it draws.
  const columnsKey = JSON.stringify(columns);
  useLayoutEffect(() => {
    frames.push({ cells: cellsInView(props), drawHeader: props.drawHeader });
  }, [getCellContent, rows, columnsKey, theme, headerHeight, gridSelection]); // eslint-disable-line react-hooks/exhaustive-deps
  // Glide's canvas sits in its underlay, under the scroller.
  return <div className="dvn-underlay">{drawn && <div ref={box} tabIndex={0} data-stub-editor="" />}</div>;
});

const Editor = forwardRef<unknown, StubProps>(function Editor(props, ref) {
  const Real = realGlide.default as never as typeof StubEditor;
  return stubbing ? <StubEditor ref={ref} {...props} /> : <Real ref={ref} {...props} />;
});
mock.module("@glideapps/glide-data-grid", () => ({ ...realGlide, default: Editor, DataEditor: Editor }));

const { GlideDataGrid } = await import("../../../src/web/components/database/glide-data-grid");
const { LONG_PRESS_MS } = await import("../../../src/web/components/database/grid/use-cell-long-press");
const { parseCombo } = await import("../../../src/web/stores/keybindings-store");
const { slotUnsavedRows, unsavedGridRows } = await import("../../../src/web/stores/unsaved-grid-rows-store");
const { NO_FILTERS } = await import("../../../src/web/components/database/grid/grid-filters");
type GridFilters = import("../../../src/web/components/database/grid/grid-filters").GridFilters;
type ColumnKind = import("../../../src/shared/db-column-kind").ColumnKind;
type GlideGridHandle = import("../../../src/web/components/database/glide-grid-types").GlideGridHandle;
type GridSort = import("../../../src/shared/db-grid").GridSort;
type GridExport = import("../../../src/web/components/database/export-button").GridExport;

const SCHEMA = [
  { name: "id", type: "integer", nullable: false, pk: true, defaultValue: null, autoIncrement: true, fk: null },
  { name: "qty", type: "integer", nullable: true, pk: false, defaultValue: null, fk: null },
];
const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, qty: (i * 7) % 10 }));

type View = { columns: string[]; rows: Record<string, unknown>[]; viewKey: number; hasMore: boolean; loading: boolean; sort: GridSort[] };
let setView: (next: Partial<View>) => void = () => {};
/** How often the grid asked for the next rows. */
let asked = 0;
/** What Save does with the change set; the rows saved are not read again by it. */
let save: (changes: unknown) => Promise<void> = async () => {};
/** The rows Save would write, as the toolbar is told. */
let pending = 0;
/** Whether the Cell data view is open beside the grid, as the toolbar is told. */
let cellDataOpen = false;
/** The table's columns, and how a foreign key's ⋯ looks its value up. */
let schema: readonly object[] = SCHEMA;
let lookupFor: ((column: string) => unknown) | undefined;
/** The tab the grid is in. */
let tabId: string | undefined;
let readOnly = false;
/** A Query tab's result: rows edited in place, none added or deleted, and no table view around it. */
let editOnly = false;
/** Which view the tab asks for: the table, or DBGate's form. */
let gridView: "table" | "form" = "table";
/** The second grid of a tab — a reference under the table — and its own "Rows: N". */
let tabSlot: string | undefined;
let rowsLabel: string | undefined;
/** The rows the selection covers, each time the grid reports them; null while nothing listens. */
let reported: Record<string, unknown>[][] | null = null;
const reportRows = (rows: readonly Record<string, unknown>[]) => { reported?.push([...rows]); };
/** A foreign key followed from its cell's button. */
let onOpenReference: ((column: string, row: Record<string, unknown>) => void) | undefined;
/** How the tab's filters read each column; the grid is handed filters only when some are given. */
let filterColumns: { name: string; kind: ColumnKind }[] = [];
/** The tab's filters as the grid last changed them. */
let filtersNow: GridFilters = NO_FILTERS;
/** The tab's Hide column, Find column and Open query, where a test hands the grid them. */
let onHideColumns: ((columns: string[]) => void) | undefined;
let onFindColumn: (() => void) | undefined;
let onOpenQuery: (() => void) | undefined;
/** The table the rows are, Generate SQL's Query tab, and the columns the Columns panel hides. */
let selectedTable: string | undefined;
let onOpenGeneratedSql: ((sql: string) => void) | undefined;
let hiddenColumns: ReadonlySet<string> | undefined;
/** The toolbar's Export, which the cell menu's Export ▸ runs too. */
let exporter: GridExport | undefined;
/** How a table's grid has the server read a cell whole, for Save cell to file. */
let startCellDownload: ((column: string, key: Record<string, unknown>, fileName: string) => Promise<{ ticket: string; fileName: string } | null>) | undefined;
/** The tab is the one in front, whose grid takes the keys. */
let focusOnVisible = false;
const handle = createRef<GlideGridHandle>();

function Harness({ initial }: { initial: View }) {
  const [view, set] = useState(initial);
  setView = (next) => set((v) => ({ ...v, ...next }));
  const [filters, setFilters] = useState<GridFilters>(NO_FILTERS);
  filtersNow = filters;
  const filtering = useMemo(
    () => (filterColumns.length ? { filters, columns: filterColumns, onChange: (update: (f: GridFilters) => GridFilters) => setFilters(update) } : undefined),
    [filters],
  );
  return (
    <GlideDataGrid ref={handle} columns={view.columns} rows={view.rows} schema={schema as typeof SCHEMA} loading={view.loading}
      filtering={filtering} onHideColumns={onHideColumns} onFindColumn={onFindColumn} onOpenQuery={onOpenQuery}
      selectedTable={selectedTable} onOpenGeneratedSql={onOpenGeneratedSql} hiddenColumns={hiddenColumns} exporter={exporter}
      startCellDownload={startCellDownload} focusOnVisible={focusOnVisible}
      lookupFor={lookupFor as never} tabId={tabId} readOnly={readOnly} editOnly={editOnly} view={gridView}
      tabSlot={tabSlot} rowsLabel={rowsLabel} onSelectedRowsChange={reported ? reportRows : undefined} onOpenReference={onOpenReference}
      rowKey={["id"]} onSaveChanges={(changes) => save(changes)} onEditStateChange={(s) => { pending = s.pending; cellDataOpen = s.cellData; }}
      viewKey={view.viewKey} hasMore={view.hasMore} onLoadMore={() => { asked += 1; }}
      sort={view.sort} onSortChange={(sort) => setView({ sort })} />
  );
}

let view: Mounted | null = null;
beforeEach(async () => {
  await view?.unmount();
  view = null;
  viewRows = 20;
  scrollRow = 0;
  scrollCalls = [];
  frames = [];
  latest = null;
  updated = [];
  emitted = [];
  asked = 0;
  save = async () => {};
  pending = 0;
  cellDataOpen = false;
  schema = SCHEMA;
  lookupFor = undefined;
  tabId = undefined;
  readOnly = false;
  editOnly = false;
  gridView = "table";
  tabSlot = undefined;
  rowsLabel = undefined;
  reported = null;
  onOpenReference = undefined;
  filterColumns = [];
  filtersNow = NO_FILTERS;
  onHideColumns = undefined;
  onFindColumn = undefined;
  onOpenQuery = undefined;
  selectedTable = undefined;
  onOpenGeneratedSql = undefined;
  hiddenColumns = undefined;
  exporter = undefined;
  startCellDownload = undefined;
  focusOnVisible = false;
  measureLater = null;
});
afterAll(async () => { await view?.unmount(); });

const settle = () => act(async () => { await Bun.sleep(5); });

async function open(rows: Record<string, unknown>[] | number, hasMore: boolean, columns = ["id", "qty"]) {
  const initial = { columns, rows: typeof rows === "number" ? rowsOf(rows) : rows, viewKey: 1, hasMore, loading: false, sort: [] };
  view = await mount(<Harness initial={initial} />);
  await settle();
}
async function scrollTo(row: number) {
  await act(async () => { userScrollsTo(row); });
  await settle();
}
/**
 * F5, as `useDatabase` answers it: loading, then the first rows of a new view in one render. Their
 * column names are kept: a read that builds a new list of the same names makes the grid draw again
 * through the titles' drawer, and that is not what ought to.
 */
async function refresh(rows: Record<string, unknown>[] | number, hasMore: boolean) {
  await act(async () => { setView({ loading: true }); });
  await act(async () => { setView({ rows: typeof rows === "number" ? rowsOf(rows) : rows, viewKey: 2, hasMore, loading: false }); });
  await settle();
}
/** What is on the canvas, and what the grid would draw there now. */
const onScreen = () => frames.at(-1);
const wouldDraw = () => ({ cells: cellsInView(latest!), drawHeader: latest!.drawHeader });

describe("reading the next rows as the grid is scrolled", () => {
  it("asks once the last row read is in view, not before", async () => {
    await open(100, true);
    await scrollTo(60);
    expect(asked).toBe(0);
    await scrollTo(80);
    expect(asked).toBeGreaterThan(0);
  });

  it("asks for nothing after F5 at the bottom of the table, and goes back to the top", async () => {
    // Every row of a 200-row table read, scrolled to its end; F5 reads the first 100 again.
    await open(200, false);
    await scrollTo(180);
    await refresh(100, true);
    expect(asked).toBe(0);
    expect(scrollCalls).toContainEqual([0, 0, "vertical"]);
    expect(scrollRow).toBe(0);
    // And scrolling to the end of the rows read again asks for the next ones.
    await scrollTo(80);
    expect(asked).toBeGreaterThan(0);
  });

  it("asks for nothing after F5 with as many rows as before, scrolled to their end", async () => {
    // No change of rows: Glide reports nothing until the scroll to the top.
    await open(100, false);
    await scrollTo(80);
    await refresh(100, true);
    expect(asked).toBe(0);
    expect(scrollRow).toBe(0);
  });

  it("asks after F5 at the top of a grid with room for every row read, where nothing scrolls", async () => {
    viewRows = 150;
    // The table grew past the rows read.
    await open(100, false);
    await refresh(100, true);
    expect(asked).toBeGreaterThan(0);
  });
});

describe("drawing what changed", () => {
  it("draws the rows read again when there are as many as before", async () => {
    await open(100, true);
    expect(onScreen()?.cells[0]).toEqual(["1", "0"]);
    // Sorted the other way: the same hundred rows, last first.
    await refresh(rowsOf(100).reverse(), true);
    expect(onScreen()).toEqual(wouldDraw());
    expect(onScreen()?.cells[0]).toEqual(["100", "3"]);
  });

  it("draws the titles again when the sort changes, before any row arrives", async () => {
    await open(100, true);
    await act(async () => { setView({ sort: [{ column: "qty", dir: "DESC" }], loading: true }); });
    expect(onScreen()?.drawHeader).toBe(latest!.drawHeader);
  });

  it("draws the values read when the edits are reverted", async () => {
    await open(100, true);
    // Glide draws an edited cell again itself, from the damage it records.
    await act(async () => { latest!.onCellsEdited?.([{ location: [1, 0], value: { kind: GridCellKind.Number, data: 42, displayData: "42", allowOverlay: true } }]); });
    frames.push({ cells: cellsInView(latest!), drawHeader: latest!.drawHeader });
    expect(onScreen()?.cells[0]).toEqual(["1", "42"]);
    await act(async () => { handle.current!.revert(); });
    expect(onScreen()).toEqual(wouldDraw());
    expect(onScreen()?.cells[0]).toEqual(["1", "0"]);
  });
});

describe("saving", () => {
  const editQty = () => act(async () => {
    latest!.onCellsEdited?.([{ location: [1, 0], value: { kind: GridCellKind.Number, data: 42, displayData: "42", allowOverlay: true } }]);
  });
  const saveNow = async () => {
    await act(async () => { handle.current!.save(); });
    await settle();
  };

  it("keeps the changes over F5: the rows read again are the same rows", async () => {
    await open(100, true);
    await editQty();
    await refresh(100, true);
    expect(wouldDraw().cells[0]).toEqual(["1", "42"]);
    expect(pending).toBe(1);
  });

  it("keeps every change when the save is refused, and after the rows are read again", async () => {
    save = async () => { throw new Error("refused"); };
    await open(100, true);
    await editQty();
    await saveNow();
    await refresh(100, true);
    expect(wouldDraw().cells[0]).toEqual(["1", "42"]);
    expect(pending).toBe(1);
  });

  it("sends one change set, and empties it once the rows saved are read again", async () => {
    let sent: unknown = null;
    save = async (changes) => { sent = changes; };
    await open(100, true);
    await editQty();
    await saveNow();
    expect(sent).toEqual({ inserts: [], updates: [{ key: { id: 1 }, set: { qty: 42 }, original: { qty: 0 } }], deletes: [] });
    // Until then the rows on hand are from before the save, and the change is still what shows its value.
    expect(wouldDraw().cells[0]).toEqual(["1", "42"]);
    expect(pending).toBe(1);
    await refresh(rowsOf(100).map((r) => (r.id === 1 ? { ...r, qty: 42 } : r)), true);
    expect(pending).toBe(0);
    expect(latest!.getCellContent([1, 0])).toMatchObject({ displayData: "42" });
    expect((latest!.getCellContent([1, 0]) as { themeOverride?: { bgCell?: string } }).themeOverride?.bgCell).toBeUndefined();
  });
});

describe("changing the selected rows", () => {
  type Selection = { rows: { length: number }; current?: { cell: Item } };
  const selection = () => latest!.gridSelection as Selection;
  const selectRows = (...rows: number[]) => act(async () => {
    latest!.onGridSelectionChange?.({ columns: CompactSelection.empty(), rows: rows.reduce((sel, r) => sel.add(r), CompactSelection.empty()) });
  });
  const selectCells = (x: number, y: number, width: number, height: number) => act(async () => {
    latest!.onGridSelectionChange?.({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [x, y], range: { x, y, width, height }, rangeStack: [] },
    });
  });
  const rightClick = (col: number, row: number) => act(async () => {
    latest!.onCellContextMenu?.([col, row], { preventDefault() {}, localEventX: 4, localEventY: 4, bounds: { x: 20, y: 20 } });
  });
  const choose = async (label: string) => {
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.querySelector(".flex-1")?.textContent === label);
    if (!item) throw new Error(`no menu item ${label}`);
    await act(async () => { item.click(); });
  };
  /** The key pressed with the grid focused, as the browser sends it. */
  const press = (combo: string) => act(async () => {
    const c = parseCombo(combo);
    const name = combo.split("+").at(-1)!;
    document.querySelector("[data-stub-editor]")!.dispatchEvent(new KeyboardEvent("keydown", {
      key: name.length === 1 ? name.toLowerCase() : name, ctrlKey: c.ctrl, metaKey: c.meta, altKey: c.alt, shiftKey: c.shift, bubbles: true,
    }));
  });
  const editQty = (row: number, value: number) => act(async () => {
    latest!.onCellsEdited?.([{ location: [1, row], value: { kind: GridCellKind.Number, data: value, displayData: String(value), allowOverlay: true } }]);
  });
  const deleted = (row: number) => latest!.getRowThemeOverride?.(row) !== undefined;
  const saved = async () => {
    let sent: unknown = null;
    save = async (changes) => { sent = changes; };
    await act(async () => { handle.current!.save(); });
    await settle();
    return sent;
  };

  it("acts on the cell right-clicked when it is outside the selection, and on the selection when inside", async () => {
    await open(3, false);
    await selectRows(0);
    await rightClick(1, 2);
    expect(selection().current?.cell).toEqual([1, 2]);
    await choose("Delete selected rows");
    expect([deleted(0), deleted(1), deleted(2)]).toEqual([false, false, true]);
    await selectRows(0, 1);
    await rightClick(1, 1);
    expect(selection().rows.length).toBe(2);
    await choose("Delete selected rows");
    expect([deleted(0), deleted(1), deleted(2)]).toEqual([true, true, true]);
    expect(await saved()).toEqual({ inserts: [], updates: [], deletes: [{ key: { id: 3 } }, { key: { id: 1 } }, { key: { id: 2 } }] });
  });

  it("jumps to a column with the cursor in it, before anything was selected too", async () => {
    await open(3, false);
    await act(async () => { handle.current!.scrollToColumn("qty"); });
    expect(selection().current?.cell).toEqual([1, 0]);
    expect(scrollCalls).toContainEqual([1, 0, "horizontal"]);
  });

  it("drops a new row outright, and the selection that named it", async () => {
    await open(3, false);
    await act(async () => { handle.current!.newRow(); });
    expect(latest!.rows).toBe(4);
    expect(selection().current?.cell).toEqual([1, 3]);
    await act(async () => { handle.current!.deleteSelectedRows(); });
    expect(latest!.rows).toBe(3);
    expect(selection().current).toBeUndefined();
    expect(pending).toBe(0);
  });

  it("clones the selected rows under the rest, leaving out the key the database numbers", async () => {
    await open(3, false);
    await selectRows(0, 1);
    await rightClick(1, 0);
    await choose("Clone rows");
    expect(latest!.rows).toBe(5);
    expect(await saved()).toEqual({ inserts: [{ qty: 0 }, { qty: 7 }], updates: [], deletes: [] });
  });

  it("sets every selected cell that can change to NULL, and leaves the key alone", async () => {
    await open(3, false);
    await selectCells(0, 0, 2, 2);
    await rightClick(0, 1);
    await choose("Set NULL");
    expect(await saved()).toEqual({
      inserts: [], deletes: [],
      updates: [{ key: { id: 1 }, set: { qty: null }, original: { qty: 0 } }, { key: { id: 2 }, set: { qty: null }, original: { qty: 7 } }],
    });
  });

  it("puts the selected rows back with Ctrl+U, which Ctrl+Z undoes and Ctrl+Y does again", async () => {
    await open(3, false);
    await editQty(0, 42);
    await selectRows(1);
    await act(async () => { handle.current!.deleteSelectedRows(); });
    expect(pending).toBe(2);
    await selectRows(0, 1);
    await press("Mod+U");
    expect(pending).toBe(0);
    await press("Mod+Z");
    expect(pending).toBe(2);
    await press("Mod+Y");
    expect(pending).toBe(0);
  });

  it("writes nothing for a new row nothing was put in, as DBGate does", async () => {
    await open(3, false);
    await act(async () => { handle.current!.newRow(); });
    expect(await saved()).toBeNull();
    expect(pending).toBe(0);
  });

  it("reverts every change as one step, which Ctrl+Z takes back", async () => {
    await open(3, false);
    await editQty(0, 42);
    await act(async () => { handle.current!.revert(); });
    expect(pending).toBe(0);
    await press("Mod+Z");
    expect(pending).toBe(1);
    expect(wouldDraw().cells[0]).toEqual(["1", "42"]);
  });

  it("saves with Ctrl+Enter in the grid", async () => {
    await open(3, false);
    let sent: unknown = null;
    save = async (changes) => { sent = changes; };
    await press("Mod+Enter");
    expect(sent).toBeNull();
    await editQty(0, 42);
    await press("Mod+Enter");
    await settle();
    expect(sent).toEqual({ inserts: [], deletes: [], updates: [{ key: { id: 1 }, set: { qty: 42 }, original: { qty: 0 } }] });
  });

  it("draws the strike over a row to be deleted and the bar on an edited cell, over what Glide drew", async () => {
    await open(3, false);
    await editQty(0, 42);
    await selectRows(1);
    await act(async () => { handle.current!.deleteSelectedRows(); });
    const drawn = (row: number, col: number) => {
      const calls: string[] = [];
      const ctx = {
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
        stroke: () => calls.push("strike"), fillRect: () => calls.push("bar"),
      } as unknown as CanvasRenderingContext2D;
      latest!.drawCell?.({ ctx, rect: { x: 0, y: 0, width: 80, height: 30 }, row, col }, () => calls.push("cell"));
      return calls;
    };
    expect(drawn(0, 1)).toEqual(["cell", "bar"]);
    expect(drawn(0, 0)).toEqual(["cell"]);
    expect(drawn(1, 0)).toEqual(["cell", "strike"]);
    expect(drawn(2, 1)).toEqual(["cell"]);
  });
});

describe("⋯ in a foreign key cell", () => {
  const FK_SCHEMA = [...SCHEMA, { name: "customer_id", type: "integer", nullable: true, pk: false, defaultValue: null, fk: { table: "customers", column: "id" } }];
  const CUSTOMERS = {
    table: "customers", keyColumn: "id", description: null, onDescription: () => {},
    columns: async () => [{ name: "id", kind: "number" }, { name: "name", kind: "text" }],
    rows: async () => ({ rows: [{ id: 5, name: "Ann" }, { id: 9, name: "Bo" }], hasMore: false }),
  };
  const byLabel = (label: string) => [...document.body.querySelectorAll<HTMLElement>("[aria-label]")].find((e) => e.getAttribute("aria-label") === label) ?? null;
  const select = (col: number, row: number) => act(async () => {
    latest!.onGridSelectionChange?.({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
    });
  });
  /** The editor Glide would open on the cell, chosen as Glide chooses it: from the cursor. */
  const editorAt = async (col: number, row: number) => {
    await select(col, row);
    return latest!.provideEditor?.(latest!.getCellContent([col, row])) as { editor: (p: object) => React.ReactNode } | undefined;
  };
  /**
   * The editor the cell gets, drawn: whether ⋯ is beside it, and whether Enter ends the edit on the
   * key itself (grid/cell-editor.tsx); null where Glide's own viewer opens.
   */
  const editorParts = async (col: number, row: number) => {
    const result = await editorAt(col, row);
    if (!result) return null;
    const Editor = result.editor;
    const moves: unknown[] = [];
    const editor = await mount(
      <Editor value={latest!.getCellContent([col, row])} onChange={() => {}} onFinishedEditing={(_value: unknown, move: unknown) => moves.push(move)}
        isHighlighted={false} forceEditMode={false} target={{ x: 0, y: 0, width: 80, height: 30 }} theme={{}} />,
    );
    const lookup = !!byLabel("Look the value up in customers");
    await act(async () => { editor.container.querySelector(".contents")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await editor.unmount();
    return { lookup, savesOnEnter: moves.length === 1 };
  };

  beforeEach(() => {
    schema = FK_SCHEMA;
    lookupFor = (column) => (column === "customer_id" ? { kind: "number", source: CUSTOMERS } : null);
  });

  it("is offered only in a foreign key cell that can change, and only with a lookup to open", async () => {
    await open([{ id: 1, qty: 0, customer_id: 5 }, { id: 2, qty: 1, customer_id: 9 }], false, ["id", "qty", "customer_id"]);
    expect(await editorParts(2, 0)).toEqual({ lookup: true, savesOnEnter: true });
    expect(await editorParts(1, 0)).toEqual({ lookup: false, savesOnEnter: true });
    await act(async () => { latest!.onGridSelectionChange?.({ columns: CompactSelection.empty(), rows: CompactSelection.fromSingleSelection(1) }); });
    await act(async () => { handle.current!.deleteSelectedRows(); });
    expect(await editorAt(2, 1)).toBeUndefined();
    // A table the lookup cannot read: no ⋯ that would open nothing.
    lookupFor = () => null;
    await act(async () => { setView({}); });
    expect(await editorParts(2, 0)).toEqual({ lookup: false, savesOnEnter: true });
  });

  it("gives every cell that can change the editor Enter saves from, with no lookups at all, and a read-only grid's none", async () => {
    lookupFor = undefined;
    await open([{ id: 1, qty: 0, customer_id: 5 }], false, ["id", "qty", "customer_id"]);
    expect(await editorParts(1, 0)).toEqual({ lookup: false, savesOnEnter: true });
    await view!.unmount();
    readOnly = true;
    await open([{ id: 1, qty: 0, customer_id: 5 }], false, ["id", "qty", "customer_id"]);
    expect(await editorAt(1, 0)).toBeUndefined();
  });

  it("puts the row picked into the cell, as one change", async () => {
    await open([{ id: 1, qty: 0, customer_id: 5 }], false, ["id", "qty", "customer_id"]);
    const result = await editorAt(2, 0);
    let finished = 0;
    const Editor = result!.editor;
    const editor = await mount(
      <Editor value={latest!.getCellContent([2, 0])} onChange={() => {}} onFinishedEditing={() => { finished += 1; }}
        isHighlighted={false} forceEditMode={false} target={{ x: 0, y: 0, width: 80, height: 30 }} theme={{}} />,
    );
    await click(byLabel("Look the value up in customers"));
    await settle();
    expect(finished).toBe(1);
    await click(byLabel("Pick 9 Bo"));
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "OK")!);
    await settle();
    expect(pending).toBe(1);
    let sent: unknown = null;
    save = async (changes) => { sent = changes; };
    await act(async () => { handle.current!.save(); });
    await settle();
    expect(sent).toEqual({ inserts: [], deletes: [], updates: [{ key: { id: 1 }, set: { customer_id: 9 }, original: { customer_id: 5 } }] });
    await editor.unmount();
  });
});

// Where a cell is drawn, and a finger on it.
const at = (col: number, row: number) => ({
  x: LAYOUT.marker + col * LAYOUT.column + LAYOUT.column / 2, y: LAYOUT.header + row * LAYOUT.row + LAYOUT.row / 2,
});
const surface = () => document.querySelector<HTMLElement>("[data-stub-editor]")!;
/** A touch event as the browser sends it: the fingers down, and the one that changed. */
const touch = (type: string, point: { x: number; y: number }, target: Element = surface()) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const finger = [{ clientX: point.x, clientY: point.y }];
  Object.defineProperty(e, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : finger });
  Object.defineProperty(e, "changedTouches", { value: finger });
  act(() => { target.dispatchEvent(e); });
  return e;
};

describe("the tab it is in, and a phone's row form", () => {
  const realWidth = window.innerWidth;
  const onPhone = () => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  afterEach(() => { Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true }); });

  const editQty = (row: number, value: number) => act(async () => {
    latest!.onCellsEdited?.([{ location: [1, row], value: { kind: GridCellKind.Number, data: value, displayData: String(value), allowOverlay: true } }]);
  });
  const select = (col: number, row: number) => act(async () => {
    latest!.onGridSelectionChange?.({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
    });
  });
  /** A finger on a cell, as Glide reports it (the row number is column -1), and whether Glide was told to leave the cell alone. */
  const tap = async (col: number, row: number, longTouch = false) => {
    let prevented = false;
    await act(async () => {
      latest!.onCellClicked?.([col, row], { isTouch: true, isLongTouch: longTouch, preventDefault() { prevented = true; } });
    });
    return prevented;
  };
  /** An element as its markup, or null: a failed assertion then prints the markup, not the whole DOM behind it. */
  const html = (el: Element | null | undefined) => el?.outerHTML ?? null;
  const form = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
  const formButton = (label: string) => form()!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const field = (column: string) => {
    const label = [...form()!.querySelectorAll("label")].find((l) => l.querySelector("span span")?.textContent === column)!;
    return document.getElementById(label.htmlFor) as HTMLInputElement;
  };
  const typeInto = async (column: string, text: string) => {
    const input = field(column);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); });
  };

  it("tells its tab how many rows Save would write, and nothing once the grid has gone", async () => {
    tabId = "database:5::public:t";
    await open(3, false);
    expect(unsavedGridRows(tabId)).toBe(0);
    await editQty(0, 42);
    await editQty(2, 7);
    expect(unsavedGridRows(tabId)).toBe(2);
    // A new row nothing was put in is no row to write, as Save counts it.
    await act(async () => { handle.current!.newRow(); });
    expect(unsavedGridRows(tabId)).toBe(2);
    await view!.unmount();
    view = null;
    expect(unsavedGridRows(tabId)).toBe(0);
  });

  it("opens a row as a form when a cell is tapped on a phone, but not from its number or a long press", async () => {
    onPhone();
    await open(3, false);
    await tap(-1, 1);
    await tap(1, 1, true);
    expect(html(form())).toBeNull();
    await tap(1, 1);
    expect(form()!.querySelector("h2")!.textContent).toBe("id = 2Row 2 / 3");
    expect(field("qty").value).toBe("7");
  });

  it("keeps a tap on a phone from acting on the cell too, as a boolean's checkbox would under the form", async () => {
    onPhone();
    await open(3, false);
    // Glide toggles a checkbox the tap lands in, unless told not to; the row's form is the way to change it.
    expect(await tap(1, 0, true)).toBe(true);
    expect(html(form())).toBeNull();
    expect(await tap(1, 0)).toBe(true);
    expect(form()!.querySelector("h2")!.textContent).toBe("id = 1Row 1 / 3");
  });

  it("opens no row for a finger that scrolled the grid, which Glide reports as a tap when it stayed within a row", async () => {
    onPhone();
    await open(3, false);
    const scrolled: Array<[string, () => void]> = [
      ["moved past the tolerance", () => {
        touch("touchmove", { x: at(1, 0).x, y: at(1, 0).y + 30 });
        touch("touchend", { x: at(1, 0).x, y: at(1, 0).y + 30 });
      }],
      ["taken by the browser", () => { act(() => { surface().dispatchEvent(new Event("pointercancel", { bubbles: true })); }); }],
      ["cancelled", () => { touch("touchcancel", at(1, 0)); }],
    ];
    for (const [how, end] of scrolled) {
      touch("touchstart", at(1, 0));
      end();
      // Still told to leave the cell alone: a scroll that ends on a checkbox toggles nothing either.
      expect([how, await tap(1, 0)]).toEqual([how, true]);
      expect([how, html(form())]).toEqual([how, null]);
    }
    // A second finger is a pinch.
    const pinch = new Event("touchstart", { bubbles: true });
    Object.defineProperty(pinch, "touches", { value: [{ clientX: 10, clientY: 50 }, { clientX: 90, clientY: 90 }] });
    act(() => { surface().dispatchEvent(pinch); });
    touch("touchend", at(1, 0));
    await tap(1, 0);
    expect(html(form())).toBeNull();
    // A finger that only trembles still taps, and the next touch is judged afresh.
    touch("touchstart", at(1, 0));
    touch("touchmove", { x: at(1, 0).x + 5, y: at(1, 0).y + 5 });
    touch("touchend", at(1, 0));
    await tap(1, 0);
    expect(form()!.querySelector("h2")!.textContent).toBe("id = 1Row 1 / 3");
  });

  it("shows a read-only grid's row with every field closed, and nothing to save", async () => {
    onPhone();
    readOnly = true;
    await open(3, false);
    await tap(1, 0);
    expect([field("id").readOnly, field("qty").readOnly]).toEqual([true, true]);
    expect(html(form()!.querySelector('button[aria-label^="Save"]'))).toBeNull();
  });

  it("opens nothing on a desktop, where a click selects", async () => {
    await open(3, false);
    let prevented = false;
    await act(async () => {
      latest!.onCellClicked?.([1, 1], { isTouch: false, preventDefault() { prevented = true; } });
    });
    expect(html(form())).toBeNull();
    // Glide's own click stands: the cursor goes to the cell, and a second click there edits it.
    expect(prevented).toBe(false);
  });

  it("puts what the form changes in the grid's change set, walks the rows with the grid along, and saves", async () => {
    onPhone();
    let sent: unknown = null;
    save = async (changes) => { sent = changes; };
    await open(3, false);
    await select(1, 0);
    await tap(1, 0);
    await typeInto("qty", "42");
    expect(pending).toBe(1);
    expect(wouldDraw().cells[0]).toEqual(["1", "42"]);
    await click(formButton("Next row"));
    expect(form()!.querySelector("h2")!.textContent).toBe("id = 2Row 2 / 3");
    expect((latest!.gridSelection as { current: { cell: Item } }).current.cell).toEqual([1, 1]);
    expect(scrollCalls.at(-1)).toEqual([1, 1, "vertical"]);
    await click(formButton("Save 1 changed row"));
    await settle();
    expect(html(form())).toBeNull();
    expect(sent).toEqual({ inserts: [], deletes: [], updates: [{ key: { id: 1 }, set: { qty: 42 }, original: { qty: 0 } }] });
  });

  it("keeps the form's keys to the form: Ctrl+Enter in a field saves nothing", async () => {
    onPhone();
    let sent: unknown = null;
    save = async (changes) => { sent = changes; };
    await open(3, false);
    await editQty(2, 7);
    await tap(1, 0);
    await act(async () => {
      field("qty").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await settle();
    expect(sent).toBeNull();
    expect(pending).toBe(1);
  });

  it("puts the form away when the window grows past a phone's", async () => {
    onPhone();
    await open(3, false);
    await tap(1, 0);
    expect(html(form())).not.toBeNull();
    await act(async () => {
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(html(form())).toBeNull();
  });

  it("closes the form when the rows start over: the row it showed may be gone", async () => {
    onPhone();
    await open(3, false);
    await tap(1, 2);
    expect(html(form())).not.toBeNull();
    await refresh(3, false);
    expect(html(form())).toBeNull();
  });
});

describe("the form view", () => {
  const form = () => document.body.querySelector<HTMLElement>('[role="grid"][aria-label$="as a form"]')!;
  const label = () => [...document.body.querySelectorAll('[role="status"]')].map((e) => e.textContent).find((t) => t?.startsWith("Row"));
  const idShown = () => [...form().querySelectorAll("tr")].find((tr) => tr.querySelector('[role="rowheader"]')?.textContent?.startsWith("id"))!
    .querySelector('[role="gridcell"]')!.textContent;
  const next = () => act(async () => {
    form().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, bubbles: true, cancelable: true }));
  });

  it("keeps to its row when the rows are read again in another order, and starts at the top for a new view", async () => {
    gridView = "form";
    await open(3, false);
    await next();
    expect([label(), idShown()]).toEqual(["Row: 2 / ???", "2"]);
    // Save reads the rows again in place, and Postgres hands back the row it has just updated last.
    const [a, b, c] = rowsOf(3);
    await act(async () => { setView({ rows: [a!, c!, { ...b!, qty: 42 }] }); });
    await settle();
    expect([label(), idShown()]).toEqual(["Row: 3 / ???", "2"]);
    // Rows read again with that row gone: the place is kept.
    await act(async () => { setView({ rows: [a!, c!] }); });
    await settle();
    expect([label(), idShown()]).toEqual(["Row: 2 / ???", "3"]);
    // Another sort or filter: the top, as the grid goes.
    await refresh([a!, c!, b!], false);
    expect([label(), idShown()]).toEqual(["Row: 1 / ???", "1"]);
  });

  it("gives the grid the keys back on the way out, once Glide has drawn its canvas, on the form's row", async () => {
    gridView = "form";
    await open(3, false);
    await next();
    // The form's cursor down a field, onto qty: the grid's cursor comes back in that column.
    await act(async () => { form().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    gridView = "table";
    await act(async () => { setView({}); });
    await act(async () => { await Bun.sleep(120); });
    expect(document.activeElement?.hasAttribute("data-stub-editor")).toBe(true);
    expect((latest!.gridSelection as { current?: { cell: Item } }).current?.cell).toEqual([1, 1]);
  });
});

describe("the Cell data view", () => {
  const realWidth = window.innerWidth;
  const onPhone = () => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  afterEach(() => { Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true }); });

  const cellView = () => document.body.querySelector<HTMLElement>("[data-cell-data-view]");
  const sheet = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
  const selectRows = (...rows: number[]) => act(async () => {
    latest!.onGridSelectionChange?.({ columns: CompactSelection.empty(), rows: rows.reduce((sel, r) => sel.add(r), CompactSelection.empty()) });
  });
  const select = (col: number, row: number) => act(async () => {
    latest!.onGridSelectionChange?.({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
    });
  });
  const rightClick = (col: number, row: number) => act(async () => {
    latest!.onCellContextMenu?.([col, row], { preventDefault() {}, localEventX: 4, localEventY: 4, bounds: { x: 20, y: 20 } });
  });
  /** The cell menu as drawn, a separator as —. */
  const menu = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] > *')]
    .map((el) => (el.getAttribute("role") === "separator" ? "—" : el.querySelector(".flex-1")?.textContent));
  const choose = async (label: string) => {
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.querySelector(".flex-1")?.textContent === label);
    if (!item) throw new Error(`no menu item ${label}`);
    await act(async () => { item.click(); });
  };
  const editQty = (row: number, value: number) => act(async () => {
    latest!.onCellsEdited?.([{ location: [1, row], value: { kind: GridCellKind.Number, data: value, displayData: String(value), allowOverlay: true } }]);
  });
  const toggle = () => act(async () => { handle.current!.toggleCellData(); });
  const typeInto = (box: HTMLTextAreaElement, text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("opens beside the grid when a row is selected whole, and again for the next selection once put away", async () => {
    await open(3, false);
    await select(1, 0);
    expect(cellView()).toBeNull();
    await selectRows(1);
    expect(cellView()!.querySelector("select")!.options[0]!.textContent).toBe("Autodetect - Form");
    expect(cellDataOpen).toBe(true);
    await click(cellView()!.querySelector('button[aria-label="Close the cell data view"]'));
    expect([cellView(), cellDataOpen]).toEqual([null, false]);
    await select(1, 2);
    expect(cellView()).toBeNull();
    await selectRows(2);
    expect(cellView()).not.toBeNull();
    // The toolbar's Cell Data puts it away and brings it back.
    await toggle();
    expect(cellView()).toBeNull();
    await toggle();
    expect(cellView()).not.toBeNull();
  });

  it("shows what a cell holds now, and puts what is typed there in the change set, which Ctrl+S saves", async () => {
    let sent: unknown = null;
    save = async (changes) => { sent = changes; };
    await open(3, false);
    await editQty(0, 42);
    await select(1, 0);
    await toggle();
    const box = cellView()!.querySelector("textarea")!;
    expect(box.value).toBe("42");
    await typeInto(box, "5");
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(pending).toBe(1);
    expect(wouldDraw().cells[0]).toEqual(["1", "5"]);
    expect(sent).toEqual({ inserts: [], deletes: [], updates: [{ key: { id: 1 }, set: { qty: 5 }, original: { qty: 0 } }] });
  });

  it("shows a new row's fields nothing was put in as no field at all", async () => {
    await open(1, false);
    await act(async () => { handle.current!.newRow(); });
    await selectRows(1);
    await act(async () => {
      const box = cellView()!.querySelector("select")!;
      box.value = "jsonRow";
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // The key is the new row's own id, which no row in the database has: there is nothing to show.
    expect(cellView()!.querySelector('[role="tree"]')!.textContent).toBe("{}");
  });

  it("is in the cell menu, a read-only grid's too, and shows the cell right-clicked", async () => {
    await open(3, false);
    await rightClick(1, 2);
    expect(menu().slice(-6)).toEqual(["Set NULL", "—", "Edit cell value", "Add JSON document", "Edit row as JSON document", "Show cell data"]);
    await choose("Show cell data");
    expect(cellView()!.querySelector("textarea")!.value).toBe("4");
    await view!.unmount();
    readOnly = true;
    await open(3, false);
    await rightClick(1, 0);
    expect(menu()).toEqual(["Copy without headers", "Copy advanced", "—", "Show cell data"]);
    await choose("Show cell data");
    expect(cellView()!.querySelector("textarea")!.readOnly).toBe(true);
  });

  it("is not beside the form view, and comes back with the grid", async () => {
    await open(3, false);
    await toggle();
    gridView = "form";
    await act(async () => { setView({}); });
    expect([cellView(), cellDataOpen]).toEqual([null, false]);
    gridView = "table";
    await act(async () => { setView({}); });
    expect([cellView() !== null, cellDataOpen]).toEqual([true, true]);
  });

  it("gives the focus back to the grid when it is closed from inside", async () => {
    await open(3, false);
    await select(1, 0);
    await toggle();
    await act(async () => { await Bun.sleep(50); });
    cellView()!.querySelector("textarea")!.focus();
    await click(cellView()!.querySelector('button[aria-label="Close the cell data view"]'));
    expect(document.activeElement?.hasAttribute("data-stub-editor")).toBe(true);
  });

  it("opens a phone's sheet when asked, never by itself, and none beside the grid", async () => {
    onPhone();
    await open(3, false);
    await selectRows(1);
    expect(sheet()).toBeNull();
    // Nor beside the grid once the window grows past a phone's: the row was selected on the phone.
    await act(async () => {
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(cellView()).toBeNull();
    await act(async () => {
      Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    await toggle();
    expect(sheet()!.querySelector("h2")!.textContent).toBe("Cell data viewFormat: Autodetect - Form");
    expect(cellView()).toBeNull();
    await click([...sheet()!.querySelectorAll("button")].find((b) => b.textContent === "Done")!);
    expect(sheet()).toBeNull();
    // The cell menu's item opens it too.
    await rightClick(1, 2);
    await choose("Show cell data");
    expect(sheet()!.querySelector("textarea")!.value).toBe("4");
  });
});

describe("a reference under the grid, and a foreign key's form button", () => {
  const realWidth = window.innerWidth;
  afterEach(() => { Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true }); });
  const FK_SCHEMA = [...SCHEMA, { name: "customer_id", type: "integer", nullable: true, pk: false, defaultValue: null, fk: { table: "customers", column: "id" } }];
  const ROWS = [{ id: 1, qty: 0, customer_id: 5 }, { id: 2, qty: 1, customer_id: null }, { id: 3, qty: 2, customer_id: 9 }];
  const COLUMNS = ["id", "qty", "customer_id"];
  /** A cell as Glide hands it out: 120x34 at the canvas's origin, so its button is x 97-117, y 7-27. */
  const BOUNDS = { x: 0, y: 0, width: 120, height: 34 };

  const edit = (col: number, row: number, value: number) => act(async () => {
    latest!.onCellsEdited?.([{ location: [col, row], value: { kind: GridCellKind.Number, data: value, displayData: String(value), allowOverlay: true } }]);
  });
  const select = (col: number, row: number, height = 1) => act(async () => {
    latest!.onGridSelectionChange?.({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height }, rangeStack: [] },
    });
  });
  /** A click at `x, y` in a cell; whether the grid kept Glide from acting on it. */
  const clickAt = async (col: number, row: number, x: number, y = 15, isTouch = false, isLongTouch = false) => {
    let prevented = false;
    await act(async () => {
      latest!.onCellClicked?.([col, row], { isTouch, isLongTouch, preventDefault() { prevented = true; }, localEventX: x, localEventY: y, bounds: BOUNDS });
    });
    return prevented;
  };
  const pointAt = (col: number, row: number, x: number, kind = "cell") => act(async () => {
    latest!.onMouseMove?.({ kind, location: [col, row], localEventX: x, localEventY: 15, bounds: BOUNDS });
  });
  const THEME = { cellHorizontalPadding: 8, textLight: "subtle", accentColor: "primary", accentLight: "wash" };
  /** What drawing a cell does on the canvas, and the pointer it asks for. */
  const drawn = (col: number, row: number) => {
    const calls: string[] = [];
    let cursor: string | null = null;
    const ctx = {
      fillStyle: "", globalAlpha: 1,
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, translate() {}, scale() {},
      rect: () => calls.push("clip-rect"), clip: () => calls.push("clip"), roundRect: () => calls.push("wash"),
      fill: (path?: unknown) => { if (path) calls.push(`glyph ${ctx.fillStyle} @${ctx.globalAlpha}`); },
      stroke: () => calls.push("strike"), fillRect: () => calls.push("bar"),
    };
    latest!.drawCell?.({
      ctx: ctx as unknown as CanvasRenderingContext2D, rect: BOUNDS, row, col, cell: latest!.getCellContent([col, row]), theme: THEME,
      overrideCursor: (c) => { cursor = c; },
    }, () => calls.push("cell"));
    // The glyph is several paths, each filled the same way.
    return { calls: calls.filter((c, i) => calls.indexOf(c) === i), cursor };
  };

  beforeEach(() => {
    schema = FK_SCHEMA;
    installGlobal("Path2D", class { constructor(readonly d: string) {} });
  });

  it("files the rows it would write under its own slot, which the tab's count adds to the table's", async () => {
    tabId = "database:5::shop:users";
    tabSlot = "detail";
    await open(3, false);
    await edit(1, 0, 42);
    await edit(1, 2, 7);
    expect([slotUnsavedRows(tabId, "detail"), slotUnsavedRows(tabId), unsavedGridRows(tabId)]).toEqual([2, 0, 2]);
    await view!.unmount();
    view = null;
    expect(unsavedGridRows(tabId)).toBe(0);
  });

  it("reports the rows selected as they were read: an edit is not saved, and a new row has no key yet", async () => {
    reported = [];
    await open(3, false);
    expect(reported.at(-1)).toEqual([]);
    await select(1, 1);
    expect(reported.at(-1)).toEqual([{ id: 2, qty: 7 }]);
    await select(0, 0, 3);
    expect(reported.at(-1)).toEqual([{ id: 1, qty: 0 }, { id: 2, qty: 7 }, { id: 3, qty: 4 }]);
    await edit(1, 0, 42);
    await select(1, 0);
    expect(reported.at(-1)).toEqual([{ id: 1, qty: 0 }]);
    await act(async () => { handle.current!.newRow(); });
    await select(1, 3);
    expect(reported.at(-1)).toEqual([]);
  });

  it("reports the row the form view shows", async () => {
    reported = [];
    gridView = "form";
    await open(3, false);
    expect(reported.at(-1)).toEqual([{ id: 1, qty: 0 }]);
  });

  it("shows its own Rows: N in its corner when it is handed one, and none in the form view", async () => {
    const corner = () => [...view!.container.querySelectorAll('[role="status"]')].find((e) => e.textContent === "Rows: 3") ?? null;
    await open(3, false);
    expect(corner()).toBeNull();
    await view!.unmount();
    rowsLabel = "Rows: 3";
    await open(3, false);
    expect(corner()).not.toBeNull();
    gridView = "form";
    await act(async () => { setView({}); });
    expect(corner()).toBeNull();
  });

  it("opens the row a key refers to from the button in its cell, and does nothing anywhere else", async () => {
    const opened: [string, Record<string, unknown>][] = [];
    onOpenReference = (column, row) => opened.push([column, row]);
    await open(ROWS, false, COLUMNS);
    // Beside the button: Glide's own click, which puts the cursor there.
    expect(await clickAt(2, 0, 96)).toBe(false);
    expect(await clickAt(2, 0, 100, 5)).toBe(false);
    expect(opened).toEqual([]);
    // On it: the referenced row, and not the editor a second click on the cursor's cell opens.
    expect(await clickAt(2, 0, 97)).toBe(true);
    expect(await clickAt(2, 2, 116)).toBe(true);
    expect(opened).toEqual([["customer_id", ROWS[0]], ["customer_id", ROWS[2]]]);
    // No key there: no button. Nor in a column that is not a key.
    expect(await clickAt(2, 1, 100)).toBe(false);
    expect(await clickAt(1, 0, 100)).toBe(false);
    // A finger held on it is the cell's menu, which Glide reports apart from the click.
    expect(await clickAt(2, 0, 100, 15, true, true)).toBe(false);
    expect(opened).toHaveLength(2);
  });

  it("follows the value the cell shows now, and none in a new row", async () => {
    const opened: [string, Record<string, unknown>][] = [];
    onOpenReference = (column, row) => opened.push([column, row]);
    await open(ROWS, false, COLUMNS);
    await edit(2, 0, 7);
    await clickAt(2, 0, 100);
    expect(opened).toEqual([["customer_id", { id: 1, qty: 0, customer_id: 7 }]]);
    await act(async () => { handle.current!.newRow(); });
    expect(await clickAt(2, 3, 100)).toBe(false);
    expect(opened).toHaveLength(1);
  });

  it("has no button where a key cannot be followed, and none on a phone, whose tap opens the row's form", async () => {
    await open(ROWS, false, COLUMNS);
    expect(await clickAt(2, 0, 100)).toBe(false);
    expect(drawn(2, 0).calls).toEqual(["cell"]);
    await view!.unmount();
    const opened: unknown[] = [];
    onOpenReference = (column, row) => opened.push([column, row]);
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    await open(ROWS, false, COLUMNS);
    // Left alone, as every tap on a phone is: the row's form opens, and the key is not followed.
    expect(await clickAt(2, 0, 100, 15, true)).toBe(true);
    expect(opened).toEqual([]);
    expect(document.body.querySelector('[role="dialog"] h2')?.textContent).toBe("id = 1Row 1 / 3");
    expect(drawn(2, 0).calls).toEqual(["cell"]);
  });

  it("draws the button faint, shown on the cursor's cell, and lit under the pointer, which becomes a hand", async () => {
    onOpenReference = () => {};
    await open(ROWS, false, COLUMNS);
    // The cell's own content is cut off where the button's room begins.
    expect(drawn(2, 0)).toEqual({ calls: ["clip-rect", "clip", "cell", "glyph subtle @0.35"], cursor: null });
    await select(2, 0);
    expect(drawn(2, 0).calls).toEqual(["clip-rect", "clip", "cell", "glyph subtle @1"]);
    await select(0, 0);
    await pointAt(2, 0, 50);
    expect(drawn(2, 0)).toEqual({ calls: ["clip-rect", "clip", "cell", "glyph subtle @1"], cursor: null });
    await pointAt(2, 0, 100);
    expect(drawn(2, 0)).toEqual({ calls: ["clip-rect", "clip", "cell", "wash", "glyph primary @1"], cursor: "pointer" });
    // Only the cell under the pointer: the next key down stays faint.
    expect(drawn(2, 2).calls).toEqual(["clip-rect", "clip", "cell", "glyph subtle @0.35"]);
    // No key, no button; the edit marks are drawn over either.
    expect(drawn(2, 1).calls).toEqual(["cell"]);
    await edit(2, 2, 4);
    expect(drawn(2, 2).calls).toEqual(["clip-rect", "clip", "cell", "glyph subtle @0.35", "bar"]);
  });

  it("draws again the cells the pointer leaves and enters, and nothing when it stays put", async () => {
    onOpenReference = () => {};
    await open(ROWS, false, COLUMNS);
    await pointAt(2, 0, 50);
    expect(updated).toEqual([[2, 0]]);
    await pointAt(2, 0, 60);
    expect(updated).toEqual([[2, 0]]);
    await pointAt(2, 0, 100);
    expect(updated).toEqual([[2, 0], [2, 0], [2, 0]]);
    await pointAt(2, 2, 100);
    expect(updated.slice(3)).toEqual([[2, 0], [2, 2]]);
    // Off the grid's cells, or onto one with no button: the last one is put back.
    await pointAt(2, 2, 100, "header");
    expect(updated.slice(5)).toEqual([[2, 2]]);
    await pointAt(2, 1, 100);
    expect(updated).toHaveLength(6);
  });
});

describe("Ctrl+C and Ctrl+X", () => {
  afterEach(() => localStorage.removeItem("ppm-db-copy-format"));
  const selectCells = (x: number, y: number, width: number, height: number) => act(async () => {
    latest!.onGridSelectionChange?.({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [x, y], range: { x, y, width, height }, rangeStack: [] },
    });
  });
  /** The browser's copy or cut, fired at whatever has the focus, as it does: what it put on the clipboard. */
  const clipboard = async (type: "copy" | "cut", target: Element = document.querySelector("[data-stub-editor]")!) => {
    const data = new window.DataTransfer();
    const e = new window.ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data });
    await act(async () => { target.dispatchEvent(e as never); });
    return { text: data.getData("text/plain"), taken: e.defaultPrevented };
  };
  const editQty = (row: number, value: number) => act(async () => {
    latest!.onCellsEdited?.([{ location: [1, row], value: { kind: GridCellKind.Number, data: value, displayData: String(value), allowOverlay: true } }]);
  });

  it("copies the cells selected as the values they show now, tab-separated, a line per row", async () => {
    await open(3, false);
    await selectCells(0, 0, 2, 2);
    expect(await clipboard("copy")).toEqual({ text: "1\t0\r\n2\t7", taken: true });
    await editQty(0, 42);
    expect((await clipboard("copy")).text).toBe("1\t42\r\n2\t7");
    await selectCells(1, 2, 1, 1);
    expect((await clipboard("copy")).text).toBe("4");
  });

  it("copies in the format Set format chose on this device", async () => {
    localStorage.setItem("ppm-db-copy-format", "csv");
    await open(3, false);
    await selectCells(1, 0, 1, 2);
    expect((await clipboard("copy")).text).toBe("qty\r\n0\r\n7");
  });

  it("leaves a copy anywhere else in the grid to the browser, and does nothing with nothing selected", async () => {
    await open(3, false);
    expect(await clipboard("copy")).toEqual({ text: "", taken: false });
    await selectCells(0, 0, 1, 1);
    // A filter box, a menu button: not the grid's cells.
    const header = document.querySelector('button[aria-label="Column menu: qty"]')!;
    expect(await clipboard("copy", header)).toEqual({ text: "", taken: false });
    expect(await clipboard("copy", document.body)).toEqual({ text: "", taken: false });
  });

  it("cuts by copying and then clearing the cells as Delete does, and only copies where they cannot change", async () => {
    await open(3, false);
    await selectCells(1, 0, 1, 1);
    expect(await clipboard("cut")).toEqual({ text: "0", taken: true });
    expect(emitted).toEqual(["delete"]);
    await view!.unmount();
    emitted = [];
    readOnly = true;
    await open(3, false);
    await selectCells(1, 0, 1, 1);
    expect(await clipboard("cut")).toEqual({ text: "0", taken: true });
    expect(emitted).toEqual([]);
  });
});

describe("the cell menu", () => {
  const realWidth = window.innerWidth;
  const onPhone = () => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
    localStorage.removeItem("ppm-db-copy-format");
  });

  type Selection = { rows: { length: number }; current?: { cell: Item; range: Region } };
  const selection = () => latest!.gridSelection as Selection;
  const selectCells = (x: number, y: number, width: number, height: number) => act(async () => {
    latest!.onGridSelectionChange?.({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [x, y], range: { x, y, width, height }, rangeStack: [] },
    });
  });
  const rightClick = (col: number, row: number, isTouch = false) => act(async () => {
    latest!.onCellContextMenu?.([col, row], { preventDefault() {}, localEventX: 4, localEventY: 4, bounds: { x: 20, y: 20 }, isTouch });
  });
  /** The menu open: the desktop's, or a phone's sheet. */
  const menuBox = () => document.querySelector<HTMLElement>("[data-cell-menu]");
  const menu = () => [...(menuBox()?.children ?? [])]
    .map((el) => (el.getAttribute("role") === "separator" ? "—" : el.querySelector(".flex-1")?.textContent));
  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) => b.querySelector(".flex-1")?.textContent === label);
  /** A tap or a click, as the browser sends one: the pointer goes down first. */
  const tap = (el: Element) => act(async () => {
    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    (el as HTMLElement).click();
  });
  const choose = async (label: string) => {
    const it = item(label);
    if (!it) throw new Error(`no menu item ${label}`);
    await tap(it);
  };
  /** A tap beside the sheet, on its backdrop. */
  const tapBackdrop = () => tap(menuBox()!.closest(".fixed")!);
  /** A phone's sheet: what it says it is for, over the list. */
  const sheetHeading = () => [...menuBox()!.previousElementSibling!.querySelectorAll("p")].map((p) => p.textContent);

  const hold = () => act(async () => { await Bun.sleep(LONG_PRESS_MS + 40); });
  /** What Glide's own listeners on the window would have been told. */
  const glideHears = (type: string) => {
    const heard: Event[] = [];
    const listener = (e: Event) => heard.push(e);
    window.addEventListener(type, listener);
    return { heard, stop: () => window.removeEventListener(type, listener) };
  };

  it("offers DBGate's items for a grid that saves, and acts on the selection", async () => {
    await open(3, false);
    await rightClick(1, 1);
    expect(menu()).toEqual([
      "Copy without headers", "Copy advanced", "—",
      "Save", "Delete selected rows", "Insert new row", "Clone rows", "Set NULL", "—",
      "Edit cell value", "Add JSON document", "Edit row as JSON document", "Show cell data",
    ]);
    // Nothing to save yet: there, greyed, as in DBGate.
    expect(item("Save")!.getAttribute("aria-disabled")).toBe("true");
    expect(item("Delete selected rows")!.getAttribute("data-variant")).toBe("destructive");
  });

  it("exports from Export ▸ in the toolbar's formats: none while every column is hidden, greyed while one starts", async () => {
    const ran: string[] = [];
    exporter = { run: async (format) => { ran.push(format); }, busy: false };
    await open(3, false);
    await rightClick(1, 1);
    expect(menu().slice(-1)).toEqual(["Export"]);
    await tap(item("Export")!);
    const formats = [
      "JSON", "JSON lines/NDJSON", "SQL", "CSV file", "CSV file (semicolon separated)", "CSV file for MS Excel",
      "TSV file (tab separated)", "MS Excel", "XML file",
    ];
    for (const label of formats) expect(item(label)?.getAttribute("aria-disabled")).not.toBe("true");
    await choose("MS Excel");
    expect(ran).toEqual(["xlsx"]);

    exporter = { ...exporter, busy: true };
    await act(async () => { setView({}); });
    await rightClick(1, 1);
    await tap(item("Export")!);
    expect(item("CSV file")!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => { menuBox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

    exporter = { ...exporter, busy: false, unavailable: "Every column is hidden" };
    await act(async () => { setView({}); });
    await rightClick(1, 1);
    expect(item("Export")).toBeUndefined();
  });

  it("holds Export advanced... alone under Export ▸ where there is no quick export, as on a query's result", async () => {
    let advanced = 0;
    exporter = { busy: false, advanced: () => { advanced++; } };
    await open(3, false);
    await rightClick(1, 1);
    expect(menu().slice(-1)).toEqual(["Export"]);
    await tap(item("Export")!);
    expect(item("CSV file")).toBeUndefined();
    await choose("Export advanced...");
    expect(advanced).toBe(1);

    exporter = { busy: false };
    await act(async () => { setView({}); });
    await rightClick(1, 1);
    expect(item("Export")).toBeUndefined();
  });

  it("copies from the menu in the format chosen, which Set format changes for Ctrl+C too", async () => {
    await open(3, false);
    await selectCells(1, 0, 1, 2);
    await rightClick(1, 1);
    await choose("Copy without headers");
    expect(await navigator.clipboard.readText()).toBe("0\r\n7");
    await rightClick(1, 1);
    await tap(item("Copy advanced")!);
    expect(item("Set format: CSV")).toBeDefined();
    await choose("Set format: CSV");
    expect(localStorage.getItem("ppm-db-copy-format")).toBe("csv");
    await rightClick(1, 1);
    expect(menu()[0]).toBe("Copy as CSV");
    await choose("Copy as CSV");
    expect(await navigator.clipboard.readText()).toBe("qty\r\n0\r\n7");
    // An item gives the grid its keys back.
    expect(document.activeElement?.hasAttribute("data-stub-editor")).toBe(true);
  });

  it("opens on a phone where a press is held, in a sheet saying which cell, on the cell held", async () => {
    onPhone();
    await open(3, false);
    await selectCells(0, 0, 1, 1);
    touch("touchstart", at(1, 2));
    await hold();
    expect(selection().current?.cell).toEqual([1, 2]);
    expect(sheetHeading()).toEqual(["qty", "id = 3"]);
    expect(menu()).toEqual([
      "Copy without headers", "Copy advanced", "Switch to form", "—",
      "Save", "Delete selected rows", "Insert new row", "Clone rows", "Set NULL", "—",
      "Edit cell value", "Add JSON document", "Edit row as JSON document", "Show cell data",
    ]);
    // A selection held inside stays, and the sheet says how many cells it is.
    await tapBackdrop();
    expect(menuBox()).toBeNull();
    await selectCells(0, 0, 2, 2);
    touch("touchstart", at(1, 1));
    await hold();
    expect(selection().current?.range).toEqual({ x: 0, y: 0, width: 2, height: 2 });
    expect(sheetHeading()).toEqual(["qty", "id = 2 · 4 cells"]);
  });

  it("stops the lift that ends the press, and the click a browser makes of it, but not the next tap", async () => {
    onPhone();
    await open(3, false);
    touch("touchstart", at(1, 0));
    await hold();
    const glide = glideHears("touchend");
    const lift = touch("touchend", at(1, 0));
    glide.stop();
    // Glide would read it as a tap and select the cell alone; the click would land on the backdrop.
    expect([glide.heard.length, lift.defaultPrevented]).toEqual([0, true]);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => { menuBox()!.closest(".fixed")!.dispatchEvent(click); });
    expect([click.defaultPrevented, menuBox() !== null]).toEqual([true, true]);
    // Only that one: the next tap on an item works.
    await choose("Show cell data");
    expect(menuBox()).toBeNull();
    expect(document.body.querySelector('[role="dialog"] textarea')!.textContent).toBe("0");
  });

  it("lets the next touch through when the browser sends no click after the press", async () => {
    onPhone();
    await open(3, false);
    touch("touchstart", at(1, 0));
    await hold();
    touch("touchend", at(1, 0));
    // No click came. The next tap starts with a touch, and is a tap of its own.
    const next = item("Show cell data")!;
    next.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    const glide = glideHears("touchend");
    const lift = touch("touchend", at(1, 0), next);
    glide.stop();
    expect([glide.heard.length, lift.defaultPrevented]).toEqual([1, false]);
    await choose("Show cell data");
    expect(document.body.querySelector('[role="dialog"] textarea')).not.toBeNull();
  });

  it("is no press when the finger moves away, or when the browser takes the gesture", async () => {
    onPhone();
    await open(3, false);
    touch("touchstart", at(1, 0));
    touch("touchmove", { x: at(1, 0).x + 9, y: at(1, 0).y });
    await hold();
    expect(menuBox()).toBeNull();
    // A scroll that took the gesture: touchcancel, and nothing more for it.
    touch("touchstart", at(1, 0));
    touch("touchcancel", at(1, 0));
    await hold();
    expect(menuBox()).toBeNull();
    touch("touchstart", at(1, 0));
    act(() => { surface().dispatchEvent(new Event("pointercancel", { bubbles: true })); });
    await hold();
    expect(menuBox()).toBeNull();
    // A pinch is not a press either.
    const pinch = new Event("touchstart", { bubbles: true });
    Object.defineProperty(pinch, "touches", { value: [{ clientX: 10, clientY: 10 }, { clientX: 90, clientY: 90 }] });
    act(() => { surface().dispatchEvent(pinch); });
    await hold();
    expect(menuBox()).toBeNull();
    // A finger that only trembles still presses.
    touch("touchstart", at(1, 0));
    touch("touchmove", { x: at(1, 0).x + 5, y: at(1, 0).y + 5 });
    await hold();
    expect(menuBox()).not.toBeNull();
  });

  it("opens nothing held on the header, the row numbers, or past the last row", async () => {
    onPhone();
    await open(3, false);
    for (const point of [{ x: at(1, 0).x, y: LAYOUT.header / 2 }, { x: LAYOUT.marker / 2, y: at(1, 0).y }, at(1, 5)]) {
      touch("touchstart", point);
      await hold();
      expect(menuBox()).toBeNull();
      // The touch stays Glide's.
      const glide = glideHears("touchend");
      touch("touchend", point);
      glide.stop();
      expect(glide.heard.length).toBe(1);
    }
  });

  it("opens at once on the browser's own long press, ignores Glide's, and keeps a mouse's right-click", async () => {
    onPhone();
    await open(3, false);
    // Glide's, told when a finger that moved lifts.
    await rightClick(1, 1, true);
    expect(menuBox()).toBeNull();
    // Android's contextmenu, while the press is still being held.
    touch("touchstart", at(1, 1));
    await rightClick(1, 1, true);
    expect(sheetHeading()).toEqual(["qty", "id = 2"]);
    touch("touchend", at(1, 1));
    await tapBackdrop();
    expect(menuBox()).toBeNull();
    // A narrow window with a mouse in it.
    await rightClick(1, 2);
    expect(sheetHeading()).toEqual(["qty", "id = 3"]);
  });

  it("opens Copy advanced in the sheet's place, with Back to the menu", async () => {
    onPhone();
    await open(3, false);
    touch("touchstart", at(1, 1));
    await hold();
    await choose("Copy advanced");
    expect(sheetHeading()).toEqual(["Copy advanced", "qty"]);
    expect(menu().slice(0, 4)).toEqual(["Back", "—", "Copy with headers", "Copy without headers"]);
    await choose("Back");
    expect(sheetHeading()).toEqual(["qty", "id = 2"]);
    await choose("Copy advanced");
    await choose("Copy as JSON");
    expect(menuBox()).toBeNull();
    expect(await navigator.clipboard.readText()).toBe('[\n  {\n    "qty": 7\n  }\n]');
  });

  it("leaves nothing armed once the grid has gone", async () => {
    onPhone();
    await open(3, false);
    touch("touchstart", at(1, 1));
    await view!.unmount();
    view = null;
    await hold();
    expect(menuBox()).toBeNull();
    await open(3, false);
    touch("touchstart", at(1, 1));
    await hold();
    await view!.unmount();
    view = null;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });
});

describe("DBGate's commands on the selection", () => {
  type Selection = { rows: { length: number }; current?: { cell: Item; range: Region } };
  const selection = () => latest!.gridSelection as Selection;
  const selectRows = (...rows: number[]) => act(async () => {
    latest!.onGridSelectionChange?.({ columns: CompactSelection.empty(), rows: rows.reduce((sel, r) => sel.add(r), CompactSelection.empty()) });
  });
  const selectCells = (x: number, y: number, width: number, height: number) => act(async () => {
    latest!.onGridSelectionChange?.({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [x, y], range: { x, y, width, height }, rangeStack: [] },
    });
  });
  const rightClick = (col: number, row: number) => act(async () => {
    latest!.onCellContextMenu?.([col, row], { preventDefault() {}, localEventX: 4, localEventY: 4, bounds: { x: 20, y: 20 } });
  });
  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) => b.querySelector(".flex-1")?.textContent === label);
  const choose = async (label: string) => {
    const it = item(label);
    if (!it) throw new Error(`no menu item ${label}`);
    await act(async () => { it.click(); });
    await settle();
  };
  const closeMenu = () => act(async () => {
    document.querySelector("[data-cell-menu]")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const box = () => dialog()!.querySelector("textarea")!;
  const said = () => dialog()?.querySelector('[role="alert"]')?.textContent ?? null;
  const typeInto = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box(), text);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const press = async (label: string) => {
    const button = [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === label);
    if (!button) throw new Error(`no button ${label}`);
    await click(button);
    await settle();
  };
  const cellView = () => document.body.querySelector<HTMLElement>("[data-cell-data-view]");
  const saved = async () => {
    let sent: unknown = null;
    save = async (changes) => { sent = changes; };
    await act(async () => { handle.current!.save(); });
    await settle();
    return sent;
  };

  const NAMED = [
    { name: "id", type: "integer", nullable: false, pk: true, defaultValue: null, autoIncrement: true, fk: null },
    { name: "name", type: "text", nullable: true, pk: false, defaultValue: null, fk: null },
    { name: "qty", type: "integer", nullable: true, pk: false, defaultValue: null, fk: null },
  ];
  const NAMED_ROWS = [{ id: 1, name: "a", qty: 1 }, { id: 2, name: "b", qty: 1 }, { id: 3, name: "a", qty: 2 }];
  const openNamed = async () => {
    schema = NAMED;
    await open(NAMED_ROWS, false, ["id", "name", "qty"]);
  };
  const editName = (row: number, text: string) => act(async () => {
    latest!.onCellsEdited?.([{ location: [1, row], value: { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: true } }]);
  });

  it("filters each column selected to the values selected in it, as they read now, and keeps the other filters", async () => {
    filterColumns = [{ name: "id", kind: "number" }, { name: "name", kind: "text" }, { name: "qty", kind: "number" }];
    await openNamed();
    await selectCells(0, 0, 1, 1);
    await rightClick(0, 0);
    await choose("Filter selected value");
    expect(filtersNow.columns).toEqual({ id: { text: '="1"' } });
    await editName(1, "z");
    await selectCells(1, 0, 2, 3);
    await rightClick(1, 1);
    await choose("Filter selected value");
    expect(filtersNow.columns).toEqual({ id: { text: '="1"' }, name: { text: '="a",="z"' }, qty: { text: '="1",="2"' } });
  });

  it("clears every filter, and is greyed while there is none", async () => {
    filterColumns = [{ name: "id", kind: "number" }, { name: "qty", kind: "number" }];
    await open(3, false);
    await rightClick(1, 1);
    expect(item("Clear filter")!.getAttribute("aria-disabled")).toBe("true");
    await choose("Filter selected value");
    expect(filtersNow.columns).toEqual({ qty: { text: '="7"' } });
    await rightClick(1, 1);
    expect(item("Clear filter")!.getAttribute("aria-disabled")).toBeNull();
    await choose("Clear filter");
    expect(filtersNow).toBe(NO_FILTERS);
  });

  it("hides the columns the selection lies in, the cursor left on the column moving into their place", async () => {
    const hidden: string[][] = [];
    onHideColumns = (columns) => hidden.push(columns);
    await openNamed();
    await selectCells(1, 2, 1, 1);
    await rightClick(1, 2);
    await choose("Hide column");
    expect(hidden).toEqual([["name"]]);
    expect(selection().current?.cell).toEqual([1, 2]);
    // The last columns: the one before them takes the cursor.
    await selectCells(1, 0, 2, 1);
    await rightClick(2, 0);
    await choose("Hide column");
    expect(hidden.at(-1)).toEqual(["name", "qty"]);
    expect(selection().current?.cell).toEqual([0, 0]);
    // Every column: nothing is left to put the cursor in.
    await selectCells(0, 1, 3, 1);
    await rightClick(0, 1);
    await choose("Hide column");
    expect(hidden.at(-1)).toEqual(["id", "name", "qty"]);
    expect(selection().current).toBeUndefined();
    // Rows selected whole lie in every column: Hide column is not offered for them.
    await selectRows(1);
    await rightClick(1, 1);
    expect(item("Hide column")).toBeUndefined();
  });

  it("hands Find column and Open query to the tab", async () => {
    let found = 0;
    let queried = 0;
    onFindColumn = () => { found += 1; };
    onOpenQuery = () => { queried += 1; };
    await open(3, false);
    await rightClick(1, 1);
    await choose("Find column");
    await rightClick(1, 1);
    await choose("Open query");
    expect([found, queried]).toEqual([1, 1]);
  });

  describe("Generate SQL", () => {
    const opened: string[] = [];
    const preview = () => dialog()!.querySelector('[aria-label="SQL preview"]')!.textContent;
    const radio = (type: string) => [...dialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.value === type)!;
    const checkedType = () => [...dialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.checked)?.value;
    const pickType = async (type: string) => { await click(radio(type)); await settle(); };
    const fieldset = (legend: string) => [...dialog()!.querySelectorAll("fieldset")].find((f) => f.querySelector("legend")?.textContent === legend)!;
    const list = (legend: string) => {
      const boxes = [...fieldset(legend).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      const names = (of: HTMLInputElement[]) => of.map((b) => b.closest("label")!.textContent);
      return { disabled: fieldset(legend).hasAttribute("disabled"), columns: names(boxes), ticked: names(boxes.filter((b) => b.checked)) };
    };
    const pressIn = async (legend: string, label: string) => {
      await click([...fieldset(legend).querySelectorAll("button")].find((b) => b.textContent === label)!);
      await settle();
    };
    const okButton = () => [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === "OK")!;
    const enter = async () => {
      await act(async () => { radio(checkedType()!).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      await settle();
    };
    const selectColumn = (col: number) => act(async () => {
      latest!.onGridSelectionChange?.({ columns: CompactSelection.fromSingleSelection(col), rows: CompactSelection.empty() });
    });
    const generate = async (col: number, row: number) => {
      await rightClick(col, row);
      await choose("Generate SQL");
    };
    beforeEach(() => {
      opened.length = 0;
      selectedTable = "items";
      onOpenGeneratedSql = (sql) => { opened.push(sql); };
    });

    it("writes an UPDATE for the rows selected, found by the primary key, and OK opens it in a Query tab", async () => {
      await openNamed();
      await editName(1, "z");
      await selectCells(1, 0, 1, 2);
      await generate(1, 0);
      expect(dialog()!.textContent).toContain("Generate SQL from data");
      // DBGate's start: INSERT, the columns selected as the values, the primary key as the WHERE.
      expect(checkedType()).toBe("INSERT");
      expect(list("Value columns")).toEqual({ disabled: false, columns: ["id", "name", "qty"], ticked: ["name"] });
      expect(list("WHERE columns")).toEqual({ disabled: true, columns: ["id", "name", "qty"], ticked: ["id"] });
      expect(preview()).toBe(`INSERT INTO "items" ("name") VALUES ('a');\nINSERT INTO "items" ("name") VALUES ('z');`);
      await pickType("UPDATE");
      expect(list("WHERE columns").disabled).toBe(false);
      const update = `UPDATE "items" SET "name"='a' WHERE "id"=1;\nUPDATE "items" SET "name"='z' WHERE "id"=2;`;
      expect(preview()).toBe(update);
      await press("OK");
      expect(opened).toEqual([update]);
      expect(dialog()).toBeNull();
    });

    it("greys the list a query type does not use, and OK while nothing can be written", async () => {
      await openNamed();
      await editName(1, "z");
      await selectRows(1);
      await generate(1, 1);
      await pickType("DELETE");
      expect(list("Value columns").disabled).toBe(true);
      await pressIn("WHERE columns", "None");
      expect(preview()).toBe("Tick a WHERE column: without one, the statement would reach every row of the table");
      expect(okButton().disabled).toBe(true);
      // Enter is OK, which has nothing to open yet.
      await enter();
      expect(opened).toEqual([]);
      expect(dialog()).not.toBeNull();
      await pressIn("WHERE columns", "All");
      // Found by what the database holds: the name typed is not saved yet.
      const sql = `DELETE FROM "items" WHERE "id"=2 AND "name"='b' AND "qty"=1;`;
      expect(preview()).toBe(sql);
      await enter();
      expect(opened).toEqual([sql]);
    });

    it("lists every column of the table, hidden ones too, and ticks those the selection lies in", async () => {
      hiddenColumns = new Set(["qty"]);
      await openNamed();
      await selectRows(0);
      await generate(0, 0);
      expect(list("Value columns")).toEqual({ disabled: false, columns: ["id", "name", "qty"], ticked: ["id", "name"] });
      expect(preview()).toBe(`INSERT INTO "items" ("id", "name") VALUES (1, 'a');`);
    });

    it("previews the first 200 statements and opens them all", async () => {
      await open(250, false);
      await selectColumn(1);
      await generate(1, 0);
      expect(preview().split("\n")).toHaveLength(200);
      expect(dialog()!.textContent).toContain("Showing the first 200 of 250 statements. OK opens them all.");
      await press("OK");
      expect(opened[0]!.split("\n")).toHaveLength(250);
      expect(opened[0]!.split("\n")[249]).toBe(`INSERT INTO "items" ("qty") VALUES (3);`);
    });

    it("will not open more SQL than a Query tab can keep", async () => {
      await open(8000, false);
      await selectColumn(1);
      await generate(1, 0);
      expect(said()).toBe("The SQL would be over 250,000 characters, more than a Query tab can keep. Select fewer rows.");
      expect(okButton().disabled).toBe(true);
      await enter();
      expect(opened).toEqual([]);
    });

    it("puts focus back in the grid on Close, and leaves it to the Query tab after OK", async () => {
      await open(3, false);
      await selectCells(1, 1, 1, 1);
      await generate(1, 1);
      await press("Close");
      expect(dialog()).toBeNull();
      expect(document.activeElement?.hasAttribute("data-stub-editor")).toBe(true);
      await generate(1, 1);
      await press("OK");
      expect(opened).toHaveLength(1);
      expect(document.activeElement?.hasAttribute("data-stub-editor")).toBe(false);
    });

    it("is a table's alone", async () => {
      // Rows that name no table.
      selectedTable = undefined;
      await open(3, false);
      await rightClick(1, 1);
      expect(item("Generate SQL")).toBeUndefined();
      await closeMenu();
      await view!.unmount();
      // A tab that opens no Query tab for it: a view's.
      selectedTable = "items";
      onOpenGeneratedSql = undefined;
      await open(3, false);
      await rightClick(1, 1);
      expect(item("Generate SQL")).toBeUndefined();
    });
  });

  it("edits a cell in a dialog, whose OK and Ctrl+Enter put the value in the change set and save nothing", async () => {
    let saves = 0;
    save = async () => { saves += 1; };
    await open(3, false);
    await rightClick(1, 1);
    await choose("Edit cell value");
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Edit cell value");
    expect(box().value).toBe("7");
    await typeInto("many");
    await press("OK");
    expect(said()).toBe("qty: Not a number");
    await typeInto("12");
    expect(said()).toBeNull();
    await press("OK");
    expect(dialog()).toBeNull();
    expect(pending).toBe(1);
    // The grid has its keys back.
    expect(document.activeElement?.hasAttribute("data-stub-editor")).toBe(true);
    await rightClick(1, 0);
    await choose("Edit cell value");
    await typeInto("5");
    await act(async () => {
      box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await settle();
    expect([dialog(), saves, pending]).toEqual([null, 0, 2]);
    expect(await saved()).toEqual({
      inserts: [], deletes: [],
      updates: [{ key: { id: 2 }, set: { qty: 12 }, original: { qty: 7 } }, { key: { id: 1 }, set: { qty: 5 }, original: { qty: 0 } }],
    });
  });

  it("formats and minifies JSON in the cell's dialog, and says when the text is not JSON", async () => {
    await openNamed();
    await rightClick(1, 0);
    await choose("Edit cell value");
    await typeInto('{"a":[1,2]}');
    await press("Format JSON");
    expect(box().value).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    await press("Minify JSON");
    expect(box().value).toBe('{"a":[1,2]}');
    await typeInto("{a");
    await press("Format JSON");
    expect([said(), box().value]).toEqual(["Not valid JSON", "{a"]);
    await press("Close");
    expect([dialog(), pending]).toEqual([null, 0]);
  });

  it("opens a row as a JSON document as it reads now, and puts what changed back in the change set", async () => {
    await open(3, false);
    await act(async () => {
      latest!.onCellsEdited?.([{ location: [1, 1], value: { kind: GridCellKind.Number, data: 9, displayData: "9", allowOverlay: true } }]);
    });
    await selectRows(1);
    await rightClick(1, 1);
    await choose("Edit row as JSON document");
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Edit JSON value");
    expect(box().value).toBe('{\n  "id": 2,\n  "qty": 9\n}');
    await typeInto('{"id": 5, "qty": 8}');
    await press("OK");
    expect(said()).toBe("id cannot be changed here");
    await typeInto('{"id": 2, "qty": 8}');
    await press("OK");
    expect(dialog()).toBeNull();
    expect(await saved()).toEqual({ inserts: [], deletes: [], updates: [{ key: { id: 2 }, set: { qty: 8 }, original: { qty: 7 } }] });
  });

  it("adds a row of each JSON document under the rows loaded, leaving the key the database numbers to it", async () => {
    await open(3, false);
    await rightClick(1, 1);
    await choose("Add JSON document");
    expect(box().value).toBe("");
    await typeInto('[{"id": 9, "qty": 3}]');
    await press("OK");
    expect(said()).toBe("id is filled in by the database: leave it out");
    await typeInto('[{"qty": 3}, {"qty": "4"}]');
    await press("OK");
    expect(dialog()).toBeNull();
    expect(latest!.rows).toBe(5);
    expect(await saved()).toEqual({ inserts: [{ qty: 3 }, { qty: 4 }], updates: [], deletes: [] });
  });

  it("shows a JSON cell expanded in the Cell data view, each time it is asked", async () => {
    schema = [...SCHEMA, { name: "doc", type: "jsonb", nullable: true, pk: false, defaultValue: null, fk: null }];
    await open([{ id: 1, qty: 1, doc: { a: [1, 2] } }], false, ["id", "qty", "doc"]);
    await rightClick(1, 0);
    expect(item("View cell as JSON document")).toBeUndefined();
    await closeMenu();
    await rightClick(2, 0);
    await choose("View cell as JSON document");
    const format = () => cellView()!.querySelector("select")!;
    expect(format().value).toBe("jsonExpanded");
    await act(async () => {
      format().value = "text";
      format().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(format().value).toBe("text");
    await rightClick(2, 0);
    await choose("View cell as JSON document");
    expect(format().value).toBe("jsonExpanded");
  });

  it("saves a cell's text to a file named for its column, and refuses bytes only partly read", async () => {
    const { toast } = await import("sonner");
    const refused = spyOn(toast, "error").mockImplementation(() => "");
    const made: Blob[] = [];
    const objectUrl = spyOn(URL, "createObjectURL").mockImplementation((blob) => { made.push(blob as Blob); return "blob:cell"; });
    const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const names: string[] = [];
    const takeDownload = (e: Event) => {
      const a = e.target as HTMLAnchorElement;
      if (a.tagName === "A") { names.push(a.download); e.preventDefault(); }
    };
    document.addEventListener("click", takeDownload, true);
    try {
      schema = [...NAMED, { name: "photo", type: "bytea", nullable: true, pk: false, defaultValue: null, fk: null }];
      await open([{ id: 1, name: "é!", qty: 1, photo: { $binary: "AAEC", size: 70_000, truncated: true } }], false, ["id", "name", "qty", "photo"]);
      await rightClick(1, 0);
      await choose("Save cell to file");
      expect(names).toEqual(["name.txt"]);
      expect(made.map((b) => b.type)).toEqual(["application/octet-stream"]);
      expect([...new Uint8Array(await made[0]!.arrayBuffer())]).toEqual([0xc3, 0xa9, 0x21]);
      await act(async () => { await Bun.sleep(5); });
      expect(revoke).toHaveBeenCalledWith("blob:cell");
      await rightClick(3, 0);
      await choose("Save cell to file");
      expect(names).toHaveLength(1);
      expect(refused).toHaveBeenCalledWith("Could not save the cell to a file", {
        description: "Only the first 3 bytes of its 68.4 KB came with the row",
      });
      // A number is neither text nor bytes.
      await rightClick(2, 0);
      expect(item("Save cell to file")).toBeUndefined();
    } finally {
      document.removeEventListener("click", takeDownload, true);
      refused.mockRestore();
      objectUrl.mockRestore();
      revoke.mockRestore();
    }
  });

  it("has a table's server read bytes past the row's preview whole, found again by the row's key", async () => {
    const { toast } = await import("sonner");
    const said: string[] = [];
    const spies = [
      spyOn(toast, "loading").mockImplementation(((m: string) => { said.push(`loading: ${m}`); return "t"; }) as never),
      spyOn(toast, "success").mockImplementation(((m: string, o?: { id?: unknown }) => { said.push(`success: ${m} (${String(o?.id)})`); return "t"; }) as never),
      spyOn(toast, "error").mockImplementation(((m: string, o?: { id?: unknown; description?: unknown }) => {
        said.push(`error: ${m}: ${String(o?.description)} (${String(o?.id)})`);
        return "t";
      }) as never),
      spyOn(toast, "dismiss").mockImplementation(((id?: unknown) => { said.push(`dismiss (${String(id)})`); return "t"; }) as never),
    ];
    const blobs = spyOn(URL, "createObjectURL").mockImplementation(() => "blob:cell");
    const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const downloads: { href: string | null; name: string }[] = [];
    const takeDownload = (e: Event) => {
      const a = e.target as HTMLAnchorElement;
      if (a.tagName === "A") { downloads.push({ href: a.getAttribute("href"), name: a.download }); e.preventDefault(); }
    };
    document.addEventListener("click", takeDownload, true);
    const asked: unknown[][] = [];
    let answer: () => Promise<{ ticket: string; fileName: string } | null> = async () => ({ ticket: "c-1", fileName: "users-photo.png" });
    startCellDownload = (column, key, fileName) => {
      asked.push([column, key, fileName]);
      return answer();
    };
    try {
      selectedTable = "users";
      schema = [...NAMED, { name: "photo", type: "bytea", nullable: true, pk: false, defaultValue: null, fk: null }];
      // A PNG's first 16 bytes of its 68.4 KB.
      const photo = { $binary: "iVBORw0KGgoAAAANSUhEUg==", size: 70_000, truncated: true };
      await open([
        { id: 7, name: "a", qty: 1, photo }, { id: 8, name: "b", qty: 2, photo: { ...photo, $binary: "AAEC" } },
        { id: 9, name: "c", qty: 3, photo: { $binary: "AAEC", size: 3 } },
      ], false, ["id", "name", "qty", "photo"]);
      await rightClick(3, 0);
      await choose("Save cell to file");
      expect(asked).toEqual([["photo", { id: 7 }, "users-photo.png"]]);
      expect(downloads).toEqual([{ href: "/api/db/grid-export/c-1", name: "users-photo.png" }]);
      expect(said).toEqual(["loading: Reading users-photo.png…", "success: Downloading users-photo.png (t)"]);
      expect(blobs).not.toHaveBeenCalled();

      // Bytes that begin as no picture are a .bin; why the server would not read them is said.
      said.length = 0;
      answer = async () => { throw new Error("The row is no longer there: refresh the table to see it"); };
      await rightClick(3, 1);
      await choose("Save cell to file");
      expect(asked.at(-1)).toEqual(["photo", { id: 8 }, "users-photo.bin"]);
      expect(said).toEqual([
        "loading: Reading users-photo.bin…",
        "error: Could not save the cell to a file: The row is no longer there: refresh the table to see it (t)",
      ]);

      // No table shown any more: nothing to download, and nothing left saying it is being read.
      said.length = 0;
      answer = async () => null;
      await rightClick(3, 1);
      await choose("Save cell to file");
      expect(said).toEqual(["loading: Reading users-photo.bin…", "dismiss (t)"]);
      expect(downloads).toHaveLength(1);

      // Bytes that came whole are saved from what the grid has, and the server is not asked.
      said.length = 0;
      await rightClick(3, 2);
      await choose("Save cell to file");
      expect(asked).toHaveLength(3);
      expect(downloads.at(-1)).toEqual({ href: "blob:cell", name: "users-photo.bin" });
      expect(said).toEqual([]);
    } finally {
      document.removeEventListener("click", takeDownload, true);
      for (const spy of spies) spy.mockRestore();
      blobs.mockRestore();
      revoke.mockRestore();
    }
  });

  describe("their keys, pressed in the grid", () => {
    // PPM's own keys listen on the window — Ctrl+Shift+F opens Search Files: a key the grid runs must not reach it.
    let reached: string[] = [];
    const listen = (e: KeyboardEvent) => { reached.push(e.key); };
    beforeEach(() => {
      reached = [];
      window.addEventListener("keydown", listen);
    });
    afterEach(() => { window.removeEventListener("keydown", listen); });
    /**
     * The key as the browser sends it, to the grid's canvas unless told where: whether the grid kept it
     * from the browser — and from PPM's own keys, which it then never reaches.
     */
    const key = async (combo: string, init: KeyboardEventInit = {}, target = document.querySelector("[data-stub-editor]")) => {
      const c = parseCombo(combo);
      const name = combo.split("+").at(-1)!;
      const e = new KeyboardEvent("keydown", {
        key: name.length === 1 ? (c.shift ? name.toUpperCase() : name.toLowerCase()) : name,
        ctrlKey: c.ctrl, metaKey: c.meta, altKey: c.alt, shiftKey: c.shift, bubbles: true, cancelable: true, ...init,
      });
      const before = reached.length;
      await act(async () => { target!.dispatchEvent(e); });
      await settle();
      const passedOn = reached.length > before;
      if (e.defaultPrevented === passedOn) throw new Error(`${combo} was ${e.defaultPrevented ? "both run and passed on" : "neither run nor passed on"}`);
      return e.defaultPrevented;
    };

    it("clones the rows selected with Ctrl+Shift+C and sets the cells selected to NULL with Ctrl+0", async () => {
      await open(3, false);
      await selectRows(0);
      expect(await key("Mod+Shift+C")).toBe(true);
      expect(latest!.rows).toBe(4);
      // Held down, it clones once.
      await key("Mod+Shift+C", { repeat: true });
      expect(latest!.rows).toBe(4);
      await selectCells(1, 1, 1, 2);
      expect(await key("Mod+0")).toBe(true);
      expect(await saved()).toEqual({
        inserts: [{ qty: 0 }], deletes: [],
        updates: [{ key: { id: 2 }, set: { qty: null }, original: { qty: 7 } }, { key: { id: 3 }, set: { qty: null }, original: { qty: 4 } }],
      });
    });

    it("finds a column with Ctrl+F, filters on the value selected with Ctrl+Shift+F and hides its column with Ctrl+H", async () => {
      let found = 0;
      const hidden: string[][] = [];
      onFindColumn = () => { found += 1; };
      onHideColumns = (columns) => hidden.push(columns);
      filterColumns = [{ name: "id", kind: "number" }, { name: "qty", kind: "number" }];
      await open(3, false);
      await selectCells(1, 1, 1, 1);
      expect(await key("Mod+F")).toBe(true);
      expect(found).toBe(1);
      expect(await key("Mod+Shift+F")).toBe(true);
      expect(filtersNow.columns).toEqual({ qty: { text: '="7"' } });
      expect(await key("Mod+H")).toBe(true);
      expect(hidden).toEqual([["qty"]]);
    });

    it("edits the one row selected as JSON with Ctrl+J, and opens Generate SQL on the selection with Ctrl+G", async () => {
      selectedTable = "items";
      onOpenGeneratedSql = () => {};
      await open(3, false);
      await selectRows(1);
      expect(await key("Mod+J")).toBe(true);
      expect(dialog()!.querySelector("h2")!.textContent).toBe("Edit JSON value");
      expect(box().value).toBe('{\n  "id": 2,\n  "qty": 7\n}');
      await press("Close");
      expect(await key("Mod+G")).toBe(true);
      expect(dialog()!.textContent).toContain("Generate SQL from data");
    });

    it("leaves a key to the browser where the cell menu would not offer its command", async () => {
      selectedTable = "items";
      onOpenGeneratedSql = () => {};
      onHideColumns = () => {};
      filterColumns = [{ name: "id", kind: "number" }, { name: "qty", kind: "number" }];
      await open(3, false);
      // Nothing selected: nothing to clone, set, hide, filter on, edit or generate from.
      for (const combo of ["Mod+Shift+C", "Mod+0", "Mod+H", "Mod+Shift+F", "Mod+J", "Mod+G"]) {
        expect([combo, await key(combo)]).toEqual([combo, false]);
      }
      // No tab to find a column in.
      expect(await key("Mod+F")).toBe(false);
      // A saved row's key cannot change: Set NULL is not offered for it.
      await selectCells(0, 0, 1, 1);
      expect(await key("Mod+0")).toBe(false);
      // Rows selected whole lie in every column, which Hide column does not offer; Edit row as JSON is one row's.
      await selectRows(0, 1);
      expect(await key("Mod+H")).toBe(false);
      expect(await key("Mod+J")).toBe(false);
      expect([dialog(), latest!.rows, pending]).toEqual([null, 3, 0]);
    });

    it("leaves Ctrl+G to the browser on rows that name no table, as the menu leaves Generate SQL out", async () => {
      onOpenGeneratedSql = () => {};
      await open(3, false);
      await selectRows(1);
      expect(await key("Mod+G")).toBe(false);
      expect(dialog()).toBeNull();
    });

    it("on a read-only grid, takes only the keys that change nothing", async () => {
      readOnly = true;
      let found = 0;
      onFindColumn = () => { found += 1; };
      filterColumns = [{ name: "id", kind: "number" }, { name: "qty", kind: "number" }];
      await open(3, false);
      await selectRows(1);
      for (const combo of ["Mod+Shift+C", "Mod+0", "Mod+J"]) expect([combo, await key(combo)]).toEqual([combo, false]);
      expect([dialog(), latest!.rows]).toEqual([null, 3]);
      expect(await key("Mod+F")).toBe(true);
      expect(await key("Mod+Shift+F")).toBe(true);
      expect([found, filtersNow.columns]).toEqual([1, { id: { text: '="2"' }, qty: { text: '="7"' } }]);
    });

    it("saves a Query result's edited rows with Ctrl+S, and leaves the key to the tab when there are none", async () => {
      let sent: unknown = null;
      save = async (changes) => { sent = changes; };
      const editFirstQty = () => act(async () => {
        latest!.onCellsEdited?.([{ location: [1, 0], value: { kind: GridCellKind.Number, data: 42, displayData: "42", allowOverlay: true } }]);
      });
      editOnly = true;
      await open(3, false);
      // Nothing edited: the Query tab around the grid saves its SQL instead.
      expect(await key("Mod+S")).toBe(false);
      await editFirstQty();
      expect(await key("Mod+S")).toBe(true);
      expect(sent).toEqual({ inserts: [], deletes: [], updates: [{ key: { id: 1 }, set: { qty: 42 }, original: { qty: 0 } }] });
      await view!.unmount();

      // A table's grid leaves it to the table view around it, which has a Save of its own.
      sent = null;
      editOnly = false;
      await open(3, false);
      await editFirstQty();
      expect(await key("Mod+S")).toBe(false);
      expect(sent).toBeNull();
    });

    it("leaves a filter box the browser's keys, and the form view its own", async () => {
      let found = 0;
      onFindColumn = () => { found += 1; };
      filterColumns = [{ name: "id", kind: "number" }, { name: "qty", kind: "number" }];
      await open(3, false);
      await selectRows(0);
      const filterBox = document.querySelector('input[placeholder="Filter"]');
      expect(filterBox).not.toBeNull();
      for (const combo of ["Mod+F", "Mod+Shift+C", "Mod+0"]) expect([combo, await key(combo, {}, filterBox)]).toEqual([combo, false]);
      expect([found, latest!.rows, pending]).toEqual([0, 3, 0]);
      await view!.unmount();

      gridView = "form";
      await open(3, false);
      const form = document.querySelector<HTMLElement>("[data-form-view]")!;
      // The grid's commands are not the form's: Find column and Clone rows go to the browser there.
      expect(await key("Mod+F", {}, form)).toBe(false);
      expect(await key("Mod+Shift+C", {}, form)).toBe(false);
      expect([found, pending]).toEqual([0, 0]);
    });
  });
});

describe("the keys when the tab comes to the front, as DBGate's focusOnVisible", () => {
  const canvas = () => document.querySelector<HTMLElement>("[data-stub-editor]");
  const keysInGrid = () => !!document.activeElement && document.activeElement === canvas();
  /** The grid in its tab, beside the tab's toolbar; `focusOnVisible` as it is when it mounts. */
  async function openTab(front: boolean) {
    focusOnVisible = front;
    const initial = { columns: ["id", "qty"], rows: rowsOf(3), viewKey: 1, hasMore: false, loading: false, sort: [] };
    view = await mount(<div data-tab-pool-id="orders"><button type="button" data-toolbar="">Refresh</button><Harness initial={initial} /></div>);
  }
  const toFront = async (front: boolean) => {
    focusOnVisible = front;
    await act(async () => { setView({}); });
    await settle();
  };
  /** Somewhere outside the tab to put the keys: `role` makes it part of a dialog. */
  const outside = (tag: "input" | "button", role?: string) => {
    const box = document.createElement("div");
    if (role) box.setAttribute("role", role);
    const el = document.createElement(tag);
    box.append(el);
    document.body.append(box);
    return el;
  };
  afterEach(() => { for (const el of [...document.body.children]) if (!el.querySelector("[data-tab-pool-id]")) el.remove(); });

  /** Glide's scroller measured at last: its canvas goes in. */
  const measured = async () => {
    await act(async () => { for (const put of measureLater!.splice(0)) put(); });
    await settle();
  };

  it("puts the keys in the grid once Glide has put its canvas in", async () => {
    measureLater = [];
    await openTab(true);
    await settle();
    expect([canvas(), document.activeElement]).toEqual([null, document.body]);
    await measured();
    expect(keysInGrid()).toBe(true);
  });

  it("puts them in the form when the tab opens on it", async () => {
    gridView = "form";
    await openTab(true);
    await settle();
    expect(document.activeElement?.hasAttribute("data-form-view")).toBe(true);
  });

  it("leaves the keys alone while another tab is in front, and takes them when this one comes to the front", async () => {
    await openTab(false);
    await settle();
    expect(document.activeElement).toBe(document.body);
    await toFront(true);
    expect(keysInGrid()).toBe(true);
  });

  it("stops waiting for the grid once the tab is no longer in front", async () => {
    measureLater = [];
    await openTab(true);
    await toFront(false);
    await measured();
    expect(canvas()).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("never takes them from a field being typed in, a dialog, or anywhere in its own tab", async () => {
    await openTab(false);
    await settle();
    const field = outside("input");
    const ok = outside("button", "dialog");
    const toolbar = document.querySelector<HTMLElement>("[data-toolbar]")!;
    for (const [name, el] of [["field", field], ["dialog", ok], ["toolbar", toolbar]] as const) {
      el.focus();
      await toFront(true);
      expect([name, document.activeElement === el]).toEqual([name, true]);
      await toFront(false);
    }
  });

  it("takes them still when what the table was opened from goes away meanwhile, leaving them nowhere", async () => {
    const opener = outside("button");
    opener.focus();
    measureLater = [];
    await openTab(true);
    opener.parentElement!.remove();
    expect(document.activeElement).toBe(document.body);
    await measured();
    expect(keysInGrid()).toBe(true);
  });

  it("takes them from what the table was opened from, but not once the user has put them anywhere else", async () => {
    const opener = outside("button");
    opener.focus();
    measureLater = [];
    await openTab(true);
    await measured();
    expect(keysInGrid()).toBe(true);
    await view!.unmount();
    view = null;

    // The rows take a while, and the user goes on in the meantime.
    opener.focus();
    await openTab(true);
    const next = outside("button");
    next.focus();
    await measured();
    expect(canvas()).not.toBeNull();
    expect(document.activeElement).toBe(next);
  });
});

describe("the keys when the cell holding them leaves the page", () => {
  const canvas = () => document.querySelector<HTMLElement>("[data-stub-editor]")!;
  /** Glide's cell for a screen reader, which it focuses when the cursor is on it: in the canvas, gone with its row. */
  const focusedCell = (inside: Element = canvas()) => {
    const cell = document.createElement("div");
    cell.tabIndex = 0;
    inside.append(cell);
    cell.focus();
    return cell;
  };
  afterEach(() => { for (const el of [...document.body.children]) if (el.tagName === "BUTTON") el.remove(); });

  it("puts them back in the grid: a new row undone takes the cell, and the keys land on the page", async () => {
    await open(3, false);
    const cell = focusedCell();
    // Firefox says nothing as the cell goes; happy-dom neither.
    await act(async () => { cell.remove(); });
    await settle();
    expect(document.activeElement).toBe(canvas());
  });

  it("puts them back too where the browser says they left as the cell goes, as Chrome does", async () => {
    await open(3, false);
    const cell = focusedCell();
    await settle();
    // From inside the removal, before the change is reported: the focusout is heard first.
    cell.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    cell.remove();
    await settle();
    expect(document.activeElement).toBe(canvas());
  });

  it("does not take them back later once they went elsewhere as the cell went", async () => {
    await open(3, false);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    const cell = focusedCell();
    await settle();
    // The row goes and, in the one task, a dialog takes the keys.
    cell.remove();
    elsewhere.focus();
    await settle();
    expect(document.activeElement).toBe(elsewhere);
    // The dialog closed beside everything; the grid changes after.
    elsewhere.blur();
    await act(async () => { canvas().append(document.createElement("span")); });
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("puts them back in the form, in the form view", async () => {
    gridView = "form";
    await open(3, false);
    const form = document.querySelector<HTMLElement>("[data-form-view]")!;
    const cell = focusedCell(form);
    await act(async () => { cell.remove(); });
    await settle();
    expect(document.activeElement).toBe(form);
  });

  it("leaves them where the user put them: on something else, or on the page by a click beside everything", async () => {
    await open(3, false);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    const cell = focusedCell();
    elsewhere.focus();
    await act(async () => { cell.remove(); });
    await settle();
    expect(document.activeElement).toBe(elsewhere);

    const next = focusedCell();
    next.blur();
    await settle();
    await act(async () => { next.remove(); });
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("knows a click beside everything from a cell taken away, even when the grid changes as the keys leave", async () => {
    await open(3, false);
    const cell = focusedCell();
    // The page changes the grid and the user's click takes the keys, in the one task: the change is heard first.
    await act(async () => {
      canvas().append(document.createElement("span"));
      cell.blur();
    });
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});
