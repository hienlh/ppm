/**
 * A table tab on a phone, as the mockup draws it: no toolstrip — its buttons are one ⋯ menu in the
 * tab's header, Export a list of its own with Back — a thumb bar with New row, Filters and Save,
 * the "Columns · N hidden" chip and the sheet it opens, and a column's sheet with the rest of the
 * column menu. Mounted at 390px against a stub server; what reaches it is what is asserted.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every dropdown and dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { toast } = await import("sonner");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { TableView } = await import("../../../src/web/components/database/table/table-tab");
type DbTabContext = import("../../../src/web/components/database/use-db-tab").DbTabContext;
type Tab = import("../../../src/web/stores/tab-store").Tab;

const TAB_ID = "database:5::public:orders";
const CTX: DbTabContext = {
  target: { kind: "connection", connectionId: 5 }, conn: undefined, dbType: "postgres", dialect: "postgres",
  name: "shop", place: null, readonly: false, missing: false,
};
const PLACED: DbTabContext = { ...CTX, place: { target: CTX.target!, connectionName: "shop", dbType: "postgres" } };
const SCHEMA = [
  { name: "id", type: "integer", nullable: false, pk: true, defaultValue: null, fk: null },
  { name: "status", type: "text", nullable: true, pk: false, defaultValue: null, fk: null },
  { name: "qty", type: "integer", nullable: true, pk: false, defaultValue: null, fk: null },
  { name: "customer_id", type: "integer", nullable: true, pk: false, defaultValue: null, fk: { table: "customers", column: "id" } },
  { name: "payload", type: "jsonb", nullable: true, pk: false, defaultValue: null, fk: null },
];

type Req = { method: string; url: string; body: Record<string, unknown> | undefined };
const realFetch = globalThis.fetch;
const realWidth = window.innerWidth;
let requests: Req[] = [];
let total = 2;

beforeEach(() => {
  requests = [];
  total = 2;
  sessionStorage.clear();
  localStorage.clear();
  // `useIsMobile` reads `window.innerWidth`, so a phone is one property away.
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    requests.push(req);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (req.url.startsWith("/api/db/connections/5/schema")) return json(200, { ok: true, data: SCHEMA });
    if (req.url.startsWith("/api/db/connections/5/grid/count")) return json(200, { ok: true, data: { count: total, estimate: null } });
    if (req.url.startsWith("/api/db/connections/5/grid")) {
      const { offset, limit } = req.body as { offset: number; limit: number };
      const end = Math.min(total, offset + limit);
      const rows = Array.from({ length: Math.max(0, end - offset) }, (_, i) => [offset + i + 1, "active", 7, 3, null]);
      return json(200, { ok: true, data: { columns: SCHEMA.map((c) => ({ name: c.name, type: c.type })), rows, hasMore: end < total, sql: "SELECT", rowKey: ["id"] } });
    }
    return json(404, { ok: false, error: `no stub for ${req.method} ${req.url}` });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
});

function seedTab(metadata: Record<string, unknown>) {
  const tab: Tab = { id: TAB_ID, type: "database", title: "orders", projectId: null, closable: true, metadata };
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "left", grid: [["left"]], lastFocusedChatProviders: {},
    panels: { left: { id: "left", activeTabId: TAB_ID, tabHistory: [TAB_ID], tabs: [tab] } },
  } as never);
}
const tabMetadata = () => usePanelStore.getState().panels.left!.tabs[0]!.metadata!;

const BASE = { connectionId: 5, schemaName: "public", tableName: "orders" };
const settle = () => act(async () => { await Bun.sleep(5); });

async function open(metadata: Record<string, unknown> = BASE, ctx: DbTabContext = CTX) {
  seedTab(metadata);
  view = await mount(<TableView tab={ctx} table="orders" schemaName="public" tabId={TAB_ID} />);
  await settle();
  await settle();
}

const gridReads = () => requests.filter((r) => r.method === "POST" && /\/grid(\?|$)/.test(r.url)).map((r) => r.body!);
const byLabel = <T extends Element = HTMLElement>(label: string, root: ParentNode = document) =>
  [...root.querySelectorAll<T>("[aria-label]")].find((e) => e.getAttribute("aria-label") === label) ?? null;
const button = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
/** The ⋯ menu's rows as they read, a separator as "—". */
const menuRows = () => [...(menu()?.children ?? [])].map((e) => (e.getAttribute("role") === "separator" ? "—" : `${e.textContent}${(e as HTMLButtonElement).disabled ? " (disabled)" : ""}`));
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const sheetTitle = () => sheet()?.querySelector("h2")?.textContent ?? null;
const chipRow = () => document.querySelector<HTMLElement>('[role="group"][aria-label="Filters"]');
const chips = () => [...(chipRow()?.querySelectorAll("button") ?? [])].map((b) => b.getAttribute("aria-label") ?? b.textContent);

async function tap(target: Element | null) {
  await click(target);
  await settle();
}

describe("a table tab's actions on a phone", () => {
  it("has no toolstrip: its buttons are one menu in the tab's header", async () => {
    await open();
    expect(document.querySelector('[role="toolbar"]')?.outerHTML).toBeUndefined();
    expect(byLabel("View columns")?.outerHTML).toBeUndefined();
    // The rows' count is in the header, not in the grid's corner.
    expect(document.querySelector("header")!.textContent).toContain("Rows: 2");
    expect([...document.querySelectorAll('[role="status"]')].some((e) => e.textContent?.startsWith("Rows:"))).toBe(false);

    await tap(byLabel("Table actions"));
    expect(menu()!.getAttribute("aria-label")).toBe("orders: table actions");
    expect(menuRows()).toEqual([
      "Structure (disabled)", "SQL (disabled)", "—",
      "Refresh", "Refresh with structure", "Start auto refresh", "Switch to form", "Show cell data", "Export", "—",
      "Undo (disabled)", "Redo (disabled)", "Revert all changes (disabled)",
    ]);
    // Every row is a thumb's height.
    for (const row of menu()!.querySelectorAll('[role="menuitem"]')) expect(row.className).toContain("min-h-11");
  });

  it("refreshes from the menu and closes it", async () => {
    await open();
    const reads = gridReads().length;
    await tap(byLabel("Table actions"));
    await tap(button("Refresh", menu()!));
    expect(menu()?.outerHTML).toBeUndefined();
    expect(gridReads().length).toBe(reads + 1);
  });

  it("starts auto refresh from the menu, which then says how often and offers Stop", async () => {
    await open();
    await tap(byLabel("Table actions"));
    await tap(button("Start auto refresh", menu()!));
    await tap(byLabel("Table actions"));
    expect(menuRows()).toContain("Stop auto refreshevery 10s");
    await tap([...menu()!.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Stop auto refresh"))!);
    await tap(byLabel("Table actions"));
    expect(menuRows()).toContain("Start auto refresh");
  });

  it("opens Export as a list of its own, which Back leaves", async () => {
    await open();
    await tap(byLabel("Table actions"));
    await tap(button("Export", menu()!));
    expect(menu()!.getAttribute("aria-label")).toBe("Export");
    const rows = menuRows();
    expect(rows[0]).toBe("Back");
    expect(rows.length).toBeGreaterThan(2);
    await tap(button("Back", menu()!));
    expect(menu()!.getAttribute("aria-label")).toBe("orders: table actions");
  });

  it("offers Fetch all rows while rows remain, asking first", async () => {
    total = 230;
    await open();
    await tap(byLabel("Table actions"));
    expect(menuRows()).toContain("Fetch all rows");
    await tap(button("Fetch all rows", menu()!));
    expect(sheetTitle()).toBe("Fetch All Rows");
    await tap(button("Fetch All", sheet()!));
    await settle();
    expect(gridReads().map((b) => [b.offset, b.limit])).toEqual([[0, 100], [100, 5_000]]);
  });

  it("switches to the form as a sheet over the grid's row, and leaves a form view saved in the tab for a desktop", async () => {
    await open({ ...BASE, gridView: { form: true } });
    // The grid as ever, with the thumb bar's New row that a form view would have taken away.
    expect(byLabel("orders as a form")?.outerHTML).toBeUndefined();
    expect(byLabel("New row")).not.toBeNull();
    await tap(byLabel("Table actions"));
    await tap(button("Switch to form", menu()!));
    expect(sheetTitle()).toBe("orders · id = 1Row 1 / 2");
  });

  it("opens Structure and SQL from the menu where the tab has a place to open them", async () => {
    await open(BASE, PLACED);
    await tap(byLabel("Table actions"));
    await tap(button("Structure", menu()!));
    expect(menu()?.outerHTML).toBeUndefined();
    const opened = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).filter((t) => t.id !== TAB_ID);
    expect(opened.map((t) => t.type)).toEqual(["db-structure"]);
  });
});

describe("the thumb bar", () => {
  it("has New row, Filters and Save, Save greyed out with nothing to save", async () => {
    await open();
    const save = byLabel<HTMLButtonElement>("Save")!;
    expect(save.disabled).toBe(true);
    expect(byLabel("New row")).not.toBeNull();
    expect(button("Filters")).not.toBeNull();
    // A new row with nothing typed in it is nothing to save, yet Revert takes it away.
    await tap(byLabel("New row"));
    expect(byLabel<HTMLButtonElement>("Save")!.disabled).toBe(true);
    await tap(byLabel("Table actions"));
    expect(menuRows()).toContain("Revert all changes");
    // The phone's Ctrl+Z and Ctrl+Y: Undo takes the new row away, Redo puts it back.
    expect(menuRows()).toEqual(expect.arrayContaining(["Undo", "Redo (disabled)"]));
    await tap(button("Undo", menu()!));
    await tap(byLabel("Table actions"));
    expect(menuRows()).toEqual(expect.arrayContaining(["Undo (disabled)", "Redo", "Revert all changes (disabled)"]));
    await tap(button("Redo", menu()!));
    await tap(byLabel("Table actions"));
    expect(menuRows()).toEqual(expect.arrayContaining(["Undo", "Redo (disabled)", "Revert all changes"]));
  });

  it("has no New row on a read-only connection, and Save says why", async () => {
    await open(BASE, { ...CTX, readonly: true });
    expect(byLabel("New row")?.outerHTML).toBeUndefined();
    expect(byLabel<HTMLButtonElement>("Save: the connection is read-only")!.disabled).toBe(true);
  });
});

describe("Columns and filters on a phone", () => {
  it("shows Columns · N hidden only while a column is hidden, and opens the sheet from it", async () => {
    await open({ ...BASE, gridView: { hidden: ["qty", "payload"] } });
    expect(chips()).toContain("Columns · 2 hidden");
    await tap(button("Columns · 2 hidden"));
    expect(sheetTitle()).toBe("Columns and filtersorders · 3 of 5 columns shown");
    const box = byLabel<HTMLInputElement>("Show qty in the grid", sheet()!)!;
    expect(box.checked).toBe(false);
    // 44px to tap: the box's label, and its row.
    expect(box.closest("label")!.className).toContain("size-11");
    expect(box.closest('[role="listitem"]')!.className).toContain("h-11");
    await tap(box);
    expect(sheetTitle()).toBe("Columns and filtersorders · 4 of 5 columns shown");
    expect(tabMetadata().gridView).toEqual({ hidden: ["payload"] });
    await tap(button("Done", sheet()!));
    expect(chips()).toContain("Columns · 1 hidden");
  });

  it("opens the same sheet from the thumb bar's Filters, and starts a Multi column filter from it", async () => {
    await open();
    expect(chipRow()?.outerHTML).toBeUndefined();
    await tap(button("Filters"));
    expect(sheetTitle()).toBe("Columns and filtersorders · 5 of 5 columns shown");
    await tap(byLabel("Multi column filter: none — tap to add one", sheet()!));
    expect(sheetTitle()).toBe("Multi column filterEvery column of the table reads it");
  });

  it("goes away when a column's name or the table it refers to is tapped, to show what was asked for", async () => {
    await open(BASE, PLACED);
    await tap(button("Filters"));
    const rowOf = (name: string) => byLabel(`Show ${name} in the grid`, sheet()!)!.closest('[role="listitem"]')!;
    await tap(button("qty", rowOf("qty")));
    expect(sheet()?.outerHTML).toBeUndefined();
    await tap(button("Filters"));
    await tap(button("customers", rowOf("customer_id")));
    expect(sheet()?.outerHTML).toBeUndefined();
    const opened = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).filter((t) => t.id !== TAB_ID);
    expect(opened.map((t) => [t.type, t.metadata?.tableName])).toEqual([["database", "customers"]]);
  });

  it("switches a filter off and removes it from the sheet", async () => {
    await open({ ...BASE, filters: { columns: { qty: { text: ">5" } } } });
    await tap(button("Filters"));
    const on = byLabel<HTMLInputElement>("Apply the qty filter", sheet()!)!;
    expect(on.checked).toBe(true);
    await tap(on);
    expect(gridReads().at(-1)).toMatchObject({ filters: [] });
    expect(tabMetadata().filters).toEqual({ columns: { qty: { text: ">5", off: true } } });
    await tap(byLabel("Remove the qty filter", sheet()!));
    expect(tabMetadata().filters).toBeUndefined();
  });
});

describe("a column's sheet on a phone", () => {
  it("hides the column it was opened on", async () => {
    await open();
    await tap(byLabel("Column menu: qty"));
    await tap(button("Hide column", sheet()!));
    expect(sheet()?.outerHTML).toBeUndefined();
    expect(chips()).toContain("Columns · 1 hidden");
    expect(byLabel("Column menu: qty")?.outerHTML).toBeUndefined();
  });

  it("copies the column's name", async () => {
    const copied: string[] = [];
    const clipboard = { writeText: async (t: string) => { copied.push(t); } };
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    const success = spyOn(toast, "success").mockImplementation(() => 0);
    try {
      await open();
      await tap(byLabel("Column menu: status"));
      await tap(button("Copy column name", sheet()!));
      await settle();
      expect(copied).toEqual(["status"]);
      expect(success.mock.calls.at(-1)?.[0]).toBe("Column name copied");
    } finally {
      success.mockRestore();
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("adds a column to the sort already in force, and the sort shows as a chip", async () => {
    await open();
    await tap(byLabel("Column menu: qty"));
    await tap(button("Sort descending", sheet()!));
    await tap(byLabel("Column menu: status"));
    expect(button("Clear sort criteria", sheet()!)?.outerHTML).toBeUndefined();
    await tap(button("Add to sort - ascending", sheet()!));
    expect(gridReads().at(-1)!.sort).toEqual([{ column: "qty", dir: "DESC" }, { column: "status", dir: "ASC" }]);
    expect(chips()).toContain("Sorted by qty ↓, status ↑");
    // The chip opens the first sorted column's sheet.
    await tap(byLabel("Sorted by qty ↓, status ↑"));
    expect(sheetTitle()).toBe("qtyinteger");
  });

  it("opens the table a foreign key refers to, where the tab has a place to open it", async () => {
    await open(BASE, PLACED);
    await tap(byLabel("Column menu: customer_id"));
    await tap(button("Open customers", sheet()!));
    const opened = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).filter((t) => t.id !== TAB_ID);
    expect(opened.map((t) => [t.type, t.metadata?.tableName])).toEqual([["database", "customers"]]);
  });

  it("has no Open item without a place, nor on a column with no foreign key", async () => {
    await open();
    await tap(byLabel("Column menu: customer_id"));
    expect(button("Open customers", sheet()!)?.outerHTML).toBeUndefined();
    await tap(byLabel("Close", sheet()!));
    await view!.unmount();
    view = null;
    await open(BASE, PLACED);
    await tap(byLabel("Column menu: qty"));
    expect([...sheet()!.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Open "))).toBe(false);
  });
});
