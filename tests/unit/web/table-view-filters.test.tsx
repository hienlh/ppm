/**
 * A table's filters as the tab keeps them: the Filters panel beside the grid lists each one with a
 * switch and ×, the tab's metadata keeps them — the ones switched off too — so the table opens
 * filtered again, already on its first read, and Ctrl+Shift+E (DBGate's Clear filter) takes them
 * all off. Mounted against a stub server; what reaches it is what is asserted.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every dropdown and dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { TableView } = await import("../../../src/web/components/database/table/table-tab");
type DbTabContext = import("../../../src/web/components/database/use-db-tab").DbTabContext;
type Tab = import("../../../src/web/stores/tab-store").Tab;

const TAB_ID = "database:5::public:orders";
const CTX: DbTabContext = {
  target: { kind: "connection", connectionId: 5 }, conn: undefined, dbType: "postgres", dialect: "postgres",
  name: "shop", place: null, readonly: false, missing: false,
};
const SCHEMA = [
  { name: "id", type: "integer", nullable: false, pk: true, defaultValue: null, fk: null },
  { name: "status", type: "text", nullable: true, pk: false, defaultValue: null, fk: null },
  { name: "qty", type: "integer", nullable: true, pk: false, defaultValue: null, fk: null },
];

type Req = { method: string; url: string; body: unknown };
const realFetch = globalThis.fetch;
let requests: Req[] = [];
/** How the stub answers a read of the rows; a status other than 200 is a refusal with that message. */
let gridAnswer: (body: { filters?: unknown[] }) => { status: number; error?: string } = () => ({ status: 200 });
/** While set, a read of the rows waits for it. */
let gridGate: Promise<void> | null = null;

beforeEach(() => {
  requests = [];
  gridAnswer = () => ({ status: 200 });
  gridGate = null;
  // A table's plain first page is cached per browser tab.
  sessionStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(req);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (req.url.startsWith("/api/db/connections/5/schema")) return json(200, { ok: true, data: SCHEMA });
    if (req.url.startsWith("/api/db/connections/5/grid/count")) return json(200, { ok: true, data: { count: 2, estimate: null } });
    if (req.url.startsWith("/api/db/connections/5/grid")) {
      if (gridGate) await gridGate;
      const a = gridAnswer(req.body as { filters?: unknown[] });
      if (a.status !== 200) return json(a.status, { ok: false, error: a.error });
      return json(200, { ok: true, data: { columns: SCHEMA.map((c) => ({ name: c.name, type: c.type })), rows: [[1, "active", 7], [2, "pending", 9]], hasMore: false, sql: "SELECT", rowKey: ["id"] } });
    }
    return json(404, { ok: false, error: `no stub for ${req.method} ${req.url}` });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
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

/** `inTab` false: the table picked inside a database file's tab, which keeps no filters. */
async function open(metadata: Record<string, unknown>, inTab = true) {
  seedTab(metadata);
  view = await mount(<TableView tab={CTX} table="orders" schemaName="public" tabId={inTab ? TAB_ID : undefined} />);
  await settle();
  await settle();
}

const gridReads = () => requests
  .filter((r) => r.method === "POST" && /\/grid(\?|$)/.test(r.url))
  .map((r) => { const { filters, anyColumn } = r.body as { filters: unknown[]; anyColumn: unknown[] }; return { filters, anyColumn }; });
const panel = () => document.querySelector<HTMLElement>('section[aria-label="Filters"]');
const byLabel = <T extends Element>(root: ParentNode, label: string) =>
  [...root.querySelectorAll<T>("[aria-label]")].filter((e) => e.getAttribute("aria-label") === label);
/** A column's box in the Filters panel, or in the filter row under the grid's titles. */
const panelBox = (label: string) => byLabel<HTMLInputElement>(panel()!, label)[0] ?? null;
const rowBox = (label: string) => byLabel<HTMLInputElement>(document, label).find((e) => !panel()!.contains(e)) ?? null;
/** What the panel lists, in order: each filter's name and whether it is applied. */
const listed = () => [...panel()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  .map((c) => `${c.getAttribute("aria-label")}: ${c.checked ? "on" : "off"}`);

async function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await settle();
}

async function toggle(label: string) {
  await click(byLabel(panel()!, label)[0]!);
  await settle();
}

const KEPT = { columns: { qty: { text: ">5" }, status: { text: "active", off: true } } };
const QTY_GT_5 = { column: "qty", anyOf: [[{ op: "gt", value: 5 }]] };
const STATUS_ACTIVE = { column: "status", anyOf: [[{ op: "contains", value: "active" }]] };

describe("a table tab's filters", () => {
  it("opens the column menu from ⌄ on a desktop, not a phone's filter sheet", async () => {
    await open(BASE);
    await click(byLabel(document, "Column menu: qty")[0]!);
    await settle();
    expect(document.querySelector('[role="menu"][aria-label="Column menu: qty"]')?.textContent).toContain("Sort ascending");
    expect(document.querySelector('[role="dialog"]')?.outerHTML).toBeUndefined();
  });

  it("opens on the filters the tab kept, on the table's very first read", async () => {
    await open({ ...BASE, filters: KEPT });
    expect(gridReads()).toEqual([{ filters: [QTY_GT_5], anyColumn: [] }]);
    // A desktop has the panel and the filter row; the chips are a phone's.
    expect(document.querySelector('[role="group"][aria-label="Filters"]')?.outerHTML).toBeUndefined();
    // In the table's column order, the one switched off kept as it was.
    expect(listed()).toEqual(["Apply the status filter: off", "Apply the qty filter: on"]);
    expect(panelBox("Filter status")!.value).toBe("active");
    expect(rowBox("Filter qty")!.value).toBe(">5");
    // Switched off reads as struck through, in the panel and in the filter row alike.
    expect(panelBox("Filter status")!.className).toContain("line-through");
    expect(rowBox("Filter status")!.className).toContain("line-through");
    expect(rowBox("Filter qty")!.className).not.toContain("line-through");
  });

  it("opens on a kept Multi column filter alone", async () => {
    await open({ ...BASE, filters: { columns: {}, multi: { text: "7" } } });
    expect(gridReads()).toEqual([{
      filters: [],
      anyColumn: [{ column: "id", anyOf: [[{ op: "eq", value: 7 }]] }, { column: "status", anyOf: [[{ op: "contains", value: "7" }]] }, { column: "qty", anyOf: [[{ op: "eq", value: 7 }]] }],
    }]);
  });

  it("shows the rows it has from before at once when every kept filter is switched off", async () => {
    await open(BASE);
    await view!.unmount();
    view = null;
    requests = [];
    gridGate = new Promise(() => {});
    await open({ ...BASE, filters: { columns: { qty: { text: ">5", off: true } } } });
    // Still reading, with the rows from before on screen.
    expect(gridReads()).toEqual([{ filters: [], anyColumn: [] }]);
    expect(rowBox("Filter qty")!.value).toBe(">5");
  });

  it("reads the rows without a filter switched off, and keeps the filter", async () => {
    await open({ ...BASE, filters: KEPT });
    await toggle("Apply the qty filter");
    expect(gridReads().at(-1)).toEqual({ filters: [], anyColumn: [] });
    expect(rowBox("Filter qty")!.value).toBe(">5");
    expect(tabMetadata().filters).toEqual({ columns: { qty: { text: ">5", off: true }, status: { text: "active", off: true } } });

    await toggle("Apply the status filter");
    expect(gridReads().at(-1)).toEqual({ filters: [STATUS_ACTIVE], anyColumn: [] });
    expect(listed()).toEqual(["Apply the status filter: on", "Apply the qty filter: off"]);
    // The tab's other metadata is left as it was.
    expect(tabMetadata()).toEqual({ ...BASE, filters: { columns: { qty: { text: ">5", off: true }, status: { text: "active" } } } });
  });

  it("removes a filter with ×, and keeps nothing once none is left", async () => {
    await open({ ...BASE, filters: KEPT });
    await click(byLabel(panel()!, "Remove the qty filter")[0]!);
    await settle();
    expect(gridReads().at(-1)).toEqual({ filters: [], anyColumn: [] });
    expect(rowBox("Filter qty")!.value).toBe("");
    expect(listed()).toEqual(["Apply the status filter: off"]);
    await click(byLabel(panel()!, "Remove the status filter")[0]!);
    await settle();
    expect(listed()).toEqual([]);
    expect(tabMetadata()).toEqual(BASE);
  });

  it("has one filter in the panel and in the filter row, whichever is typed in", async () => {
    await open(BASE);
    expect(gridReads()).toEqual([{ filters: [], anyColumn: [] }]);
    expect(listed()).toEqual([]);
    // The panel has a box only for a column that has a filter.
    expect(panelBox("Filter qty")?.outerHTML).toBeUndefined();

    await type(rowBox("Filter qty")!, "<9");
    expect(gridReads().at(-1)).toEqual({ filters: [{ column: "qty", anyOf: [[{ op: "lt", value: 9 }]] }], anyColumn: [] });
    expect(listed()).toEqual(["Apply the qty filter: on"]);
    expect(panelBox("Filter qty")!.value).toBe("<9");

    await type(panelBox("Filter qty")!, "7");
    expect(gridReads().at(-1)).toEqual({ filters: [{ column: "qty", anyOf: [[{ op: "eq", value: 7 }]] }], anyColumn: [] });
    expect(rowBox("Filter qty")!.value).toBe("7");

    await type(rowBox("Filter status")!, "^p");
    expect(gridReads().at(-1)).toEqual({ filters: [{ column: "status", anyOf: [[{ op: "startsWith", value: "p" }]] }, { column: "qty", anyOf: [[{ op: "eq", value: 7 }]] }], anyColumn: [] });
    expect(listed()).toEqual(["Apply the status filter: on", "Apply the qty filter: on"]);
    expect(tabMetadata().filters).toEqual({ columns: { qty: { text: "7" }, status: { text: "^p" } } });
  });

  it("keeps the Multi column filter, which reads every column it can", async () => {
    await open(BASE);
    // The filter row has no box for it: it is the panel's own.
    expect(rowBox("Multi column filter")?.outerHTML).toBeUndefined();
    await type(panelBox("Multi column filter")!, "7");
    expect(gridReads().at(-1)).toEqual({
      filters: [],
      anyColumn: [{ column: "id", anyOf: [[{ op: "eq", value: 7 }]] }, { column: "status", anyOf: [[{ op: "contains", value: "7" }]] }, { column: "qty", anyOf: [[{ op: "eq", value: 7 }]] }],
    });
    await toggle("Apply this filter");
    expect(gridReads().at(-1)).toEqual({ filters: [], anyColumn: [] });
    expect(tabMetadata().filters).toEqual({ columns: {}, multi: { text: "7", off: true } });
  });

  it("writes what the Multi column filter's funnel builds into the Multi column filter", async () => {
    await open(BASE);
    const trigger = byLabel(panel()!, "Filter options: all columns")[0]!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    });
    await click([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Filter multiple values")!);
    await settle();
    const lines = byLabel<HTMLTextAreaElement>(document.body, "One value per line")[0]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lines), "value")!.set!.call(lines, "7\n9");
      lines.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "OK")!);
    await settle();
    expect(panelBox("Multi column filter")!.value).toBe("='7',='9'");
    expect(listed()).toEqual(["Apply this filter: on"]);
    expect(gridReads().at(-1)!.anyColumn).toHaveLength(3);
    expect(tabMetadata().filters).toEqual({ columns: {}, multi: { text: "='7',='9'" } });
  });

  it("does not keep a filter on a column the table no longer has", async () => {
    await open({ ...BASE, filters: { columns: { gone: { text: "x" }, qty: { text: ">5" } } } });
    expect(gridReads()).toEqual([{ filters: [QTY_GT_5], anyColumn: [] }]);
    expect(tabMetadata().filters).toEqual({ columns: { qty: { text: ">5" } } });
  });

  it("keeps nothing for a table picked inside a database file's tab, which changes table", async () => {
    await open({ ...BASE, filters: KEPT }, false);
    expect(gridReads()).toEqual([{ filters: [], anyColumn: [] }]);
    await type(rowBox("Filter qty")!, "<9");
    expect(tabMetadata().filters).toEqual(KEPT);
  });
});

describe("kept filters the server refuses", () => {
  it("shows why on the filter to blame, and waits for it to change before reading the rows", async () => {
    gridAnswer = (body) => ((body.filters ?? []).length > 0 ? { status: 400, error: 'Unknown column "qty"' } : { status: 200 });
    await open({ ...BASE, filters: { columns: { qty: { text: ">5" } } } });
    // Rows read without the filter would sit under a box that looks applied.
    expect(gridReads()).toHaveLength(1);
    expect(panelBox("Filter qty")!.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain('Unknown column "qty"');

    await toggle("Apply the qty filter");
    expect(gridReads().at(-1)).toEqual({ filters: [], anyColumn: [] });
    expect(panelBox("Filter qty")!.getAttribute("aria-invalid")).toBe("false");
    expect(rowBox("Filter qty")).not.toBeNull();
  });

  it("blames no filter for a failure the filters do not explain", async () => {
    gridAnswer = () => ({ status: 500, error: "connection reset" });
    await open({ ...BASE, filters: { columns: { qty: { text: ">5" } } } });
    expect(gridReads()).toHaveLength(1);
    expect(panelBox("Filter qty")!.getAttribute("aria-invalid")).toBe("false");
    expect(document.body.textContent).toContain("connection reset");
  });
});

describe("Ctrl+Shift+E", () => {
  const press = (target: Element, init: KeyboardEventInit) =>
    act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

  it("takes every filter off, the Multi column filter too, and goes no further", async () => {
    await open({ ...BASE, filters: { ...KEPT, multi: { text: "7" } } });
    const heard: string[] = [];
    const listener = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener("keydown", listener);
    try {
      await press(panelBox("Filter qty")!, { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true });
      await settle();
    } finally {
      window.removeEventListener("keydown", listener);
    }
    // PPM's own Mod+Shift+E (Source Control) never hears it.
    expect(heard).toEqual([]);
    expect(gridReads().at(-1)).toEqual({ filters: [], anyColumn: [] });
    expect(listed()).toEqual([]);
    expect(panelBox("Multi column filter")!.value).toBe("");
    expect(tabMetadata()).toEqual(BASE);
  });

  it("is left alone without Shift, while composing, and from outside the view", async () => {
    await open({ ...BASE, filters: KEPT });
    await press(panelBox("Filter qty")!, { key: "e", code: "KeyE", ctrlKey: true });
    await press(panelBox("Filter qty")!, { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true, isComposing: true });
    await press(document.body, { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true });
    await settle();
    expect(gridReads()).toHaveLength(1);
    expect(tabMetadata().filters).toEqual(KEPT);
  });
});
