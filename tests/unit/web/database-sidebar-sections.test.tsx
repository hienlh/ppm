/**
 * The Database sidebar's two sections as a user drives them, against a stubbed server: a click
 * picks, a double-click or Enter connects, the arrows walk the tree, one context menu serves every
 * row, folders are named in place, the object list follows the current database and asks before
 * switching to another, a table opens its data and shows its keys, and the line between the two
 * sections moves and is remembered.
 *
 * The decisions behind these live in pure models with their own tests
 * (`database-connection-tree`, `database-object-tree`, `database-explorer-store`); these are the
 * wiring, which only a mounted sidebar can show.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside the delete dialog and the menus, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { DatabaseSidebar } = await import("../../../src/web/components/database/database-sidebar");
const { _resetDbExplorer } = await import("../../../src/web/components/database/explorer/db-explorer-store");
const { useDbSidebarReveal } = await import("../../../src/web/components/database/db-sidebar-reveal");
const { DEFAULT_DB_EXPLORER, DEFAULT_DB_EXPLORER_VIEW } = await import("../../../src/shared/db-explorer-prefs");
type DbExplorerView = import("../../../src/shared/db-explorer-prefs").DbExplorerView;
type DbExplorerPrefs = import("../../../src/shared/db-explorer-prefs").DbExplorerPrefs;

// ─── A stub server ───────────────────────────────────────────────────────────

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown };

const ok = (data: unknown): Answer => ({ body: { ok: true, data } });
const realFetch = globalThis.fetch;
let requests: Req[] = [];
let routes = new Map<string, (req: Req) => Answer>();

function route(method: string, url: string, answer: Answer | ((req: Req) => Answer)): void {
  routes.set(`${method} ${url}`, typeof answer === "function" ? answer : () => answer);
}

type Conn = Record<string, unknown> & { id: number; name: string };
const base = { color: null, readonly: 0, sort_order: 0, created_at: "", updated_at: "", password_mode: "save" };
const appDev: Conn = { ...base, id: 1, type: "postgres", name: "app-dev", group_name: "Local", default_database: "shop", single_database: false, server: "localhost:5432", user: "app" };
const notes: Conn = { ...base, id: 2, type: "sqlite", name: "notes", group_name: null, single_database: true, server: "/data/notes.db" };
let connections: Conn[] = [];

const shopObjects = {
  schemas: ["audit", "public"],
  objects: [
    { schema: "public", name: "users", kind: "table", rowEstimate: 5231 },
    { schema: "public", name: "orders", kind: "table", rowEstimate: 0 },
    { schema: "public", name: "active_users", kind: "view" },
    { schema: "public", name: "total", kind: "function", args: "integer" },
    { schema: "audit", name: "log", kind: "table", rowEstimate: 12 },
  ],
};

const column = (name: string, type = "integer") => ({ name, type, nullable: true, defaultValue: null, comment: null, autoIncrement: false, generated: false });
const usersStructure = {
  schema: "public", name: "users", kind: "table",
  columns: [column("id"), column("team_id"), column("email", "text")],
  primaryKey: { name: "users_pkey", columns: ["id"] },
  foreignKeys: [{ name: "users_team_fk", schema: "public", table: "users", columns: ["team_id"], refSchema: "public", refTable: "teams", refColumns: ["id"], onDelete: "NO ACTION", onUpdate: "NO ACTION" }],
  references: [], indexes: [], uniques: [], checks: [], comment: null, rowKey: ["id"], rowKeyIsRowid: false,
};

beforeEach(() => {
  requests = [];
  routes = new Map();
  connections = [appDev, notes];
  _resetDbExplorer();
  useDbSidebarReveal.setState({ revealId: null, expandId: null });
  useSettingsStore.setState({ dbExplorer: DEFAULT_DB_EXPLORER, dbExplorerView: DEFAULT_DB_EXPLORER_VIEW });
  for (const t of [...useTabStore.getState().tabs]) useTabStore.getState().closeTab(t.id);

  route("GET", "/api/db/connections", () => ok(connections));
  route("GET", "/api/db/connections/1/databases", ok(["reporting", "shop"]));
  route("GET", "/api/db/connections/1/objects?database=shop", ok(shopObjects));
  route("GET", "/api/db/connections/1/objects?database=reporting", ok({ schemas: ["public"], objects: [{ schema: "public", name: "daily", kind: "table", rowEstimate: 90 }] }));
  route("GET", "/api/db/connections/1/structure?table=users&schema=public&database=shop", ok(usersStructure));
  route("GET", "/api/db/connections/2/objects", ok({ schemas: [], objects: [{ schema: null, name: "entries", kind: "table" }] }));
  for (const id of [1, 2]) route("GET", `/api/db/connections/${id}/tables`, ok([]));
  route("POST", "/api/db/connections/1/disconnect", ok({ disconnected: true }));
  route("DELETE", "/api/db/connections/1", () => {
    connections = connections.filter((c) => c.id !== 1);
    return ok({ deleted: true });
  });
  route("PUT", "/api/settings/ui-prefs", ok({}));

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(req);
    const handler = routes.get(`${req.method} ${req.url}`);
    const answer = handler ? handler(req) : { status: 599, body: { ok: false, error: `no stub for ${req.method} ${req.url}` } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  for (const t of [...useTabStore.getState().tabs]) useTabStore.getState().closeTab(t.id);
});

// ─── Driving it ──────────────────────────────────────────────────────────────

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mountSidebar(props: { onNavigate?: () => void } = {}): Promise<void> {
  view = await mount(<DatabaseSidebar {...props} />);
  await settle();
}

function setPrefs(tree: Partial<DbExplorerPrefs>, device: Partial<DbExplorerView> = {}): void {
  useSettingsStore.setState({ dbExplorer: { ...DEFAULT_DB_EXPLORER, ...tree }, dbExplorerView: { ...DEFAULT_DB_EXPLORER_VIEW, ...device } });
}

const section = (label: string) => view!.container.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
const connectionsSection = () => section("Connections");
const objectsSection = () => section("Tables, views, functions");
const treeOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[role="tree"]')!;
const items = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];

/** The row showing `name` itself — not one whose name merely contains it. */
function item(root: ParentNode, name: string): HTMLElement {
  const found = items(root).find((r) => [...r.querySelectorAll("span")].some((s) => s.textContent === name));
  if (!found) throw new Error(`no row "${name}" among: ${items(root).map((r) => r.textContent).join(" | ")}`);
  return found;
}
const hasItem = (root: ParentNode, name: string) => items(root).some((r) => [...r.querySelectorAll("span")].some((s) => s.textContent === name));
const nameSpan = (row: HTMLElement, name: string) => [...row.querySelectorAll("span")].find((s) => s.textContent === name)!;

async function press(el: Element, detail = 1): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail })); });
  await settle();
}

async function doubleClick(el: Element): Promise<void> {
  await press(el, 1);
  await press(el, 2);
}

async function key(el: Element, name: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })); });
  await settle();
}

/** A right-click on `el`; the menu it opened, if it opened one. */
async function rightClick(el: Element): Promise<{ menu: HTMLElement | null; prevented: boolean }> {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 });
  await act(async () => { el.dispatchEvent(event); });
  return { menu: document.body.querySelector<HTMLElement>('[role="menu"]'), prevented: event.defaultPrevented };
}

/** A toolbar button's dropdown, which Radix opens on a primary-button pointerdown. */
async function openDropdown(button: Element): Promise<HTMLElement> {
  await act(async () => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error("the dropdown did not open");
  return menu;
}

const menuItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')];
const menuItem = (menu: HTMLElement, label: string) => {
  const found = menuItems(menu).find((i) => i.textContent?.trim() === label);
  if (!found) throw new Error(`no "${label}" in: ${menuItems(menu).map((i) => i.textContent?.trim()).join(" | ")}`);
  return found;
};

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

/** Whether a query found anything — asserted as a boolean, since a failing diff of a happy-dom element prints for minutes. */
const present = (el: Element | null | undefined) => el != null;

const count = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url).length;
const deviceView = () => useSettingsStore.getState().dbExplorerView;
const treePrefs = () => useSettingsStore.getState().dbExplorer;

/** The current database is shop on app-dev, open and listed. */
async function mountOnShop(props: { onNavigate?: () => void } = {}): Promise<void> {
  setPrefs({ opened: [1], expandedConns: [1] }, { current: { conn: 1, database: "shop" } });
  await mountSidebar(props);
}

// ─── Connections ─────────────────────────────────────────────────────────────

describe("the Connections section", () => {
  it("connects a server on a double-click, and a click on one of its databases makes it current", async () => {
    await mountSidebar();
    const conns = connectionsSection();
    expect(hasItem(conns, "reporting")).toBe(false);

    await doubleClick(item(conns, "app-dev"));
    expect(count("GET", "/api/db/connections/1/databases")).toBe(1);
    expect(treePrefs().expandedConns).toContain(1);
    expect(present(item(conns, "app-dev").querySelector('[aria-label="Connected"]'))).toBe(true);
    // A server itself is no database: the lower section says to pick one.
    expect(objectsSection().textContent).toContain("app-dev is a server: pick one of its databases above.");

    await press(item(conns, "reporting"));
    expect(deviceView().current).toEqual({ conn: 1, database: "reporting" });
    expect(nameSpan(item(conns, "reporting"), "reporting").className).toContain("font-bold");
    expect(nameSpan(item(conns, "shop"), "shop").className).not.toContain("font-bold");
    expect(hasItem(objectsSection(), "daily")).toBe(true);
    expect(objectsSection().querySelector("section > button")?.textContent).toContain("reporting");
  });

  it("walks the rows with the arrows, connects on Enter, and opens a row's menu from the keyboard", async () => {
    await mountSidebar();
    const tree = treeOf(connectionsSection());
    const cursorText = () => document.getElementById(tree.getAttribute("aria-activedescendant") ?? "")?.textContent ?? null;

    await key(tree, "ArrowDown");
    expect(cursorText()).toContain("Local");
    await key(tree, "ArrowDown");
    expect(cursorText()).toContain("app-dev");

    await key(tree, "Enter");
    expect(count("GET", "/api/db/connections/1/databases")).toBe(1);
    await key(tree, "ArrowRight");
    expect(cursorText()).toBe("reporting");
    await key(tree, "ArrowLeft");
    expect(cursorText()).toContain("app-dev");
    await key(tree, "ArrowLeft");
    expect(treePrefs().expandedConns).not.toContain(1);
    expect(hasItem(connectionsSection(), "reporting")).toBe(false);

    await key(tree, "F10", { shiftKey: true });
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(present(menu)).toBe(true);
    expect(menuItem(menu!, "Disconnect")).toBeDefined();
  });

  it("offers DBGate's connection menu, and deletes only once told the database stays untouched", async () => {
    await mountSidebar();
    const { menu } = await rightClick(item(connectionsSection(), "app-dev"));
    expect(menuItems(menu!).map((i) => i.textContent?.trim())).toEqual([
      "Connect", "New query", "Refresh", "Edit connection…", "Duplicate", "Read-only", "Delete",
    ]);
    // Refresh reads the connection again, so there is nothing to refresh until it is open.
    expect(menuItem(menu!, "Refresh").getAttribute("aria-disabled")).toBe("true");

    await click(menuItem(menu!, "Delete"));
    await settle();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Delete app-dev?");
    expect(dialog.textContent).toContain("The database itself is not touched");
    expect(count("DELETE", "/api/db/connections/1")).toBe(0);

    await click(button(dialog, "Delete connection"));
    await settle();
    expect(count("DELETE", "/api/db/connections/1")).toBe(1);
    expect(hasItem(connectionsSection(), "app-dev")).toBe(false);
  });

  it("opens no menu on a row that has none", async () => {
    await mountSidebar();
    const divider = connectionsSection().querySelector<HTMLElement>('[role="tree"] > [role="none"]')!;
    const { menu, prevented } = await rightClick(divider);
    expect(present(menu)).toBe(false);
    // Not even an empty one: a menu left open with nothing in it would show the next row's
    // entries without being asked. The browser's own menu stays away too.
    expect(treeOf(connectionsSection()).getAttribute("data-state")).toBe("closed");
    expect(prevented).toBe(true);
  });

  it("names a new folder where it will be: Enter keeps it, Escape does not", async () => {
    await mountSidebar();
    await click(button(connectionsSection(), "Add new connection folder"));
    let input = connectionsSection().querySelector<HTMLInputElement>('input[aria-label="New folder name"]')!;
    expect(document.activeElement === input).toBe(true);
    input.value = "Archive";
    await key(input, "Enter");
    expect(treePrefs().emptyFolders).toEqual(["Archive"]);
    expect(hasItem(connectionsSection(), "Archive")).toBe(true);

    await click(button(connectionsSection(), "Add new connection folder"));
    input = connectionsSection().querySelector<HTMLInputElement>('input[aria-label="New folder name"]')!;
    input.value = "Scratch";
    await key(input, "Escape");
    expect(treePrefs().emptyFolders).toEqual(["Archive"]);
    expect(present(connectionsSection().querySelector('input[aria-label="New folder name"]'))).toBe(false);
  });

  it("filters by the search, marks what matched, and says when nothing did", async () => {
    await mountSidebar();
    const search = connectionsSection().querySelector<HTMLInputElement>('input[aria-label="Search connection or database"]')!;
    await typeInto(search, "dev");
    expect(hasItem(connectionsSection(), "notes")).toBe(false);
    expect(item(connectionsSection(), "app-dev").querySelector("mark")?.textContent).toBe("dev");

    await typeInto(search, "nothing-like-it");
    expect(connectionsSection().textContent).toContain("No connection matches “nothing-like-it”.");
    await click(button(connectionsSection(), "Clear search"));
    expect(search.value).toBe("");
    expect(hasItem(connectionsSection(), "notes")).toBe(true);
  });

  it("opens the connection tab from Add new connection and from Edit connection…, and gets the drawer out of the way", async () => {
    let navigated = 0;
    await mountSidebar({ onNavigate: () => { navigated++; } });
    await click(button(connectionsSection(), "Add new connection"));
    const { menu } = await rightClick(item(connectionsSection(), "app-dev"));
    await click(menuItem(menu!, "Edit connection…"));
    const tabs = useTabStore.getState().tabs.filter((t) => t.type === "db-connection");
    expect(tabs.map((t) => t.title)).toEqual(["New connection", "Edit app-dev"]);
    expect(tabs[1]!.metadata).toMatchObject({ connectionId: 1, connectionName: "app-dev", dbType: "postgres" });
    expect(navigated).toBe(2);
  });
});

describe("on a phone", () => {
  const realWidth = window.innerWidth;
  beforeEach(() => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true }));
  afterEach(() => Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true }));

  async function touch(el: Element, type: "touchstart" | "touchmove" | "touchend"): Promise<void> {
    await act(async () => { el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true })); });
  }
  const sheetShows = (label: string) => [...document.body.querySelectorAll("button")].some((b) => b.textContent?.trim() === label);

  it("shares the drawer at the default split, whatever a wider screen left behind", async () => {
    setPrefs({}, { split: 0.8 });
    await mountSidebar();
    // No line to drag here, so a share set elsewhere could never be moved back.
    expect(connectionsSection().style.flexBasis).toBe("42%");
  });

  it("opens a row's menu as a sheet on a long press, and not when the finger moved", async () => {
    await mountSidebar();
    const row = item(connectionsSection(), "app-dev");
    await touch(row, "touchstart");
    await touch(row, "touchmove");
    await act(async () => { await Bun.sleep(450); });
    expect(sheetShows("Edit connection…")).toBe(false);
    await touch(row, "touchend");

    await touch(row, "touchstart");
    await act(async () => { await Bun.sleep(450); });
    expect(sheetShows("Edit connection…")).toBe(true);
  });

  it("opens nothing on a long press of a row without a menu", async () => {
    await mountSidebar();
    const divider = connectionsSection().querySelector<HTMLElement>('[role="tree"] > [role="none"]')!;
    await touch(divider, "touchstart");
    await act(async () => { await Bun.sleep(450); });
    // Nothing showing now — and nothing left armed to show the next tap's menu without a press.
    await act(async () => { item(connectionsSection(), "app-dev").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); });
    expect(sheetShows("Edit connection…")).toBe(false);
  });
});

// ─── Tables, views, functions ────────────────────────────────────────────────

describe("the Tables, views, functions section", () => {
  it("lists the current database's objects by kind, with Postgres's schema choice", async () => {
    await mountOnShop();
    const objects = objectsSection();
    expect(items(objects).map((r) => r.textContent)).toEqual([
      "Tables2", "orders0", "users~5.2k", "Views1", "Functions1",
    ]);
    const schema = objects.querySelector<HTMLSelectElement>("select")!;
    expect([...schema.options].map((o) => o.textContent)).toEqual(["audit (1)", "public (4)"]);
    expect(schema.value).toBe("public");

    await act(async () => {
      schema.value = "audit";
      schema.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(deviceView().schemas).toEqual({ "1/shop": "audit" });
    expect(items(objectsSection()).map((r) => r.textContent)).toEqual(["Tables1", "log12"]);
  });

  it("says a table's row count is the engine's estimate", async () => {
    await mountOnShop();
    const tail = [...item(objectsSection(), "users").querySelectorAll("span")].find((s) => s.textContent === "~5.2k")!;
    expect(tail.getAttribute("title")).toBe("Estimated row count");
  });

  it("opens a table's data on a click, and gets the drawer out of the way", async () => {
    let navigated = 0;
    await mountOnShop({ onNavigate: () => { navigated++; } });
    await press(item(objectsSection(), "users"));
    const tab = useTabStore.getState().tabs.find((t) => t.type === "database")!;
    expect(tab.title).toBe("app-dev · users");
    expect(tab.metadata).toMatchObject({ connectionId: 1, tableName: "users", schemaName: "public" });
    // shop is the connection's own database, so the tab does not record one.
    expect(tab.metadata?.database).toBeUndefined();
    expect(navigated).toBe(1);
  });

  it("shows a table's columns once expanded, read from the structure with its keys", async () => {
    await mountOnShop();
    const users = item(objectsSection(), "users");
    await press(users.querySelector('[aria-hidden="true"]')!);
    expect(treePrefs().expandedObjects).toEqual(["1/shop|public.users"]);
    expect(count("GET", "/api/db/connections/1/structure?table=users&schema=public&database=shop")).toBe(1);
    // The table's data is not opened by the expander.
    expect(useTabStore.getState().tabs.filter((t) => t.type === "database")).toHaveLength(0);

    const id = item(objectsSection(), "id");
    expect(present(id.querySelector('[aria-label="Primary key"]'))).toBe(true);
    const team = item(objectsSection(), "team_id");
    expect(present(team.querySelector('[aria-label="Foreign key"]'))).toBe(true);
    expect(team.getAttribute("title")).toBe("→ teams.id");
    expect(item(objectsSection(), "email").textContent).toBe("emailtext");
  });

  it("asks before switching when the tree picks another database than the active tab's", async () => {
    await mountOnShop();
    await press(item(objectsSection(), "users"));
    const shopTab = useTabStore.getState().activeTabId!;

    await press(item(connectionsSection(), "reporting"));
    // The list stays with the tab's database and asks.
    expect(deviceView().current).toEqual({ conn: 1, database: "shop" });
    const prompt = objectsSection().querySelector<HTMLElement>('[role="region"][aria-label="Current database"]')!;
    expect(prompt.textContent).toContain("Current database");
    expect(prompt.textContent).toContain("shop");
    expect(button(prompt, "Switch to reporting")).toBeDefined();

    await click(button(prompt, "Switch to reporting"));
    await settle();
    expect(deviceView().current).toEqual({ conn: 1, database: "reporting" });
    // A table of reporting opened: its tab is the active one now.
    await press(item(objectsSection(), "daily"));
    expect(useTabStore.getState().activeTabId).not.toBe(shopTab);

    // Back on the tab of shop, the list follows it, and the tree's pick is asked about again.
    await act(async () => { useTabStore.getState().setActiveTab(shopTab); });
    await settle();
    expect(deviceView().current).toEqual({ conn: 1, database: "shop" });
    const again = objectsSection().querySelector<HTMLElement>('[role="region"][aria-label="Current database"]')!;
    expect(button(again, "Switch to reporting")).toBeDefined();
    await click(button(again, "Show shop"));
    expect(present(objectsSection().querySelector('[role="region"][aria-label="Current database"]'))).toBe(false);
    expect(hasItem(objectsSection(), "users")).toBe(true);
  });

  it("drops + while searching, marks the match, and says when nothing matched", async () => {
    await mountOnShop();
    const search = objectsSection().querySelector<HTMLInputElement>('input[aria-label="Search in tables, views, procedures"]')!;
    expect(present(objectsSection().querySelector('button[aria-label="New object"]'))).toBe(true);

    await typeInto(search, "act");
    expect(present(objectsSection().querySelector('button[aria-label="New object"]'))).toBe(false);
    // A search opens every group with a match, closed or not.
    expect(items(objectsSection()).map((r) => r.textContent)).toEqual(["Views1", "active_users"]);
    expect(item(objectsSection(), "active_users").querySelector("mark")?.textContent).toBe("act");

    await typeInto(search, "zzz");
    expect(objectsSection().textContent).toContain("No table, view or routine matches “zzz”.");
  });

  it("offers a table's menu, whose New query opens a query tab holding a SELECT", async () => {
    let navigated = 0;
    await mountOnShop({ onNavigate: () => { navigated++; } });
    const { menu } = await rightClick(item(objectsSection(), "users"));
    expect(menuItems(menu!).map((i) => i.textContent?.trim())).toEqual([
      "Open data", "Open structure", "Show CREATE SQL", "New query",
      "Drop table", "Rename table", "Truncate table", "Create table backup",
      "Export advanced...", "Import",
      "Copy name", "Refresh structure",
    ]);

    await click(menuItem(menu!, "New query"));
    const tab = useTabStore.getState().tabs.find((t) => t.type === "db-query")!;
    expect(tab.title).toBe("Query 1");
    expect(tab.metadata).toMatchObject({ connectionId: 1, currentSql: 'SELECT * FROM "public"."users" LIMIT 100' });
    expect(navigated).toBe(1);
  });

  it("offers the + menu's templates for the engine, and ⋮'s refresh", async () => {
    await mountOnShop();
    const plus = await openDropdown(button(objectsSection(), "New object"));
    expect(menuItems(plus).map((i) => i.textContent?.trim())).toEqual([
      "New table", "New query", "CREATE VIEW template", "CREATE FUNCTION template", "CREATE TRIGGER template",
    ]);
    await act(async () => { plus.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();

    const before = count("GET", "/api/db/connections/1/objects?database=shop");
    const more = await openDropdown(button(objectsSection(), "More"));
    await click(menuItem(more, "Refresh structure"));
    await settle();
    expect(count("GET", "/api/db/connections/1/objects?database=shop")).toBe(before + 1);
  });

  it("says no database is selected before one is", async () => {
    await mountSidebar();
    expect(objectsSection().textContent).toContain("No database selected. Click a database under Connections to list its tables.");
  });
});

// ─── The line between them ───────────────────────────────────────────────────

describe("the split", () => {
  const separator = () => view!.container.querySelector<HTMLElement>('[role="separator"]');

  it("moves with the arrow keys, Home and End, and is kept on this device", async () => {
    await mountSidebar();
    expect(separator()!.getAttribute("aria-valuenow")).toBe("42");
    await key(separator()!, "ArrowDown");
    expect(deviceView().split).toBe(0.47);
    expect(separator()!.getAttribute("aria-valuenow")).toBe("47");
    await key(separator()!, "ArrowUp");
    await key(separator()!, "ArrowUp");
    expect(deviceView().split).toBe(0.37);
    await key(separator()!, "End");
    expect(deviceView().split).toBe(0.85);
    await key(separator()!, "Home");
    expect(deviceView().split).toBe(0.15);
  });

  it("follows a drag and saves the share once the drag ends", async () => {
    await mountSidebar();
    const line = separator()!;
    const body = line.parentElement!;
    body.getBoundingClientRect = () => ({ top: 100, height: 400, bottom: 500, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    const pointer = (type: string, clientY: number) => new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientY, pointerId: 1 });

    await act(async () => { line.dispatchEvent(pointer("pointerdown", 268)); });
    await act(async () => { line.dispatchEvent(pointer("pointermove", 300)); });
    expect(line.getAttribute("aria-valuenow")).toBe("50");
    expect(deviceView().split).toBe(0.42);
    await act(async () => { line.dispatchEvent(pointer("pointermove", 10)); });
    expect(line.getAttribute("aria-valuenow")).toBe("15");
    await act(async () => { line.dispatchEvent(pointer("pointerup", 10)); });
    expect(deviceView().split).toBe(0.15);
  });

  it("goes away while a section is folded, and comes back with it", async () => {
    await mountSidebar();
    await click(objectsSection().querySelector("section > button")!);
    expect(deviceView().objectsCollapsed).toBe(true);
    expect(present(separator())).toBe(false);
    expect(present(objectsSection().querySelector('[role="tree"]'))).toBe(false);

    await click(objectsSection().querySelector("section > button")!);
    expect(present(separator())).toBe(true);
  });
});
