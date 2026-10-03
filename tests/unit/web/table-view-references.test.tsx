/**
 * DBGate's References in a table tab, against a stub server: the panel beside the grid lists the
 * tables the keys point at and the ones pointing here, and clicking one shows it under the grid —
 * holding only the rows that belong to the rows selected above, and following the selection. Its
 * own filters narrow it further, its keys act on it alone, its unsaved rows hold it in place, and on
 * a phone it opens from the Columns and filters sheet.
 *
 * Glide draws on a canvas and happy-dom lays nothing out, so each grid's editor is a stub that
 * reports the props it was handed: the selection is set the way Glide sets it. Only while this file
 * runs — `mock.module` outlives it, and the other database suites mount the real editor.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every dropdown and dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act, forwardRef, useImperativeHandle } = await import("react");

// A copy: the mock replaces the module's exports in place.
const realGlide = { ...(await import("@glideapps/glide-data-grid")) };
const { CompactSelection, GridCellKind } = realGlide;
let stubbing = true;
afterAll(() => { stubbing = false; });

type Item = readonly [number, number];
type StubProps = {
  columns: readonly { id?: string; title: string }[];
  rows: number;
  getCellContent: (cell: Item) => { data?: unknown; displayData?: string };
  onGridSelectionChange?: (selection: unknown) => void;
  onCellsEdited?: (items: readonly { location: Item; value: unknown }[]) => boolean;
  onCellContextMenu?: (cell: Item, event: { preventDefault(): void; localEventX: number; localEventY: number; bounds: { x: number; y: number } }) => void;
};
/** Each grid's editor as last rendered, by its columns. */
const editors = new Map<string, StubProps>();
const StubEditor = forwardRef<unknown, StubProps>(function StubEditor(props, ref) {
  editors.set(props.columns.map((c) => c.id ?? c.title).join(","), props);
  useImperativeHandle(ref, () => ({ scrollTo() {}, focus() {}, updateCells() {} }), []);
  return <div tabIndex={0} data-stub-editor={props.columns.map((c) => c.id ?? c.title).join(",")} />;
});
const Editor = forwardRef<unknown, StubProps>(function Editor(props, ref) {
  const Real = realGlide.default as never as typeof StubEditor;
  return stubbing ? <StubEditor ref={ref} {...props} /> : <Real ref={ref} {...props} />;
});
mock.module("@glideapps/glide-data-grid", () => ({ ...realGlide, default: Editor, DataEditor: Editor }));

const { toast } = await import("sonner");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useUnsavedGridRows } = await import("../../../src/web/stores/unsaved-grid-rows-store");
const { endGridSave, useGridSave } = await import("../../../src/web/components/database/grid/grid-save-store");
const { TableView } = await import("../../../src/web/components/database/table/table-tab");
type DbTabContext = import("../../../src/web/components/database/use-db-tab").DbTabContext;
type Tab = import("../../../src/web/stores/tab-store").Tab;
type DbForeignKey = import("../../../src/shared/db-structure").DbForeignKey;

const TAB_ID = "database:5::shop:users";
const PLACE = { target: { kind: "connection" as const, connectionId: 5 }, connectionName: "shop", dbType: "postgres" as const };
const CTX: DbTabContext = {
  target: PLACE.target, conn: undefined, dbType: "postgres", dialect: "postgres",
  name: "shop", place: PLACE, readonly: false, missing: false,
};

// ── A stub server: users, and the orders each of them placed ──

const column = (name: string, type: string, over: object = {}) => ({ name, type, nullable: true, pk: false, defaultValue: null, autoIncrement: false, fk: null, ...over });
const TABLES: Record<string, { columns: ReturnType<typeof column>[]; rows: unknown[][] }> = {
  users: {
    columns: [column("id", "integer", { pk: true, nullable: false }), column("name", "text")],
    rows: [[1, "Ann"], [2, "Bo"], [3, "Cy"]],
  },
  orders: {
    columns: [column("id", "integer", { pk: true, nullable: false }), column("user_id", "integer", { fk: { table: "users", column: "id" } }), column("status", "text")],
    rows: [[10, 1, "new"], [11, 1, "paid"], [12, 2, "paid"], [13, null, "new"]],
  },
};
const ORDERS_USER: DbForeignKey = {
  name: "orders_user", schema: "shop", table: "orders", columns: ["user_id"], refSchema: "shop", refTable: "users", refColumns: ["id"],
  onDelete: "NO ACTION", onUpdate: "NO ACTION",
};
const structureOf = (name: string, foreignKeys: DbForeignKey[], references: DbForeignKey[]) => ({
  schema: "shop", name, kind: "table", columns: [], primaryKey: null, foreignKeys, references, indexes: [], uniques: [], checks: [], comment: null,
});
let STRUCTURES: Record<string, ReturnType<typeof structureOf>> = {};

type Term = { op: string; value?: unknown; values?: unknown[] };
type Group = { column: string; anyOf: Term[][] };
const holds = (value: unknown, t: Term) => {
  if (t.op === "eq") return value === t.value;
  if (t.op === "in") return t.values!.includes(value);
  if (t.op === "contains") return String(value ?? "").toLowerCase().includes(String(t.value).toLowerCase());
  throw new Error(`the stub server has no ${t.op}`);
};
function rowsOf(table: string, filters: Group[]) {
  const t = TABLES[table]!;
  const at = (name: string) => t.columns.findIndex((c) => c.name === name);
  return t.rows.filter((row) => filters.every((g) => g.anyOf.some((and) => and.every((term) => holds(row[at(g.column)], term)))));
}

type Req = { method: string; url: string; body: { table?: string; filters?: Group[]; anyColumn?: unknown[]; sort?: unknown[] } | undefined };
const realFetch = globalThis.fetch;
let requests: Req[] = [];
/** While set, a read of orders' rows answers with it instead. */
let ordersRefusal: string | null = null;

beforeEach(() => {
  requests = [];
  ordersRefusal = null;
  editors.clear();
  STRUCTURES = { users: structureOf("users", [], [ORDERS_USER]), orders: structureOf("orders", [ORDERS_USER], []) };
  useUnsavedGridRows.setState({}, true);
  // A table's plain first page is cached per browser tab.
  sessionStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(req);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace("/api/db/connections/5", "");
    const table = url.searchParams.get("table") ?? req.body?.table ?? "";
    if (path === "/structure") return json(200, { ok: true, data: STRUCTURES[table] });
    if (path === "/schema") return json(200, { ok: true, data: TABLES[table]!.columns });
    if (path === "/grid/values") {
      const t = TABLES[table]!;
      const at = t.columns.findIndex((c) => c.name === (req.body as { column: string }).column);
      const values = [...new Set(rowsOf(table, req.body!.filters ?? []).map((row) => row[at]))].sort();
      return json(200, { ok: true, data: { values, hasMore: false, sql: "SELECT DISTINCT" } });
    }
    if (path === "/grid/count") return json(200, { ok: true, data: { count: rowsOf(table, req.body!.filters ?? []).length, estimate: null } });
    if (path === "/grid/cell") return json(200, { ok: true, data: { ticket: `cell-${requests.length}`, fileName: (req.body as { fileName: string }).fileName } });
    if (path === "/grid") {
      if (table === "orders" && ordersRefusal) return json(400, { ok: false, error: ordersRefusal });
      const t = TABLES[table]!;
      return json(200, {
        ok: true,
        data: { columns: t.columns.map((c) => ({ name: c.name, type: c.type })), rows: rowsOf(table, req.body!.filters ?? []), hasMore: false, sql: "SELECT", rowKey: ["id"] },
      });
    }
    return json(404, { ok: false, error: `no stub for ${req.method} ${req.url}` });
  }) as typeof fetch;
});

let view: Mounted | null = null;
const realWidth = window.innerWidth;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  const pending = useGridSave.getState().pending;
  if (pending) endGridSave(pending.seq, null);
});

function seedTab() {
  const tab: Tab = { id: TAB_ID, type: "database", title: "users", projectId: null, closable: true, metadata: { connectionId: 5, schemaName: "shop", tableName: "users" } };
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "left", grid: [["left"]], lastFocusedChatProviders: {},
    panels: { left: { id: "left", activeTabId: TAB_ID, tabHistory: [TAB_ID], tabs: [tab] } },
  } as never);
}
/** Until the requests stop: a read can wait on the columns it is written for, read first. */
const settle = async () => {
  let quiet = 0;
  for (let i = 0; i < 100 && quiet < 3; i++) {
    const before = requests.length;
    await act(async () => { await Bun.sleep(10); });
    quiet = requests.length === before ? quiet + 1 : 0;
  }
};
async function open(table = "users") {
  seedTab();
  view = await mount(<TableView tab={CTX} table={table} schemaName="shop" tabId={TAB_ID} />);
  await settle();
}

const byLabel = <T extends Element = HTMLElement>(label: string, root: ParentNode = document) =>
  [...root.querySelectorAll<T>("[aria-label]")].find((e) => e.getAttribute("aria-label") === label) ?? null;
const references = () => byLabel<HTMLElement>("References of users");
const pick = (table: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>('[role="list"][aria-label^="References of"] button')].find((b) => b.textContent?.startsWith(`${table} `)) ?? null;
/** The table shown under the grid: its header, and its grid's editor. */
const detail = () => document.querySelector<HTMLElement>("section[aria-labelledby]");
const header = () => detail()?.querySelector("h3")?.textContent ?? null;
const master = () => editors.get("id,name")!;
const below = () => editors.get("id,user_id,status") ?? null;
/** What the grid under the master shows, row by row. */
const shownBelow = () => {
  const e = below();
  if (!e) return null;
  return Array.from({ length: e.rows }, (_, r) => e.columns.map((_, c) => e.getCellContent([c, r]).displayData ?? String(e.getCellContent([c, r]).data ?? "")));
};
const ordersReads = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/grid") && r.body?.table === "orders").map((r) => r.body!.filters);
const usersReads = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/grid") && r.body?.table === "users").length;
const ordersSorts = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/grid") && r.body?.table === "orders").map((r) => r.body!.sort ?? []);
/** What the empty grid below offers to do. */
const actionsBelow = () => [...(detail()?.querySelectorAll("button") ?? [])].map((b) => b.textContent);

/**
 * Cells selected in the master, as Glide reports a drag down a column. (Each `act` is awaited on
 * its own: its thenable's `then` chains nothing, so `act(...).then(settle)` would leave the settle
 * running beside the next one.)
 */
async function selectUsers(row: number, height = 1, col = 1) {
  await act(async () => {
    master().onGridSelectionChange?.({
      columns: CompactSelection.empty(), rows: CompactSelection.empty(),
      current: { cell: [col, row], range: { x: col, y: row, width: 1, height }, rangeStack: [] },
    });
  });
  await settle();
}
const showOrders = async (root: ParentNode = document) => {
  await click(pick("orders", root));
  await settle();
};
/** A key pressed inside an element, as the browser sends it. */
async function press(target: Element, key: string, mods: { ctrl?: boolean; shift?: boolean } = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, bubbles: true, cancelable: true }));
  });
  await settle();
}
async function typeInto(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await settle();
}

const USER_1 = [{ column: "user_id", anyOf: [[{ op: "eq", value: 1 }]] }];

describe("the References beside a table's grid", () => {
  it("lists the tables pointing at this one, read from its structure", async () => {
    await open();
    expect(requests.some((r) => r.method === "GET" && r.url.includes("/structure?table=users&schema=shop"))).toBe(true);
    expect([...references()!.children].map((e) => e.textContent)).toEqual(["Dependent tables (1)", "orders (user_id)"]);
  });

  it("is not there for a table nothing points at and that points at nothing", async () => {
    STRUCTURES.users = structureOf("users", [], []);
    await open();
    expect(document.querySelector('section[aria-label="References"]')).toBeNull();
    // The Filters panel takes the room it would have had.
    expect(document.querySelector('section[aria-label="Filters"]')?.parentElement?.className).toContain("max-h-[45%]");
  });
});

describe("a reference shown under the grid", () => {
  it("waits for a row to be selected above, reading nothing until then", async () => {
    await open();
    // A lone grid's "Rows: N" is the status bar's, and not in the grid.
    const masterCorner = () => [...document.querySelectorAll('[role="status"]')].filter((e) => !detail()?.contains(e)).map((e) => e.textContent);
    expect(masterCorner()).not.toContain("Rows: 3");
    await showOrders();
    expect(header()).toBe("orders [user_id] = master [id] · select a row in the grid above");
    expect(ordersReads()).toEqual([]);
    expect(shownBelow()).toEqual([]);
    // Each grid's own "Rows: N" in its corner, since the status bar can name only one.
    expect(detail()!.textContent).toContain("Rows: 0");
    expect(masterCorner()).toContain("Rows: 3");
    expect(pick("orders")!.getAttribute("aria-pressed")).toBe("true");
    // A row added now would belong to no row above.
    expect(actionsBelow()).not.toContain("Add row");
    // Cy has placed no order, and one can be added for Cy.
    await selectUsers(2);
    expect(shownBelow()).toEqual([]);
    expect(actionsBelow()).toContain("Add row");
  });

  it("opens on the row already selected above, read once its key's type is known", async () => {
    await open();
    await selectUsers(0);
    await showOrders();
    expect(header()).toBe("orders [user_id] = master [id]");
    // Not first as text, before the columns of orders were read, and then again as a number.
    expect(ordersReads()).toEqual([USER_1]);
    expect(shownBelow()).toEqual([["10", "1", "new"], ["11", "1", "paid"]]);
  });

  it("holds the selected row's orders, and follows the selection as it moves", async () => {
    await open();
    await showOrders();
    await selectUsers(0);
    expect(header()).toBe("orders [user_id] = master [id]");
    expect(ordersReads()).toEqual([USER_1]);
    expect(shownBelow()).toEqual([["10", "1", "new"], ["11", "1", "paid"]]);
    await selectUsers(1);
    expect(ordersReads().at(-1)).toEqual([{ column: "user_id", anyOf: [[{ op: "eq", value: 2 }]] }]);
    expect(shownBelow()).toEqual([["12", "2", "paid"]]);
    // Several rows: the orders of each.
    await selectUsers(0, 3);
    expect(ordersReads().at(-1)).toEqual([{ column: "user_id", anyOf: [[{ op: "in", values: [1, 2, 3] }]] }]);
    expect(shownBelow()).toHaveLength(3);
    // The master is not read again for any of it.
    expect(usersReads()).toBe(1);
  });

  it("keeps its own sort as the selection above moves", async () => {
    await open();
    await showOrders();
    await selectUsers(0);
    await click(byLabel("Column menu: status", detail()!));
    await settle();
    const item = [...document.querySelectorAll('[role="menu"][aria-label="Column menu: status"] [role="menuitem"]')]
      .find((e) => e.textContent === "Sort descending") ?? null;
    await click(item);
    await settle();
    const STATUS_DESC = [{ column: "status", dir: "DESC" }];
    expect(ordersSorts().at(-1)).toEqual(STATUS_DESC);
    await selectUsers(1);
    expect(ordersReads().at(-1)).toEqual([{ column: "user_id", anyOf: [[{ op: "eq", value: 2 }]] }]);
    expect(ordersSorts().at(-1)).toEqual(STATUS_DESC);
  });

  it("reads nothing for the same selection made again, and nothing for a row with no key", async () => {
    await open();
    await showOrders();
    await selectUsers(0);
    // Another cell of the same row.
    await selectUsers(0, 1, 0);
    expect(ordersReads()).toHaveLength(1);
    // A new row has no key yet: no order belongs to it.
    await click(byLabel("New row"));
    await selectUsers(3);
    expect(ordersReads()).toHaveLength(1);
    expect(header()).toBe("orders [user_id] = master [id] · select a row in the grid above");
    // Nor can one be added below it, with the orders read before still on hand.
    expect(shownBelow()).toEqual([]);
    expect(actionsBelow()).not.toContain("Add row");
  });

  it("shows no rows from the selection before when a read fails", async () => {
    await open();
    await showOrders();
    await selectUsers(0);
    expect(shownBelow()).toHaveLength(2);
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      ordersRefusal = "too many values";
      await selectUsers(1);
      expect(shownBelow()).toEqual([]);
      expect(shown.mock.calls.map((c) => c[0])).toEqual(["Could not read orders"]);
      // Nor the count of the rows it no longer shows.
      expect(detail()!.textContent).not.toContain("Rows:");
      ordersRefusal = null;
      await selectUsers(2);
      expect(shownBelow()).toEqual([]);
      await selectUsers(1);
      expect(shownBelow()).toEqual([["12", "2", "paid"]]);
      expect(detail()!.textContent).toContain("Rows: 1");
    } finally {
      shown.mockRestore();
    }
  });

  it("narrows by its own filter row together with the key, and keeps the key out of that row", async () => {
    await open();
    await showOrders();
    await selectUsers(0);
    const box = byLabel<HTMLInputElement>("Filter status", detail()!)!;
    await typeInto(box, "paid");
    expect(ordersReads().at(-1)).toEqual([...USER_1, { column: "status", anyOf: [[{ op: "contains", value: "paid" }]] }]);
    expect(shownBelow()).toEqual([["11", "1", "paid"]]);
    expect(byLabel<HTMLInputElement>("Filter user_id", detail()!)!.value).toBe("");
    // The next selection keeps it.
    await selectUsers(1);
    expect(ordersReads().at(-1)).toEqual([{ column: "user_id", anyOf: [[{ op: "eq", value: 2 }]] }, { column: "status", anyOf: [[{ op: "contains", value: "paid" }]] }]);
    // The master's filters are its own.
    expect(usersReads()).toBe(1);
  });

  it("lists ⋮'s values within the key: the statuses of the selected user's orders alone", async () => {
    await open();
    await showOrders();
    await selectUsers(1);
    await click(byLabel("Choose value from status", detail()!));
    await settle();
    const asked = requests.filter((r) => r.url.endsWith("/grid/values")).map((r) => r.body as { table: string; column: string; filters: unknown });
    expect(asked.map(({ table, column, filters }) => ({ table, column, filters }))).toEqual([
      { table: "orders", column: "status", filters: [{ column: "user_id", anyOf: [[{ op: "eq", value: 2 }]] }] },
    ]);
  });

  it("takes its keys for itself: Clear filter clears its filter alone, and Save saves its rows alone", async () => {
    await open();
    // The master's own filter: users whose name holds an "a".
    const masterName = () => [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Filter name"]')].find((e) => !detail()?.contains(e))!;
    await typeInto(masterName(), "a");
    expect(usersReads()).toBe(2);
    await showOrders();
    await selectUsers(0);
    await typeInto(byLabel<HTMLInputElement>("Filter status", detail()!)!, "paid");
    const grid = detail()!.querySelector("[data-stub-editor]")!;
    await press(grid, "E", { ctrl: true, shift: true });
    expect(ordersReads().at(-1)).toEqual(USER_1);
    expect(byLabel<HTMLInputElement>("Filter status", detail()!)!.value).toBe("");
    expect([usersReads(), masterName().value]).toEqual([2, "a"]);
    await act(async () => {
      below()!.onCellsEdited?.([{ location: [2, 0], value: { kind: GridCellKind.Text, data: "void", displayData: "void", allowOverlay: true } }]);
    });
    await press(grid, "s", { ctrl: true });
    const request = useGridSave.getState().pending?.request;
    expect({ table: request?.table, schema: request?.schema, changes: request?.changes }).toEqual({
      table: "orders", schema: "shop",
      changes: { inserts: [], deletes: [], updates: [{ key: { id: 10 }, set: { status: "void" }, original: { status: "new" } }] },
    });
  });

  it("leaves the selection's keys it has nothing to run for to the browser", async () => {
    await open();
    await showOrders();
    await selectUsers(0);
    const grid = detail()!.querySelector("[data-stub-editor]")!;
    // Nothing selected below to clone, and no column search there: Ctrl+Shift+C and Ctrl+F are the browser's.
    for (const [key, shift] of [["C", true], ["f", false]] as const) {
      const e = new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true });
      await act(async () => { grid.dispatchEvent(e); });
      expect([key, e.defaultPrevented]).toEqual([key, false]);
    }
  });

  it("stays as it is when clicked again, and goes with Close", async () => {
    await open();
    await showOrders();
    await selectUsers(0);
    await showOrders();
    expect(ordersReads()).toHaveLength(1);
    await click(byLabel("Close orders"));
    await settle();
    expect(detail()).toBeNull();
    expect(pick("orders")!.getAttribute("aria-pressed")).toBe("false");
    expect(below()).toBeTruthy();
    editors.clear();
    await showOrders();
    expect(below()).toBeTruthy();
  });

  it("is not closed over rows it has not saved: it says so, and keeps them", async () => {
    const said = spyOn(toast, "info").mockImplementation(() => 0);
    try {
      await open();
      await showOrders();
      await selectUsers(0);
      await act(async () => {
        below()!.onCellsEdited?.([{ location: [2, 1], value: { kind: GridCellKind.Text, data: "void", displayData: "void", allowOverlay: true } }]);
      });
      await settle();
      // Clicked again, the one shown stays as it is, with nothing to ask.
      await showOrders();
      expect(said).not.toHaveBeenCalled();
      await click(byLabel("Close orders"));
      await settle();
      expect(header()).toBe("orders [user_id] = master [id]");
      expect(said.mock.calls).toEqual([["Save or discard the changes in orders first", { description: "1 changed row there would be lost." }]]);
    } finally {
      said.mockRestore();
    }
  });

  it("opens the row a key below refers to as a form, in a new tab filtered to it", async () => {
    await open();
    await showOrders();
    await selectUsers(1);
    const before = usePanelStore.getState().panels.left!.tabs.length;
    const grid = below()!;
    await act(async () => {
      (grid as unknown as { onCellClicked: (cell: Item, e: object) => void }).onCellClicked([1, 0], {
        isTouch: false, preventDefault() {}, localEventX: 100, localEventY: 15, bounds: { x: 0, y: 0, width: 120, height: 34 },
      });
    });
    const tabs = usePanelStore.getState().panels.left!.tabs;
    expect(tabs.length).toBe(before + 1);
    const opened = tabs.at(-1)!.metadata as { tableName: string; schemaName: string; filters: unknown; gridView: { form?: boolean } };
    expect([opened.tableName, opened.schemaName, opened.filters, opened.gridView.form]).toEqual(["users", "shop", { columns: { id: { text: '="2"' } } }, true]);
  });
});

describe("References on a phone", () => {
  it("are in the Columns and filters sheet, which a pick closes to show the table under the grid", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    await open();
    // The thumb bar's Filters button opens Columns and filters.
    const opener = [...document.querySelectorAll("button")].find((b) => b.textContent === "Filters") ?? null;
    await click(opener);
    await settle();
    const sheet = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const row = pick("orders", sheet)!;
    expect(row.className).toContain("h-11");
    await click(row);
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(header()).toBe("orders [user_id] = master [id] · select a row in the grid above");
    // The lower 45% of the screen.
    expect(detail()!.className).toContain("max-md:basis-[45%]");
    expect(byLabel("Close orders")!.className).toContain("max-md:min-w-11");
  });
});

describe("Save cell to file on bytes past the row's preview", () => {
  // A PNG's first 16 bytes of its 68.4 KB, as the grid's read sends it.
  const PREVIEW = { $binary: "iVBORw0KGgoAAAANSUhEUg==", size: 70_000, truncated: true };
  const tables = { ...TABLES };
  let downloads: { href: string | null; name: string }[] = [];
  const takeDownload = (e: Event) => {
    const a = e.target as HTMLAnchorElement;
    if (a.tagName === "A") { downloads.push({ href: a.getAttribute("href"), name: a.download }); e.preventDefault(); }
  };
  beforeEach(() => {
    downloads = [];
    document.addEventListener("click", takeDownload, true);
    TABLES.users = { columns: [...tables.users!.columns, column("photo", "bytea")], rows: tables.users!.rows.map((r, i) => [...r, i === 0 ? PREVIEW : null]) };
    TABLES.orders = { columns: [...tables.orders!.columns, column("receipt", "bytea")], rows: tables.orders!.rows.map((r) => [...r, { ...PREVIEW, $binary: "AAEC" }]) };
  });
  afterEach(() => {
    document.removeEventListener("click", takeDownload, true);
    Object.assign(TABLES, tables);
  });

  const cellReads = () => requests.filter((r) => r.method === "POST" && r.url === "/api/db/connections/5/grid/cell").map((r) => r.body);
  async function saveCell(editor: StubProps, cell: Item) {
    await act(async () => { editor.onCellContextMenu?.(cell, { preventDefault() {}, localEventX: 4, localEventY: 4, bounds: { x: 20, y: 20 } }); });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) => b.querySelector(".flex-1")?.textContent === "Save cell to file");
    if (!item) throw new Error("no Save cell to file");
    await act(async () => { item.click(); });
    await settle();
  }

  it("has the server read the cell whole, in the table's grid and in the one under it", async () => {
    const quiet = spyOn(toast, "success").mockImplementation((() => "t") as never);
    try {
      await open();
      await saveCell(editors.get("id,name,photo")!, [2, 0]);
      expect(cellReads()).toEqual([{ table: "users", schema: "shop", column: "photo", key: { id: 1 }, fileName: "users-photo.png" }]);
      expect(downloads).toEqual([{ href: expect.stringMatching(/^\/api\/db\/grid-export\/cell-\d+$/), name: "users-photo.png" }]);

      await act(async () => {
        editors.get("id,name,photo")!.onGridSelectionChange?.({
          columns: CompactSelection.empty(), rows: CompactSelection.empty(),
          current: { cell: [1, 0], range: { x: 1, y: 0, width: 1, height: 1 }, rangeStack: [] },
        });
      });
      await settle();
      await showOrders();
      await saveCell(editors.get("id,user_id,status,receipt")!, [3, 1]);
      expect(cellReads().at(-1)).toEqual({ table: "orders", schema: "shop", column: "receipt", key: { id: 11 }, fileName: "orders-receipt.bin" });
      expect(downloads.map((d) => d.name)).toEqual(["users-photo.png", "orders-receipt.bin"]);
    } finally {
      quiet.mockRestore();
    }
  });
});
