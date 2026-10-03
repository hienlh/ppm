/**
 * The Database sidebar's side of the connection tab: a save made there shows up in the tree (read
 * again, lit for a moment), a connection the tab just connected is opened, and a login held for a
 * connection that keeps no password can be dropped with Disconnect — and is not used again when
 * the tree is restored without it. Opening the tab from the sidebar is in
 * `database-sidebar-sections.test.tsx`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { DatabaseSidebar } = await import("../../../src/web/components/database/database-sidebar");
const { _resetDbExplorer } = await import("../../../src/web/components/database/explorer/db-explorer-store");
const { announceConnectionsChanged, revealConnection, useDbSidebarReveal } = await import("../../../src/web/components/database/db-sidebar-reveal");
const { DEFAULT_DB_EXPLORER, DEFAULT_DB_EXPLORER_VIEW } = await import("../../../src/shared/db-explorer-prefs");
type DbExplorerPrefs = import("../../../src/shared/db-explorer-prefs").DbExplorerPrefs;

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string };

const ok = (data: unknown): Answer => ({ body: { ok: true, data } });
const realFetch = globalThis.fetch;
let requests: Req[] = [];
let loggedIn = true;
let databasesFail = false;
/** A connection the server has saved, which the sidebar has not read yet. */
let saved: Record<string, unknown> | null = null;

const conn = () => ({
  id: 41, type: "postgres", name: "prod", group_name: null, color: null, readonly: 1, sort_order: 0, created_at: "", updated_at: "",
  password_mode: "askPassword", logged_in: loggedIn, default_database: null, single_database: false, server: "db.example:5432", user: "app",
});
const fresh = () => ({ ...conn(), id: 42, name: "fresh", password_mode: "save", logged_in: false, default_database: "billing" });

function answer(req: Req): Answer | undefined {
  switch (`${req.method} ${req.url}`) {
    case "GET /api/db/connections": return ok(saved ? [conn(), saved] : [conn()]);
    case "GET /api/db/connections/41/databases": return databasesFail ? { status: 500, body: { ok: false, error: "timeout expired" } } : ok(["sales"]);
    case "GET /api/db/connections/41/tables": return ok([{ name: "orders", schema: "public", rowCount: 3 }]);
    case "POST /api/db/connections/41/disconnect": loggedIn = false; return ok({ disconnected: true });
    case "GET /api/db/connections/42/databases": return ok(["billing"]);
    case "GET /api/db/connections/42/objects?database=billing": return ok({ schemas: ["public"], objects: [{ schema: "public", name: "invoices", kind: "table", rowEstimate: 7 }] });
    case "GET /api/db/connections/42/tables": return ok([{ name: "invoices", schema: "public", rowCount: 7 }]);
    case "PUT /api/settings/ui-prefs": return ok({});
    default: return undefined;
  }
}

beforeEach(() => {
  requests = [];
  loggedIn = true;
  databasesFail = false;
  saved = null;
  _resetDbExplorer();
  useDbSidebarReveal.setState({ revealId: null, expandId: null });
  useSettingsStore.setState({ dbExplorer: DEFAULT_DB_EXPLORER, dbExplorerView: DEFAULT_DB_EXPLORER_VIEW });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input) };
    requests.push(req);
    const found = answer(req);
    return new Response(JSON.stringify(found?.body ?? { ok: false, error: `no stub for ${req.method} ${req.url}` }), {
      status: found ? found.status ?? 200 : 599, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  for (const t of [...useTabStore.getState().tabs]) useTabStore.getState().closeTab(t.id);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mountSidebar(tree: Partial<DbExplorerPrefs> = {}): Promise<void> {
  useSettingsStore.setState({ dbExplorer: { ...DEFAULT_DB_EXPLORER, ...tree } });
  view = await mount(<DatabaseSidebar />);
  await settle();
}

const count = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url).length;
const treePrefs = () => useSettingsStore.getState().dbExplorer;
const rows = () => [...view!.container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const hasRow = (name: string) => rows().some((r) => [...r.querySelectorAll("span")].some((s) => s.textContent === name));
function row(name: string): HTMLElement {
  const found = rows().find((r) => [...r.querySelectorAll("span")].some((s) => s.textContent === name));
  if (!found) throw new Error(`no row "${name}"`);
  return found;
}

/** The labels of the menu a right-click on `el` opens. */
async function menuOf(el: Element): Promise<HTMLElement[]> {
  await act(async () => { el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 })); });
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error("no menu opened");
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
}
const labels = (items: HTMLElement[]) => items.map((i) => i.textContent?.trim());

async function closeMenu(): Promise<void> {
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) return;
  await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();
}

describe("the Database sidebar and the connection tab", () => {
  it("reads a connection saved from the tab again, databases and all, when the tree has it open", async () => {
    await mountSidebar({ opened: [41], expandedConns: [41] });
    expect(hasRow("sales")).toBe(true);
    const before = { list: count("GET", "/api/db/connections"), databases: count("GET", "/api/db/connections/41/databases"), tables: count("GET", "/api/db/connections/41/tables") };

    await act(async () => { announceConnectionsChanged({ connectionId: 41, refreshTables: true }); });
    await settle();
    expect(count("GET", "/api/db/connections")).toBe(before.list + 1);
    expect(count("GET", "/api/db/connections/41/databases")).toBe(before.databases + 1);
    expect(count("GET", "/api/db/connections/41/tables")).toBe(before.tables + 1);
    // Still open, and still expanded: the save changed what it points at, not how the tree shows it.
    expect(row("prod").querySelector('[aria-label="Connected"]') != null).toBe(true);
    expect(hasRow("sales")).toBe(true);

    // A login held elsewhere changes the list, not what the tree read of it.
    await act(async () => { announceConnectionsChanged({ connectionId: 41 }); });
    await settle();
    expect(count("GET", "/api/db/connections")).toBe(before.list + 2);
    expect(count("GET", "/api/db/connections/41/databases")).toBe(before.databases + 1);
  });

  it("does not ask for a password again when a failed connection is saved without its login held", async () => {
    databasesFail = true;
    await mountSidebar({ opened: [41] });
    expect(row("prod").querySelector('[aria-label="Error: timeout expired"]') != null).toBe(true);

    // Saved from the tab, which dropped the login it held: connecting now would put Database Log In up unasked.
    loggedIn = false;
    databasesFail = false;
    await act(async () => { announceConnectionsChanged({ connectionId: 41, refreshTables: true }); });
    await settle();
    expect(count("GET", "/api/db/connections/41/databases")).toBe(1);
    expect(treePrefs().opened).not.toContain(41);
    expect(row("prod").querySelector('[aria-label^="Error"]') != null).toBe(false);
  });

  it("only refreshes the palette's table list of a saved connection the tree has not opened", async () => {
    await mountSidebar();
    expect(count("GET", "/api/db/connections/41/databases")).toBe(0);

    await act(async () => { announceConnectionsChanged({ connectionId: 41, refreshTables: true }); });
    await settle();
    expect(count("GET", "/api/db/connections/41/tables")).toBe(1);
    expect(count("GET", "/api/db/connections/41/databases")).toBe(0);
    expect(treePrefs().opened).not.toContain(41);
  });

  it("opens a connection the tab just connected, though its list has not read it yet", async () => {
    await mountSidebar();
    saved = fresh();

    await act(async () => { revealConnection({ id: 42, group_name: null }, { expand: true, refreshTables: true }); });
    await settle();
    expect(treePrefs().opened).toContain(42);
    expect(treePrefs().expandedConns).toContain(42);
    // Its own database became current, so the object list below shows it.
    expect(useSettingsStore.getState().dbExplorerView.current).toEqual({ conn: 42, database: "billing" });
    expect(hasRow("fresh")).toBe(true);
    expect(hasRow("invoices")).toBe(true);
    expect(useDbSidebarReveal.getState().expandId).toBeNull();
  });

  it("lights the connection the tab just saved, for a moment", async () => {
    await mountSidebar();
    expect(row("prod").dataset.flash).toBeUndefined();

    await act(async () => { useDbSidebarReveal.setState({ revealId: 41 }); });
    expect(row("prod").dataset.flash).toBe("edit");

    await act(async () => { await Bun.sleep(1500); });
    expect(useDbSidebarReveal.getState().revealId).toBeNull();
    expect(row("prod").dataset.flash).toBeUndefined();
  });

  it("drops a held login with Disconnect and closes the connection's node", async () => {
    await mountSidebar({ opened: [41], expandedConns: [41] });
    expect(hasRow("sales")).toBe(true);

    const items = await menuOf(row("prod"));
    expect(labels(items)).toContain("Disconnect");
    await click(items.find((i) => i.textContent?.trim() === "Disconnect")!);
    await settle();
    expect(count("POST", "/api/db/connections/41/disconnect")).toBe(1);
    expect(treePrefs().opened).not.toContain(41);
    expect(treePrefs().expandedConns).not.toContain(41);
    expect(hasRow("sales")).toBe(false);
    expect(row("prod").querySelector('[aria-label="Connected"]') != null).toBe(false);

    const after = labels(await menuOf(row("prod")));
    expect(after).toContain("Connect");
    expect(after).not.toContain("Disconnect");
    await closeMenu();
  });

  it("does not reopen on restore a connection whose login is no longer held, and offers Connect", async () => {
    loggedIn = false;
    await mountSidebar({ opened: [41], expandedConns: [41] });
    // Connecting would put Database Log In in front of the user for something they did not ask for.
    expect(count("GET", "/api/db/connections/41/databases")).toBe(0);
    expect(treePrefs().opened).not.toContain(41);

    const items = labels(await menuOf(row("prod")));
    expect(items).toContain("Connect");
    expect(items).not.toContain("Disconnect");
    await closeMenu();
  });
});
