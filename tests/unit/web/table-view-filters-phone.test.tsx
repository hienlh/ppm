/**
 * A table's filters on a phone, which has neither the filter row nor the Filters panel: each
 * filter is a chip above the grid, and a chip, a column's ⌄ or its title opens that filter's
 * sheet. The sheet applies only on Apply or Enter — closing it changes nothing. Mounted at 390px
 * against a stub server; what reaches it is what is asserted.
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
  { name: "customer_id", type: "integer", nullable: true, pk: false, defaultValue: null, fk: { table: "customers", column: "id" } },
  { name: "payload", type: "jsonb", nullable: true, pk: false, defaultValue: null, fk: null },
];

type Req = { method: string; url: string; body: unknown };
const realFetch = globalThis.fetch;
const realWidth = window.innerWidth;
let requests: Req[] = [];
/** How the stub answers a read of the rows; a status other than 200 is a refusal with that message. */
let gridAnswer: (body: { filters?: unknown[] }) => { status: number; error?: string } = () => ({ status: 200 });

beforeEach(() => {
  requests = [];
  gridAnswer = () => ({ status: 200 });
  sessionStorage.clear();
  // `useIsMobile` reads `window.innerWidth`, so a phone is one property away.
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(req);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (req.url.startsWith("/api/db/connections/5/schema?table=orders")) return json(200, { ok: true, data: SCHEMA });
    if (req.url.startsWith("/api/db/connections/5/grid/count")) return json(200, { ok: true, data: { count: 2, estimate: null } });
    if (req.url.startsWith("/api/db/connections/5/grid/values")) return json(200, { ok: true, data: { values: [], hasMore: false } });
    if (req.url.startsWith("/api/db/connections/5/grid")) {
      const a = gridAnswer(req.body as { filters?: unknown[] });
      if (a.status !== 200) return json(a.status, { ok: false, error: a.error });
      return json(200, { ok: true, data: { columns: SCHEMA.map((c) => ({ name: c.name, type: c.type })), rows: [[1, "active", 7, 3, null], [2, "pending", 9, 4, null]], hasMore: false, sql: "SELECT", rowKey: ["id"] } });
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
const tabFilters = () => usePanelStore.getState().panels.left!.tabs[0]!.metadata!.filters;

const BASE = { connectionId: 5, schemaName: "public", tableName: "orders" };
const settle = () => act(async () => { await Bun.sleep(5); });

async function open(filters?: unknown) {
  seedTab(filters ? { ...BASE, filters } : BASE);
  view = await mount(<TableView tab={CTX} table="orders" schemaName="public" tabId={TAB_ID} />);
  await settle();
  await settle();
}

const gridReads = () => requests
  .filter((r) => r.method === "POST" && /\/grid(\?|$)/.test(r.url))
  .map((r) => { const { filters, anyColumn, sort } = r.body as { filters: unknown[]; anyColumn: unknown[]; sort: unknown[] }; return { filters, anyColumn, sort }; });
const lastRead = () => gridReads().at(-1);
const byLabel = <T extends Element>(label: string, root: ParentNode = document) =>
  [...root.querySelectorAll<T>("[aria-label]")].find((e) => e.getAttribute("aria-label") === label) ?? null;
const chipRow = () => document.querySelector<HTMLElement>('[role="group"][aria-label="Filters"]');
/** Each chip as a screen reader names it, in order. */
const chips = () => [...(chipRow()?.querySelectorAll<HTMLButtonElement>("button:not([title='Remove'])") ?? [])].map((b) => b.getAttribute("aria-label"));
const chip = (name: string) => [...(chipRow()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.getAttribute("aria-label")?.startsWith(`${name}: `)) ?? null;
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const sheetTitle = () => sheet()?.querySelector("h2")?.textContent ?? null;
const sheetButton = (text: string) => [...(sheet()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === text) ?? null;
const sheetStatus = () => sheet()?.querySelector("[aria-live]")?.textContent ?? null;
const sheetBox = () => sheet()?.querySelector<HTMLInputElement>("input") ?? null;

async function typeIn(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
  await settle();
}
async function tap(target: Element | null) {
  await click(target);
  await settle();
}

const KEPT = { columns: { qty: { text: ">5" }, status: { text: "active", off: true }, id: { text: ">x" } }, multi: { text: "7" } };
const QTY_GT_5 = { column: "qty", anyOf: [[{ op: "gt", value: 5 }]] };
const QTY_GT_7 = { column: "qty", anyOf: [[{ op: "gt", value: 7 }]] };
const STATUS_ACTIVE = { column: "status", anyOf: [[{ op: "contains", value: "active" }]] };

describe("a table's filters on a phone", () => {
  it("shows a chip per filter in the table's column order, the Multi column filter last, and no filter row or panel", async () => {
    await open(KEPT);
    expect(chips()).toEqual(["id: >x, not understood", "status: active, switched off", "qty: >5", "any column: 7"]);
    expect(document.querySelector('section[aria-label="Filters"]')?.outerHTML).toBeUndefined();
    expect(byLabel("Filter qty")?.outerHTML).toBeUndefined();
    // What each chip looks like says the same as what it is called.
    expect(chip("id")!.querySelector("svg")!.getAttribute("data-icon")).toBe("AlertTriangle");
    expect(chip("qty")!.querySelector("svg")!.getAttribute("data-icon")).toBe("Filter");
    expect(chip("id")!.parentElement!.className).toContain("text-error");
    expect(chip("status")!.parentElement!.className).toContain("border-dashed");
    expect(chip("status")!.querySelector(".font-mono")!.className).toContain("line-through");
    expect(chip("qty")!.parentElement!.className).toContain("text-success");
    expect(chip("qty")!.querySelector(".font-mono")!.className).not.toContain("line-through");
  });

  it("shows no chips while there is no filter", async () => {
    await open();
    expect(chipRow()?.outerHTML).toBeUndefined();
  });

  it("removes a filter with its ×, and the rows are read without it", async () => {
    await open({ columns: { qty: { text: ">5" }, status: { text: "active" } }, multi: { text: "7" } });
    await tap(byLabel("Remove the qty filter"));
    expect(lastRead()!.filters).toEqual([STATUS_ACTIVE]);
    expect(chips()).toEqual(["status: active", "any column: 7"]);
    await tap(byLabel("Remove the Multi column filter"));
    expect(lastRead()!.anyColumn).toEqual([]);
    expect(chips()).toEqual(["status: active"]);
    expect(tabFilters()).toEqual({ columns: { status: { text: "active" } } });
  });

  it("applies a sheet's text only on Apply — closing it leaves the filter as it was", async () => {
    await open({ columns: { qty: { text: ">5" } } });
    const reads = gridReads().length;
    await tap(chip("qty"));
    expect(sheetTitle()).toContain("qty");
    expect(sheetBox()!.value).toBe(">5");
    expect(sheetStatus()).toBe("Understood · Apply filters the rows");

    await typeIn(sheetBox()!, ">7");
    await tap(byLabel("Close", sheet()!));
    expect(sheet()?.outerHTML).toBeUndefined();
    expect(gridReads().length).toBe(reads);
    expect(chips()).toEqual(["qty: >5"]);

    await tap(chip("qty"));
    // What was typed and closed on is gone.
    expect(sheetBox()!.value).toBe(">5");
    await typeIn(sheetBox()!, ">7");
    await tap(sheetButton("Apply"));
    expect(sheet()?.outerHTML).toBeUndefined();
    expect(lastRead()!.filters).toEqual([QTY_GT_7]);
    expect(chips()).toEqual(["qty: >7"]);
  });

  it("applies on Enter, but not on a modified Enter or on Esc, which closes the sheet", async () => {
    await open({ columns: { qty: { text: ">5" } } });
    const reads = gridReads().length;
    await tap(chip("qty"));
    await typeIn(sheetBox()!, ">7");
    await press(sheetBox()!, "Enter", { shiftKey: true });
    await press(sheetBox()!, "Enter", { isComposing: true });
    expect(gridReads().length).toBe(reads);
    expect(sheet()).not.toBeNull();
    await press(sheetBox()!, "Escape");
    expect(sheet()?.outerHTML).toBeUndefined();
    expect(gridReads().length).toBe(reads);

    await tap(chip("qty"));
    await typeIn(sheetBox()!, ">7");
    await press(sheetBox()!, "Enter");
    expect(sheet()?.outerHTML).toBeUndefined();
    expect(lastRead()!.filters).toEqual([QTY_GT_7]);
  });

  it("will not apply a text that does not read, and says why", async () => {
    await open({ columns: { qty: { text: ">5" } } });
    const reads = gridReads().length;
    await tap(chip("qty"));
    await typeIn(sheetBox()!, ">x");
    expect(sheetStatus()).toEndWith("— it would not be applied");
    expect(sheetBox()!.getAttribute("aria-invalid")).toBe("true");
    expect(sheetButton("Apply")!.disabled).toBe(true);
    await press(sheetBox()!, "Enter");
    expect(sheet()).not.toBeNull();
    expect(gridReads().length).toBe(reads);
  });

  it("switches a filter that was off back on when it is applied", async () => {
    await open({ columns: { status: { text: "active", off: true } } });
    expect(gridReads().at(0)!.filters).toEqual([]);
    await tap(chip("status"));
    expect(sheetStatus()).toBe("Switched off · Apply switches it on");
    expect(sheetBox()!.className).toContain("line-through");
    // A new text is a new filter, which Apply applies like any other.
    await typeIn(sheetBox()!, "pending");
    expect(sheetStatus()).toBe("Understood · Apply filters the rows");
    expect(sheetBox()!.className).not.toContain("line-through");
    await typeIn(sheetBox()!, "active");
    await tap(sheetButton("Apply"));
    expect(lastRead()!.filters).toEqual([STATUS_ACTIVE]);
    expect(chips()).toEqual(["status: active"]);
  });

  it("clears the filter with Clear Filter", async () => {
    await open({ columns: { qty: { text: ">5" }, status: { text: "active" } } });
    await tap(chip("qty"));
    await tap(sheetButton("Clear Filter"));
    expect(lastRead()!.filters).toEqual([STATUS_ACTIVE]);
    expect(chips()).toEqual(["status: active"]);
  });

  it("opens a column's sheet from its ⌄, with the funnel's items and the column's sort", async () => {
    await open();
    await tap(byLabel("Column menu: qty"));
    expect(document.querySelector('[role="menu"]')?.outerHTML).toBeUndefined();
    expect(sheetTitle()).toBe("qtyinteger");
    expect(sheetStatus()).toBe("No filter on this column");
    const labels = [...sheet()!.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Equals...");
    expect(labels).toContain("Is Null");
    expect(labels).not.toContain("Contains...");
    // Clear Filter is the sheet's own button, once.
    expect(labels.filter((l) => l === "Clear Filter")).toHaveLength(1);
    expect(labels).not.toContain("Clear sort criteria");

    await tap(sheetButton("Is Null"));
    expect(sheet()?.outerHTML).toBeUndefined();
    expect(lastRead()!.filters).toEqual([{ column: "qty", anyOf: [[{ op: "isNull" }]] }]);
    expect(chips()).toEqual(["qty: NULL"]);
  });

  it("sorts from a column's sheet and shows which way", async () => {
    await open();
    await tap(byLabel("Column menu: qty"));
    await tap(sheetButton("Sort descending"));
    expect(sheet()?.outerHTML).toBeUndefined();
    expect(lastRead()!.sort).toEqual([{ column: "qty", dir: "DESC" }]);

    await tap(byLabel("Column menu: qty"));
    expect(sheetButton("Sort descending")!.getAttribute("aria-pressed")).toBe("true");
    expect(sheetButton("Sort ascending")!.getAttribute("aria-pressed")).toBe("false");
    await tap(sheetButton("Clear sort criteria"));
    expect(lastRead()!.sort).toEqual([]);

    // Another column's sheet does not offer to clear a sort that is not its own.
    await tap(byLabel("Column menu: qty"));
    await tap(sheetButton("Sort ascending"));
    await tap(byLabel("Column menu: status"));
    expect(sheetButton("Clear sort criteria")?.outerHTML).toBeUndefined();
    expect(sheetButton("Sort ascending")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("hands a funnel item that needs a dialog, ⋮ and ⋯ over to their own sheets", async () => {
    await open();
    await tap(byLabel("Column menu: qty"));
    await tap(sheetButton("Equals..."));
    // The column's sheet makes way: the dialog's is the only one.
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(sheetTitle()).toBe("Set filter");
    await tap(sheetButton("Close"));

    await tap(byLabel("Column menu: status"));
    await tap(byLabel("Choose value from status", sheet()!));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(sheetTitle()).toBe("Choose value from status");
    await tap(sheetButton("Close"));

    await tap(byLabel("Column menu: customer_id"));
    expect(sheetTitle()).toBe("customer_idinteger · → customers.id");
    expect(byLabel("Choose value from customer_id", sheet()!)?.outerHTML).toBeUndefined();
    await tap(byLabel("Lookup from customers", sheet()!));
    expect(sheetTitle()).toBe("Lookup from customers");
  });

  it("offers no ⋮ on a column whose values cannot be listed", async () => {
    await open();
    await tap(byLabel("Column menu: payload"));
    expect(sheetTitle()).toContain("payload");
    expect(sheet()!.querySelector('[aria-label^="Choose value"]')?.outerHTML).toBeUndefined();
    expect(sheet()!.querySelector('[aria-label^="Lookup"]')?.outerHTML).toBeUndefined();
  });

  it("turns pasted lines into one filter, applied only on Apply", async () => {
    await open();
    await tap(byLabel("Column menu: qty"));
    const box = sheetBox()!;
    // One line is pasted as it is, by the browser.
    const single = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(single, "clipboardData", { value: { getData: () => "5" } });
    await act(async () => { box.dispatchEvent(single); });
    expect(single.defaultPrevented).toBe(false);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "5\n7\n" } });
    await act(async () => { box.dispatchEvent(paste); });
    expect(paste.defaultPrevented).toBe(true);
    // The filter row's own form for a list of values.
    expect(box.value).toBe("='5',='7'");
    const reads = gridReads().length;
    await settle();
    expect(gridReads().length).toBe(reads);
    await tap(sheetButton("Apply"));
    expect(lastRead()!.filters).toEqual([{ column: "qty", anyOf: [[{ op: "in", values: [5, 7] }]] }]);
  });

  it("opens the Multi column filter's sheet from its chip, with no sort and no ⋮", async () => {
    await open({ columns: {}, multi: { text: "7" } });
    await tap(chip("any column"));
    expect(sheetTitle()).toContain("Multi column filter");
    expect(sheetButton("Sort ascending")?.outerHTML).toBeUndefined();
    expect(sheet()!.querySelector('[aria-label^="Choose value"]')?.outerHTML).toBeUndefined();
    // A text item writes into the Multi column filter, not a column's.
    await tap(sheetButton("Is Null"));
    expect(lastRead()!.filters).toEqual([]);
    expect(lastRead()!.anyColumn).toEqual([
      { column: "id", anyOf: [[{ op: "isNull" }]] }, { column: "status", anyOf: [[{ op: "isNull" }]] },
      { column: "qty", anyOf: [[{ op: "isNull" }]] }, { column: "customer_id", anyOf: [[{ op: "isNull" }]] },
      { column: "payload", anyOf: [[{ op: "isNull" }]] },
    ]);
    expect(chips()).toEqual(["any column: NULL"]);
  });

  it("marks a filter the server refused, on its chip and in its sheet", async () => {
    gridAnswer = (body) => ((body.filters ?? []).length > 0 ? { status: 400, error: "qty is not comparable" } : { status: 200 });
    await open();
    await tap(byLabel("Column menu: qty"));
    await typeIn(sheetBox()!, ">5");
    await tap(sheetButton("Apply"));
    expect(lastRead()!.filters).toEqual([QTY_GT_5]);
    expect(chips()).toEqual(["qty: >5, refused"]);
    expect(chip("qty")!.querySelector("svg")!.getAttribute("data-icon")).toBe("AlertTriangle");
    await tap(chip("qty"));
    expect(sheetStatus()).toBe("Refused: qty is not comparable");
    // Changing the text is a new filter, which the server has not refused yet.
    await typeIn(sheetBox()!, ">6");
    expect(sheetStatus()).toBe("Understood · Apply filters the rows");
  });
});
