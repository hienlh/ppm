/**
 * Export from a table tab: the toolbar's Export ▾ on a desktop and the ⋯ menu's Export list on a
 * phone ask the server for every row the grid's filters and sort select — the columns it shows, in
 * its order — then download the ticket it answers, or say why it would not. Mounted against a stub
 * server; what reaches it is what is asserted. On a desktop Export advanced... heads the list, and
 * it and Ctrl+E open the Import/Export tab on the grid's query.
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
const { gridExportForm, impExpTitle } = await import("../../../src/web/components/database/impexp/impexp-state");
const { formatCombo, parseCombo } = await import("../../../src/web/stores/keybindings-store");
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
const FORMATS = [
  "JSON", "JSON lines/NDJSON", "SQL", "CSV file", "CSV file (semicolon separated)", "CSV file for MS Excel",
  "TSV file (tab separated)", "MS Excel", "XML file",
];

type Req = { method: string; url: string; body: Record<string, unknown> | undefined };
const realFetch = globalThis.fetch;
const realWidth = window.innerWidth;
let requests: Req[] = [];
/** What the server answers an export with. */
let exportAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true, data: { ticket: "t-1", fileName: "orders.xlsx" } } };
let downloads: { href: string | null; name: string | null }[] = [];
const takeDownload = (e: Event) => {
  const a = e.target as HTMLAnchorElement;
  if (a.tagName !== "A") return;
  downloads.push({ href: a.getAttribute("href"), name: a.getAttribute("download") });
  e.preventDefault();
};
let toasts: string[] = [];
const spies: { mockRestore: () => void }[] = [];

beforeEach(() => {
  requests = [];
  downloads = [];
  toasts = [];
  exportAnswer = { status: 200, body: { ok: true, data: { ticket: "t-1", fileName: "orders.xlsx" } } };
  sessionStorage.clear();
  localStorage.clear();
  document.addEventListener("click", takeDownload, true);
  spies.push(
    spyOn(toast, "loading").mockImplementation(((message: string) => { toasts.push(`loading: ${message}`); return "toast-1"; }) as never),
    spyOn(toast, "success").mockImplementation(((message: string, o?: { id?: unknown }) => { toasts.push(`success: ${message} (${String(o?.id)})`); return "toast-1"; }) as never),
    spyOn(toast, "error").mockImplementation(((message: string, o?: { id?: unknown; description?: unknown }) => {
      toasts.push(`error: ${message}: ${String(o?.description)} (${String(o?.id)})`);
      return "toast-1";
    }) as never),
  );
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
    requests.push(req);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (req.url.startsWith("/api/db/connections/5/schema")) return json(200, { ok: true, data: SCHEMA });
    if (req.url.startsWith("/api/db/connections/5/grid/count")) return json(200, { ok: true, data: { count: 2, estimate: null } });
    if (req.url.startsWith("/api/db/connections/5/grid/export")) return json(exportAnswer.status, exportAnswer.body);
    if (req.url.startsWith("/api/db/connections/5/grid")) {
      const rows = [[1, "active", 7], [2, "done", 9]];
      return json(200, { ok: true, data: { columns: SCHEMA.map((c) => ({ name: c.name, type: c.type })), rows, hasMore: false, sql: "SELECT", rowKey: ["id"] } });
    }
    return json(404, { ok: false, error: `no stub for ${req.method} ${req.url}` });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  document.removeEventListener("click", takeDownload, true);
  for (const spy of spies.splice(0)) spy.mockRestore();
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
});

const BASE = { connectionId: 5, schemaName: "public", tableName: "orders" };
const settle = () => act(async () => { await Bun.sleep(5); });

async function open(metadata: Record<string, unknown> = BASE) {
  const tab: Tab = { id: TAB_ID, type: "database", title: "orders", projectId: null, closable: true, metadata };
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "left", grid: [["left"]], lastFocusedChatProviders: {},
    panels: { left: { id: "left", activeTabId: TAB_ID, tabHistory: [TAB_ID], tabs: [tab] } },
  } as never);
  view = await mount(<TableView tab={CTX} table="orders" schemaName="public" tabId={TAB_ID} />);
  await settle();
  await settle();
}

const exports = () => requests.filter((r) => r.method === "POST" && r.url.startsWith("/api/db/connections/5/grid/export")).map((r) => r.body!);
const lastRead = () => requests.filter((r) => r.method === "POST" && /\/grid(\?|$)/.test(r.url)).at(-1)!.body!;
const byLabel = (label: string) => [...document.querySelectorAll<HTMLElement>("[aria-label]")].find((e) => e.getAttribute("aria-label") === label) ?? null;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuItems = () => [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
const menuItem = (label: string) => menuItems().find((i) => i.textContent?.trim() === label) ?? null;
/** The menu as read: each item's text, a separator as "—". */
const menuEntries = () => [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"]') ?? [])]
  .map((e) => (e.getAttribute("role") === "separator" ? "—" : e.textContent?.trim()));
/** The Import/Export tabs the panels hold. */
const impExpTabs = () => Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).filter((t) => t.type === "db-impexp");

async function openExportMenu(): Promise<void> {
  await act(async () => {
    byLabel("Export")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
  if (!menu()) throw new Error("Export ▾ did not open");
}

describe("Export ▾ on a desktop", () => {
  it("lists Export advanced... with its key, then DBGate's quick exports in its order", async () => {
    await open();
    await openExportMenu();
    expect(menuEntries()).toEqual([`Export advanced...${formatCombo("Mod+E")}`, "—", ...FORMATS]);
  });

  it("asks for the columns shown, in order, under the filters in force, then downloads the ticket", async () => {
    await open({ ...BASE, gridView: { hidden: ["status"] }, filters: { columns: { qty: { text: ">5" } } } });
    const read = lastRead();
    expect(read.filters).toEqual([{ column: "qty", anyOf: [[{ op: "gt", value: 5 }]] }]);
    await openExportMenu();
    await click(menuItem("MS Excel"));
    await settle();
    expect(exports()).toEqual([{
      table: "orders", schema: "public", filters: read.filters, anyColumn: [], sort: [], columns: ["id", "qty"], format: "xlsx",
    }]);
    expect(downloads).toEqual([{ href: "/api/db/grid-export/t-1", name: "orders.xlsx" }]);
    expect(toasts).toEqual(["loading: Exporting orders.xlsx…", "success: Downloading orders.xlsx (toast-1)"]);
  });

  it("says why the server would not export, and downloads nothing", async () => {
    exportAnswer = { status: 429, body: { ok: false, error: "8 exports are already running. Export again once one has finished." } };
    await open();
    await openExportMenu();
    await click(menuItem("CSV file"));
    await settle();
    expect(exports().map((b) => b.format)).toEqual(["csv"]);
    expect(downloads).toEqual([]);
    expect(toasts).toEqual([
      "loading: Exporting orders.csv…",
      "error: Export failed: 8 exports are already running. Export again once one has finished. (toast-1)",
    ]);
  });

  it("cannot export while every column is hidden, and says so", async () => {
    await open({ ...BASE, gridView: { hidden: ["id", "status", "qty"] } });
    const button = byLabel("Export") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Every column is hidden");
  });
});

/** A keydown as the browser sends it, from `target`; `Mod` is Ctrl, or ⌘ on a Mac. */
async function press(target: Element, combo: string): Promise<KeyboardEvent> {
  const parsed = parseCombo(combo);
  const e = new KeyboardEvent("keydown", {
    key: combo.split("+").at(-1)!.toLowerCase(), bubbles: true, cancelable: true,
    ctrlKey: parsed.ctrl, metaKey: parsed.meta, altKey: parsed.alt, shiftKey: parsed.shift,
  });
  await act(async () => { target.dispatchEvent(e); });
  await settle();
  return e;
}

describe("Export advanced...", () => {
  const DB = { target: CTX.target, schema: "public" };

  it("opens the Import/Export tab on the grid's query, keeping the columns shown when some are hidden", async () => {
    await open({ ...BASE, gridView: { hidden: ["status"] } });
    await openExportMenu();
    await click(menuItems()[0]!);
    await settle();
    const expected = gridExportForm(DB, "orders", "SELECT", ["id", "qty"]);
    expect(impExpTabs().map((t) => ({ title: t.title, form: t.metadata?.impexp }))).toEqual([{ title: impExpTitle(expected), form: expected }]);
    expect(exports()).toEqual([]);
  });

  it("names no columns when every one is shown: the rows are copied as they are", async () => {
    await open();
    await openExportMenu();
    await click(menuItems()[0]!);
    await settle();
    expect(impExpTabs().map((t) => t.metadata?.impexp)).toEqual([gridExportForm(DB, "orders", "SELECT")]);
  });

  it("opens on Ctrl+E, and each press opens a tab of its own", async () => {
    await open();
    const first = await press(byLabel("Export")!, "Mod+E");
    expect(first.defaultPrevented).toBe(true);
    await press(byLabel("Export")!, "Mod+E");
    expect(impExpTabs().map((t) => t.metadata?.impexp)).toEqual([gridExportForm(DB, "orders", "SELECT"), gridExportForm(DB, "orders", "SELECT")]);
    expect(new Set(impExpTabs().map((t) => t.metadata?.impexpId)).size).toBe(2);
  });

  it("opens nothing on Ctrl+E while every column is hidden, yet keeps the key from the browser", async () => {
    await open({ ...BASE, gridView: { hidden: ["id", "status", "qty"] } });
    const e = await press(byLabel("Export")!, "Mod+E");
    expect(e.defaultPrevented).toBe(true);
    expect(impExpTabs()).toEqual([]);
  });

  it("is not on a phone, whose Ctrl+E is left to the browser", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    await open();
    const e = await press(byLabel("Table actions")!, "Mod+E");
    expect(e.defaultPrevented).toBe(false);
    expect(impExpTabs()).toEqual([]);
  });
});

describe("Export on a phone", () => {
  beforeEach(() => {
    // `useIsMobile` reads `window.innerWidth`, so a phone is one property away.
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  });

  const tap = async (target: Element | null) => {
    await click(target);
    await settle();
  };
  const sheetButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === text) ?? null;
  const menuButton = (text: string) => [...(menu()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.trim() === text) ?? null;

  it("lists the formats after Back, closes the sheet on one, and exports in the sort the grid shows", async () => {
    exportAnswer = { status: 200, body: { ok: true, data: { ticket: "t-2", fileName: "orders.csv" } } };
    await open();
    await tap(byLabel("Column menu: qty"));
    await tap(sheetButton("Sort descending"));
    expect(lastRead().sort).toEqual([{ column: "qty", dir: "DESC" }]);

    await tap(byLabel("Table actions"));
    await tap(menuButton("Export"));
    expect([...menu()!.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Back", ...FORMATS]);
    await tap(menuButton("CSV file"));
    expect(menu()).toBeNull();
    expect(exports()).toEqual([{
      table: "orders", schema: "public", filters: [], anyColumn: [], sort: [{ column: "qty", dir: "DESC" }],
      columns: ["id", "status", "qty"], format: "csv",
    }]);
    expect(downloads).toEqual([{ href: "/api/db/grid-export/t-2", name: "orders.csv" }]);
  });

  it("greys Export out while every column is hidden", async () => {
    await open({ ...BASE, gridView: { hidden: ["id", "status", "qty"] } });
    await tap(byLabel("Table actions"));
    expect(menuButton("Export")!.disabled).toBe(true);
  });
});
