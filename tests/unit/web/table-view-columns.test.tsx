/**
 * A table tab as DBGate lays it out on a desktop: the Columns panel beside the grid, which hides
 * columns without reading anything again; the panel's edge, toggle and — in a narrow tab — its
 * floating; DBGate's keys; Fetch all; the empty grids; a read-only connection's toolbar. Mounted
 * against a stub server; what reaches it is what is asserted.
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
const { parseCombo } = await import("../../../src/web/stores/keybindings-store");
const { TableView } = await import("../../../src/web/components/database/table/table-tab");
type DbTabContext = import("../../../src/web/components/database/use-db-tab").DbTabContext;
type Tab = import("../../../src/web/stores/tab-store").Tab;

const TAB_ID = "database:5::public:orders";
const CTX: DbTabContext = {
  target: { kind: "connection", connectionId: 5 }, conn: undefined, dbType: "postgres", dialect: "postgres",
  name: "shop", place: null, readonly: false, missing: false,
};
const SCHEMA = [
  { name: "id", type: "integer", nullable: false, pk: true, defaultValue: "nextval('orders_id_seq'::regclass)", autoIncrement: true, fk: null },
  { name: "status", type: "text", nullable: false, pk: false, defaultValue: null, fk: null },
  { name: "qty", type: "numeric(12,2)", nullable: true, pk: false, defaultValue: null, fk: null },
  { name: "customer_id", type: "integer", nullable: true, pk: false, defaultValue: null, fk: { table: "customers", column: "id" } },
];

type Req = { method: string; url: string; body: Record<string, unknown> | undefined };
const realFetch = globalThis.fetch;
let requests: Req[] = [];
/** Rows in the stub's table; the rows it hands out depend on the offset and limit asked for. */
let total = 2;
/** The stub's table holds no row matching any filter. */
let filteredEmpty = false;
/** While set, a read past the first row waits here until the test lets it through. */
let heldReads: (() => void)[] | null = null;

beforeEach(() => {
  requests = [];
  total = 2;
  filteredEmpty = false;
  heldReads = null;
  sessionStorage.clear();
  localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    requests.push(req);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (req.url.startsWith("/api/db/connections/5/schema")) return json(200, { ok: true, data: SCHEMA });
    if (req.url.startsWith("/api/db/connections/5/grid/count")) return json(200, { ok: true, data: { count: total, estimate: null } });
    if (req.url.startsWith("/api/db/connections/5/grid")) {
      const { offset, limit, filters } = req.body as { offset: number; limit: number; filters: unknown[] };
      if (heldReads && offset > 0) await new Promise<void>((resolve) => heldReads!.push(resolve));
      const end = filteredEmpty && filters.length ? 0 : Math.min(total, offset + limit);
      const rows = Array.from({ length: Math.max(0, end - offset) }, (_, i) => [offset + i + 1, "active", 7, 3]);
      return json(200, { ok: true, data: { columns: SCHEMA.map((c) => ({ name: c.name, type: c.type })), rows, hasMore: end < total && !(filteredEmpty && filters.length), sql: "SELECT", rowKey: ["id"] } });
    }
    return json(404, { ok: false, error: `no stub for ${req.method} ${req.url}` });
  }) as typeof fetch;
});

let view: Mounted | null = null;
let widthStub: PropertyDescriptor | undefined;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  if (widthStub) {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    widthStub = undefined;
  }
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

/** The tab is this wide — the view measures its own root, which happy-dom draws 0 wide. */
function tabWidth(px: number) {
  widthStub = { configurable: true, get(this: HTMLElement) { return this.classList?.contains("@container") ? px : 0; } };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", widthStub);
}

const gridReads = () => requests.filter((r) => r.method === "POST" && /\/grid(\?|$)/.test(r.url)).map((r) => r.body!);
const byLabel = <T extends Element = HTMLElement>(label: string, root: ParentNode = document) =>
  [...root.querySelectorAll<T>("[aria-label]")].find((e) => e.getAttribute("aria-label") === label) ?? null;
const button = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;
const panel = () => document.querySelector<HTMLElement>("aside[data-table-panel]");
const columnsList = () => byLabel("Columns of the table");
const listed = () => [...(columnsList()?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])]
  .map((c) => `${c.getAttribute("aria-label")!.replace(/^Show (.*) in the grid$/, "$1")}: ${c.checked ? "shown" : "hidden"}`);
/** The columns the grid shows, by their ⌄ buttons laid over its titles. */
const gridColumns = () => [...document.querySelectorAll("[aria-label^='Column menu: ']")]
  .filter((b) => b.tagName === "BUTTON").map((b) => b.getAttribute("aria-label")!.slice("Column menu: ".length));
const splitter = () => document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize the left panel"]');
/** Somewhere in the view that is not a text field: where the grid has focus. */
const inGrid = () => document.querySelector<HTMLElement>(".dvn-scroller") ?? document.querySelector<HTMLElement>('[tabindex="0"]')!;

/** A keydown as the browser sends it, bubbling from `target`; `Mod` is Ctrl, or ⌘ on a Mac. */
async function press(combo: string, target: Element = inGrid()) {
  const parsed = parseCombo(combo);
  const name = combo.split("+").at(-1)!;
  const e = new KeyboardEvent("keydown", {
    key: name.length === 1 ? name.toLowerCase() : name, bubbles: true, cancelable: true,
    ctrlKey: parsed.ctrl, metaKey: parsed.meta, altKey: parsed.alt, shiftKey: parsed.shift,
  });
  await act(async () => { target.dispatchEvent(e); });
  await settle();
  return e;
}

async function tick(checkbox: HTMLInputElement | null) {
  await click(checkbox);
  await settle();
}

describe("the Columns panel", () => {
  it("lists every column with its key, type and NOT NULL in bold", async () => {
    await open();
    expect(listed()).toEqual(["id: shown", "status: shown", "qty: shown", "customer_id: shown"]);
    const row = (name: string) => byLabel(`Show ${name} in the grid`)!.closest('[role="listitem"]')!;
    expect(row("qty").textContent).toContain("numeric(12,2)");
    expect(byLabel("Auto-increment key", row("id"))).not.toBeNull();
    expect(byLabel("Foreign key", row("customer_id"))).not.toBeNull();
    // NOT NULL is bold; the key column too, since a key is never null.
    const name = (n: string) => [...row(n).querySelectorAll("button")].find((b) => b.textContent === n)!;
    expect(name("status").className).toContain("font-semibold");
    expect(name("qty").className).not.toContain("font-semibold");
    expect(name("status").title).toBe("NOT NULL · Go to it in the grid");
  });

  it("hides a column from the grid without reading anything again, and the tab keeps it hidden", async () => {
    await open();
    const before = requests.length;
    await tick(byLabel<HTMLInputElement>("Show qty in the grid"));
    expect(requests.length).toBe(before);
    expect(gridColumns()).toEqual(["id", "status", "customer_id"]);
    expect(listed()).toContain("qty: hidden");
    expect(tabMetadata().gridView).toEqual({ hidden: ["qty"] });

    // Opened again, the table shows as it was left.
    await view!.unmount();
    view = null;
    await open(tabMetadata());
    expect(gridColumns()).toEqual(["id", "status", "customer_id"]);
    expect(listed()).toContain("qty: hidden");
  });

  it("hides and shows every column at once, and an empty grid offers them back", async () => {
    await open();
    await click(byLabel("Hide all columns"));
    await settle();
    expect(gridColumns()).toEqual([]);
    expect(document.body.textContent).toContain("Every column is hidden");
    expect(byLabel<HTMLButtonElement>("Hide all columns")!.disabled).toBe(true);
    await click(button("Show all columns"));
    await settle();
    expect(gridColumns()).toEqual(["id", "status", "qty", "customer_id"]);
    expect(byLabel<HTMLButtonElement>("Show all columns")!.disabled).toBe(true);
    expect(tabMetadata().gridView).toBeUndefined();
  });

  it("finds a column by part of its name, and says when none matches", async () => {
    await open();
    const search = byLabel<HTMLInputElement>("Search columns")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(search, "ID");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(listed()).toEqual(["id: shown", "customer_id: shown"]);
    await act(async () => {
      setValue.call(search, "zzz");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(columnsList()!.textContent).toContain("No column matches “zzz”.");
    await click(button("Clear search", columnsList()!));
    expect(listed()).toHaveLength(4);
  });

  it("says a hidden column has to be shown before the grid can go to it", async () => {
    const info = spyOn(toast, "info").mockImplementation(() => 0);
    try {
      await open({ ...BASE, gridView: { hidden: ["qty"] } });
      await click(button("qty", columnsList()!));
      expect(info.mock.calls[0]?.[0]).toBe("qty is hidden in the grid: tick it in Columns to show it");
    } finally {
      info.mockRestore();
    }
  });

  it("forgets a hidden column the table no longer has", async () => {
    await open({ ...BASE, gridView: { hidden: ["dropped", "qty"], columnWidths: { dropped: 90, status: 140 } } });
    expect(tabMetadata().gridView).toEqual({ hidden: ["qty"], columnWidths: { status: 140 } });
  });

  it("on a phone, goes to the column from anywhere on its row but the checkbox and the table link", async () => {
    // A name's button is as wide as its word — 12px for `id`, seen in a browser at 390px — so in the
    // sheet it is stretched over the row, under the two controls that keep a tap of their own.
    const { ColumnsSection } = await import("../../../src/web/components/database/grid/columns-panel");
    const jumped: string[] = [];
    view = await mount(
      <ColumnsSection
        schema={SCHEMA} hidden={new Set()} onHiddenChange={() => {}} onJump={(c) => jumped.push(c)} onOpenTable={() => {}}
        sheet grow={false} collapsed={false} onCollapsedChange={() => {}}
      />,
    );
    const row = (n: string) => byLabel(`Show ${n} in the grid`)!.closest<HTMLElement>('[role="listitem"]')!;
    const classes = (e: Element | null | undefined) => e?.className.split(/\s+/) ?? [];
    const name = button("id", row("id"))!;
    expect(classes(row("id"))).toContain("relative");
    expect(classes(name)).toEqual(expect.arrayContaining(["after:absolute", "after:inset-0"]));
    expect(classes(byLabel("Show id in the grid")!.closest("label"))).toEqual(expect.arrayContaining(["relative", "z-10"]));
    expect(classes(button("customers", row("customer_id")))).toEqual(expect.arrayContaining(["relative", "z-10"]));
    await click(name);
    expect(jumped).toEqual(["id"]);

    // Beside a desktop grid the rows are not positioned, so a stretched name would cover the panel.
    await view.unmount();
    view = await mount(
      <ColumnsSection
        schema={SCHEMA} hidden={new Set()} onHiddenChange={() => {}} onJump={() => {}} onOpenTable={() => {}}
        collapsed={false} onCollapsedChange={() => {}}
      />,
    );
    expect(classes(button("id", row("id")))).not.toContain("after:inset-0");
  });
});

describe("the panel's edge, toggle and floating", () => {
  it("moves its edge by keys between 170 and 420px, and the tab keeps the width", async () => {
    await open({ ...BASE, gridView: { panelWidth: 222 } });
    expect(panel()!.style.width).toBe("222px");
    expect(splitter()!.getAttribute("aria-valuenow")).toBe("222");
    await press("ArrowRight", splitter()!);
    expect(splitter()!.getAttribute("aria-valuenow")).toBe("238");
    expect(tabMetadata().gridView).toEqual({ panelWidth: 238 });
    await press("ArrowLeft", splitter()!);
    await press("ArrowLeft", splitter()!);
    expect(panel()!.style.width).toBe("206px");
    await press("End", splitter()!);
    expect(splitter()!.getAttribute("aria-valuenow")).toBe("420");
    await press("Home", splitter()!);
    expect(splitter()!.getAttribute("aria-valuenow")).toBe("170");
    await press("ArrowLeft", splitter()!);
    expect(splitter()!.getAttribute("aria-valuenow")).toBe("170");
    expect([splitter()!.getAttribute("aria-valuemin"), splitter()!.getAttribute("aria-valuemax")]).toEqual(["170", "420"]);
  });

  it("is put away and brought back by View columns, by Ctrl+L and by « in the grid's corner", async () => {
    await open();
    const viewColumns = () => byLabel<HTMLButtonElement>("View columns")!;
    expect(panel()).not.toBeNull();
    expect(viewColumns().getAttribute("aria-pressed")).toBe("true");
    await click(viewColumns());
    expect(panel()?.outerHTML).toBeUndefined();
    expect(viewColumns().getAttribute("aria-pressed")).toBe("false");
    const e = await press("Mod+L");
    expect(panel()).not.toBeNull();
    // Ctrl+L is PPM's Open Chat, and the browser's address bar: neither while the table has focus.
    expect(e.defaultPrevented).toBe(true);
    await click(byLabel("Hide the left panel (Ctrl+L)"));
    expect(panel()?.outerHTML).toBeUndefined();
    await click(byLabel("Show the left panel (Ctrl+L)"));
    expect(panel()).not.toBeNull();
  });

  it("floats over the grid in a tab 860px or narrower, put away until asked for", async () => {
    tabWidth(820);
    await open();
    expect(panel()?.outerHTML).toBeUndefined();
    await click(byLabel("View columns"));
    expect(panel()!.className).toContain("absolute");
    // No edge to drag while it floats.
    expect(splitter()?.outerHTML).toBeUndefined();
    await press("Escape", byLabel("Search columns")!);
    expect(panel()?.outerHTML).toBeUndefined();

    await click(byLabel("View columns"));
    expect(panel()).not.toBeNull();
    // A click inside the panel keeps it; one on the grid puts it away.
    await act(async () => { byLabel("Search columns")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(panel()).not.toBeNull();
    await act(async () => { inGrid().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(panel()?.outerHTML).toBeUndefined();
  });

  it("sits beside the grid in a wider tab", async () => {
    tabWidth(1_000);
    await open();
    expect(panel()!.className).not.toContain("absolute");
    expect(splitter()).not.toBeNull();
    // Esc means nothing to a panel that does not float.
    await press("Escape", byLabel("Search columns")!);
    expect(panel()).not.toBeNull();
  });
});

describe("DBGate's keys on the table", () => {
  it("reads the rows again on F5 and Ctrl+R, instead of reloading the page", async () => {
    await open();
    const reads = gridReads().length;
    const f5 = await press("F5");
    expect(f5.defaultPrevented).toBe(true);
    const ctrlR = await press("Mod+R");
    expect(ctrlR.defaultPrevented).toBe(true);
    expect(gridReads().length).toBe(reads + 2);
  });

  it("reads the columns again too on Ctrl+F5", async () => {
    await open();
    const schemaReads = () => requests.filter((r) => r.url.includes("/schema")).length;
    const before = schemaReads();
    await press("Mod+F5");
    expect(schemaReads()).toBe(before + 1);
  });

  it("starts and stops auto refresh on Ctrl+Shift+R, saying so on the button", async () => {
    await open();
    expect(byLabel("Refresh")).not.toBeNull();
    await press("Mod+Shift+R");
    expect(byLabel("Refresh (every 10s)")).not.toBeNull();
    await press("Mod+Shift+R");
    expect(byLabel("Refresh")).not.toBeNull();
  });

  it("adds a row on Insert, which Revert all takes away again", async () => {
    await open();
    expect(button("Revert all")?.outerHTML).toBeUndefined();
    await press("Insert");
    expect(button("Revert all")).not.toBeNull();
    await click(button("Revert all"));
    await settle();
    expect(button("Revert all")?.outerHTML).toBeUndefined();
  });

  it("undoes one step at a time with Ctrl+Z, in the grid or on its toolbar, and redoes with Ctrl+Y", async () => {
    await open();
    await press("Insert");
    await press("Insert");
    // In the grid the grid takes it, and the view does not take it a second time.
    await press("Mod+Z");
    expect(button("Revert all")).not.toBeNull();
    // On a toolbar button it is still the grid's change set that steps back.
    await press("Mod+Z", byLabel("Refresh")!);
    expect(button("Revert all")?.outerHTML).toBeUndefined();
    await press("Mod+Y", byLabel("Refresh")!);
    expect(button("Revert all")).not.toBeNull();
  });

  it("leaves the selection's keys to the browser outside the grid: on its toolbar, Ctrl+F is the page's find", async () => {
    await open();
    for (const combo of ["Mod+F", "Mod+H", "Mod+Shift+C", "Mod+0", "Mod+Shift+F", "Mod+J", "Mod+G"]) {
      expect([combo, (await press(combo, byLabel("Refresh")!)).defaultPrevented]).toEqual([combo, false]);
    }
    expect(document.activeElement).not.toBe(byLabel("Search columns"));
  });

  it("finds a column with Ctrl+F in the grid: the panel comes back with the cursor in its search", async () => {
    await open();
    await click(byLabel("Hide the left panel (Ctrl+L)"));
    expect(panel()?.outerHTML).toBeUndefined();
    const find = await press("Mod+F", byLabel("Column menu: qty")!);
    expect(find.defaultPrevented).toBe(true);
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(byLabel("Search columns"));
  });

  it("leaves a filter box its own keys", async () => {
    await open();
    const box = byLabel<HTMLInputElement>("Search columns")!;
    const insert = await press("Insert", box);
    expect(insert.defaultPrevented).toBe(false);
    expect(button("Revert all")?.outerHTML).toBeUndefined();
    // Refresh is the table's everywhere in it.
    const reads = gridReads().length;
    await press("F5", box);
    expect(gridReads().length).toBe(reads + 1);
  });
});

describe("the keys when the tab comes to the front, as DBGate's focusOnVisible", () => {
  // Glide draws no canvas where nothing has a size, as here: the form's box is what is seen taking them.
  const FORM = { ...BASE, gridView: { form: true } };
  const formHasKeys = () => !!document.activeElement?.hasAttribute("data-form-view");
  const front = (focusedPanelId: string, activeTabId = TAB_ID) => act(async () => {
    const { panels } = usePanelStore.getState();
    usePanelStore.setState({
      focusedPanelId,
      panels: {
        left: { ...panels.left!, activeTabId },
        right: { id: "right", activeTabId: "other", tabHistory: ["other"], tabs: [] },
      },
    } as never);
    await Bun.sleep(5);
  });

  it("hands the keys to the tab opened in front", async () => {
    await open(FORM);
    expect(formHasKeys()).toBe(true);
  });

  it("leaves them alone while another panel or another tab of its panel is in front, and takes them once it is", async () => {
    seedTab(FORM);
    await front("right");
    view = await mount(<TableView tab={CTX} table="orders" schemaName="public" tabId={TAB_ID} />);
    await settle();
    await settle();
    expect(formHasKeys()).toBe(false);
    await front("left", "other");
    expect(formHasKeys()).toBe(false);
    await front("left");
    expect(formHasKeys()).toBe(true);
  });
});

describe("Fetch all", () => {
  it("asks first, then reads every remaining row and says so", async () => {
    total = 230;
    const success = spyOn(toast, "success").mockImplementation(() => 0);
    try {
      await open();
      await click(button("Fetch all"));
      await settle();
      const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog()?.textContent).toContain("Fetch All Rows");
      expect(gridReads()).toHaveLength(1);
      heldReads = [];
      await click(button("Fetch All", dialog()!));
      await settle();
      // While it reads, the grid says how far it got and Fetch all is not offered a second time.
      expect([...document.querySelectorAll('[role="status"]')].map((s) => s.textContent)).toContain("Fetching all rows... 100 loaded");
      expect(button("Fetch all")?.outerHTML).toBeUndefined();
      await act(async () => { heldReads!.shift()!(); await Bun.sleep(5); });
      await settle();
      expect(gridReads().map((b) => [b.offset, b.limit])).toEqual([[0, 100], [100, 5_000]]);
      expect(success.mock.calls.at(-1)?.[0]).toBe("All 230 rows loaded");
      // Everything is loaded: nothing left to fetch.
      expect(button("Fetch all")?.outerHTML).toBeUndefined();
    } finally {
      success.mockRestore();
    }
  });

  it("does not ask again once told not to, on this device", async () => {
    total = 230;
    await open();
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    // Ticked and then closed: nothing read, and the next Fetch all asks again.
    await click(button("Fetch all"));
    await settle();
    await click(dialog()!.querySelector('input[type="checkbox"]'));
    await click(button("Close", dialog()!));
    await settle();
    expect(gridReads()).toHaveLength(1);
    // Fetched without the tick: the next Fetch all, after a refresh, asks again.
    await click(button("Fetch all"));
    await settle();
    expect(dialog()?.textContent).toContain("Fetch All Rows");
    await click(button("Fetch All", dialog()!));
    await settle();
    expect(gridReads().map((b) => b.offset)).toEqual([0, 100]);
    await press("F5");
    await click(button("Fetch all"));
    await settle();
    expect(dialog()?.textContent).toContain("Fetch All Rows");
    await click(dialog()!.querySelector('input[type="checkbox"]'));
    await click(button("Fetch All", dialog()!));
    await settle();
    expect(gridReads().map((b) => b.offset)).toEqual([0, 100, 0, 100]);

    // Fetched with it: the rows read from the first again, Fetch all goes straight ahead.
    await press("F5");
    await click(button("Fetch all"));
    await settle();
    expect(dialog()?.outerHTML).toBeUndefined();
    expect(gridReads().map((b) => b.offset)).toEqual([0, 100, 0, 100, 0, 100]);
  });
});

describe("the toolbar on a read-only connection and on an empty result", () => {
  it("has no New row or Delete, and Save says why it cannot", async () => {
    await open(BASE, { ...CTX, readonly: true });
    expect(button("New row")?.outerHTML).toBeUndefined();
    expect(button("Delete row(s)")?.outerHTML).toBeUndefined();
    const save = byLabel<HTMLButtonElement>("Save")!;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe("The connection is read-only");
    // Insert adds nothing either.
    await press("Insert");
    expect(button("Revert all")?.outerHTML).toBeUndefined();
  });

  it("opens Structure and SQL in tabs of their own, which a view with no place for them cannot", async () => {
    await open();
    expect(byLabel<HTMLButtonElement>("Structure")!.disabled).toBe(true);
    expect(byLabel<HTMLButtonElement>("SQL")!.disabled).toBe(true);
    await view!.unmount();
    view = null;

    await open(BASE, { ...CTX, place: { target: CTX.target!, connectionName: "shop", dbType: "postgres" } });
    expect(byLabel<HTMLButtonElement>("Structure")!.title).toBe("Open the structure of orders in its own tab");
    await click(byLabel("Structure"));
    await click(byLabel("SQL"));
    const opened = () => Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).filter((t) => t.id !== TAB_ID);
    expect(opened().map((t) => [t.type, t.metadata?.tableName ?? t.metadata?.objectName])).toEqual([["db-structure", "orders"], ["db-sql", "orders"]]);
  });

  it("opens the SELECT behind an empty grid in a Query tab", async () => {
    filteredEmpty = true;
    await open({ ...BASE, filters: { columns: { qty: { text: ">5" } } } }, { ...CTX, place: { target: CTX.target!, connectionName: "shop", dbType: "postgres" } });
    await click(button("Open Query"));
    const query = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.type === "db-query");
    expect(JSON.stringify(query?.metadata)).toContain("SELECT");
  });

  it("offers Reset filter when the filters leave no row", async () => {
    filteredEmpty = true;
    await open({ ...BASE, filters: { columns: { qty: { text: ">5" } } } });
    expect(document.body.textContent).toContain("No rows loaded");
    await click(button("Reset filter"));
    await settle();
    expect(gridReads().at(-1)).toMatchObject({ filters: [], anyColumn: [] });
    expect(document.body.textContent).not.toContain("No rows loaded");
  });
});
