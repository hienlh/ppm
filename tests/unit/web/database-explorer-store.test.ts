/**
 * The Database sidebar's state, driven against a stubbed server: opening a server or a single
 * database, what a failure, a missing driver or a closed Database Log In leaves on the row, the
 * current database against the focused one and the active tab, a reload restoring the tree, a
 * connection saved from its tab, and folders.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const store = await import("../../../src/web/components/database/explorer/db-explorer-store");
const { useDbExplorer } = store;
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { useDbSidebarReveal } = await import("../../../src/web/components/database/db-sidebar-reveal");
const { DEFAULT_DB_EXPLORER, DEFAULT_DB_EXPLORER_VIEW } = await import("../../../src/shared/db-explorer-prefs");

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown };
type Handler = (req: Req) => Answer | Promise<Answer>;

const ok = (data: unknown): Answer => ({ body: { ok: true, data } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Answer => ({ status, body: { ok: false, error, ...extra } });

const realFetch = globalThis.fetch;
let requests: Req[] = [];
let routes = new Map<string, Handler>();

function route(method: string, url: string, answer: Answer | Handler): void {
  routes.set(`${method} ${url}`, typeof answer === "function" ? answer : () => answer);
}

/** An answer held back until the test lets it go. */
function held(): { handler: Handler; release: (a: Answer) => void } {
  let release!: (a: Answer) => void;
  const promise = new Promise<Answer>((r) => { release = r; });
  return { handler: () => promise, release };
}

type Conn = Record<string, unknown> & { id: number };
const appDev: Conn = { id: 1, type: "postgres", name: "app-dev", group_name: "Local", color: null, readonly: 0, default_database: "shop", single_database: false, password_mode: "save" };
const notes: Conn = { id: 2, type: "sqlite", name: "notes", group_name: null, color: null, readonly: 0, single_database: true, server: "/data/notes.db", password_mode: "save" };
const locked: Conn = { id: 3, type: "postgres", name: "locked", group_name: null, color: null, readonly: 0, default_database: "prod", single_database: false, password_mode: "askPassword", logged_in: false };
const bare: Conn = { id: 5, type: "postgres", name: "bare", group_name: null, color: null, readonly: 0, default_database: null, single_database: false, password_mode: "save" };
let connections: Conn[] = [];

const objects = (names: string[]) => ({ schemas: ["public"], objects: names.map((name) => ({ schema: "public", name, kind: "table" })) });

beforeEach(() => {
  requests = [];
  routes = new Map();
  connections = [appDev, notes, locked, bare];
  store._resetDbExplorer();
  useDbSidebarReveal.setState({ revealId: null, expandId: null });
  useSettingsStore.setState({ dbExplorer: DEFAULT_DB_EXPLORER, dbExplorerView: DEFAULT_DB_EXPLORER_VIEW });
  for (const t of [...useTabStore.getState().tabs]) useTabStore.getState().closeTab(t.id);

  route("GET", "/api/db/connections", () => ok(connections));
  route("GET", "/api/db/connections/1/databases", ok(["reporting", "shop"]));
  route("GET", "/api/db/connections/1/objects?database=shop", ok(objects(["users", "orders"])));
  route("GET", "/api/db/connections/1/objects?database=reporting", ok(objects(["daily"])));
  route("GET", "/api/db/connections/2/objects", ok({ schemas: [], objects: [{ schema: null, name: "notes", kind: "table" }] }));
  route("GET", "/api/db/connections/5/databases", ok(["postgres", "scratch"]));
  for (const id of [1, 2, 3, 5]) route("GET", `/api/db/connections/${id}/tables`, ok([]));
  for (const id of [1, 2, 3, 5]) route("POST", `/api/db/connections/${id}/disconnect`, ok({ disconnected: true }));
  route("PUT", "/api/settings/ui-prefs", ok({}));

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(req);
    const handler = routes.get(`${req.method} ${req.url}`);
    const answer = handler ? await handler(req) : { status: 599, body: { ok: false, error: `no stub for ${req.method} ${req.url}` } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const t of [...useTabStore.getState().tabs]) useTabStore.getState().closeTab(t.id);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

const count = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url).length;
const tree = () => useSettingsStore.getState().dbExplorer;
const view = () => useSettingsStore.getState().dbExplorerView;
const s = () => useDbExplorer.getState();

function openTableTab(metadata: Record<string, unknown>): string {
  return useTabStore.getState().openTab({ type: "database", title: "t", projectId: null, closable: true, metadata });
}

describe("opening a connection", () => {
  it("reads a server's databases, marks it open and remembers it, and refreshes the palette's tables", async () => {
    await store.loadConnections();
    const opening = store.connectConnection(1, { expand: true });
    expect(s().status[1]).toEqual({ state: "connecting" });
    expect(await opening).toBe(true);
    expect(s().status[1]).toEqual({ state: "open" });
    expect(s().databases[1]).toEqual({ state: "ready", data: ["reporting", "shop"] });
    expect(tree().opened).toEqual([1]);
    expect(tree().expandedConns).toEqual([1]);
    await settle();
    expect(count("GET", "/api/db/connections/1/tables")).toBe(1);
  });

  it("opens a single database by reading its objects, with no ?database=", async () => {
    await store.loadConnections();
    expect(await store.connectConnection(2)).toBe(true);
    expect(s().objects["2/"]).toMatchObject({ state: "ready" });
    expect(count("GET", "/api/db/connections/2/objects")).toBe(1);
    expect(s().databases[2]).toBeUndefined();
  });

  it("leaves the error on the row, with the driver to offer when that is why", async () => {
    route("GET", "/api/db/connections/1/databases", fail(500, "connection refused"));
    route("GET", "/api/db/connections/2/objects", fail(424, "The SQLite driver is not installed", {
      code: "DB_DRIVER_MISSING", driver: { id: "sqlite-x", displayName: "SQLite X" },
    }));
    await store.loadConnections();
    expect(await store.connectConnection(1)).toBe(false);
    expect(s().status[1]).toEqual({ state: "error", message: "connection refused", driver: null });
    expect(await store.connectConnection(2)).toBe(false);
    expect(s().status[2]).toMatchObject({ state: "error", driver: { id: "sqlite-x", displayName: "SQLite X" } });
    // A failed connection still counts as opened, so a reload shows the same error again.
    expect(tree().opened).toEqual([1, 2]);
  });

  it("puts the row back as it was when Database Log In is closed", async () => {
    route("GET", "/api/db/connections/3/databases", fail(428, "Log in to locked", { code: "DB_LOGIN_REQUIRED" }));
    await store.loadConnections();
    expect(await store.connectConnection(3)).toBe(false);
    expect(s().status[3]).toBeUndefined();
    expect(s().databases[3]).toBeUndefined();
    expect(tree().opened).toEqual([]);
  });

  it("drops an answer that arrives after the connection was closed", async () => {
    const answer = held();
    route("GET", "/api/db/connections/1/databases", answer.handler);
    await store.loadConnections();
    const opening = store.connectConnection(1);
    await settle();
    await store.disconnectConnection(1);
    answer.release(ok(["late"]));
    expect(await opening).toBe(false);
    expect(s().status[1]).toBeUndefined();
    expect(s().databases[1]).toBeUndefined();
    expect(tree().opened).toEqual([]);
    expect(count("POST", "/api/db/connections/1/disconnect")).toBe(1);
  });

  it("forgets everything read of a connection on Disconnect, the current database included", async () => {
    await store.loadConnections();
    await store.setCurrentDatabase({ conn: 1, database: "shop" });
    expect(s().objects["1/shop"]).toMatchObject({ state: "ready" });
    await store.disconnectConnection(1);
    expect(s().status[1]).toBeUndefined();
    expect(s().objects["1/shop"]).toBeUndefined();
    expect(view().current).toBeNull();
    expect(tree().opened).toEqual([]);
  });

  it("reconnects keeping the login PPM holds, and reads the current database again", async () => {
    await store.loadConnections();
    await store.setCurrentDatabase({ conn: 1, database: "shop" });
    await store.reconnectConnection(1);
    await settle();
    expect(requests.find((r) => r.url === "/api/db/connections/1/disconnect")?.body).toEqual({ keepLogin: true });
    expect(count("GET", "/api/db/connections/1/databases")).toBe(2);
    expect(count("GET", "/api/db/connections/1/objects?database=shop")).toBe(2);
    expect(s().status[1]).toEqual({ state: "open" });
  });
});

describe("the current database against the focused one", () => {
  it("makes a clicked database current when no tab says otherwise", async () => {
    await store.loadConnections();
    store.pickDatabase({ conn: 1, database: "reporting" });
    await settle();
    expect(view().current).toEqual({ conn: 1, database: "reporting" });
    expect(s().focused).toEqual({ conn: 1, database: "reporting" });
    expect(s().objects["1/reporting"]).toEqual({ state: "ready", data: objects(["daily"]) });
  });

  it("only focuses a database while the active tab belongs to another, as DBGate asks first", async () => {
    await store.loadConnections();
    openTableTab({ connectionId: 1, tableName: "users", schemaName: "public" });
    store.followActiveTab();
    await settle();
    expect(view().current).toEqual({ conn: 1, database: "shop" });

    store.pickDatabase({ conn: 1, database: "reporting" });
    await settle();
    expect(view().current).toEqual({ conn: 1, database: "shop" });
    expect(s().focused).toEqual({ conn: 1, database: "reporting" });
    expect(count("GET", "/api/db/connections/1/objects?database=reporting")).toBe(0);

    // "Show shop" puts the pick back; Switch makes the focused one current.
    store.showCurrentDatabase();
    expect(s().focused).toEqual({ conn: 1, database: "shop" });
    await store.setCurrentDatabase({ conn: 1, database: "reporting" });
    expect(view().current).toEqual({ conn: 1, database: "reporting" });
  });

  it("follows a change of tab, and only a change: a database switched to by hand stays", async () => {
    await store.loadConnections();
    const users = openTableTab({ connectionId: 1, tableName: "users", schemaName: "public" });
    store.followActiveTab();
    await settle();
    expect(view().current).toEqual({ conn: 1, database: "shop" });

    await store.setCurrentDatabase({ conn: 2, database: null });
    store.followActiveTab();
    await settle();
    expect(view().current).toEqual({ conn: 2, database: null });

    openTableTab({ connectionId: 1, database: "reporting", tableName: "daily", schemaName: "public" });
    store.followActiveTab();
    await settle();
    expect(view().current).toEqual({ conn: 1, database: "reporting" });
    // The pick is not the tab's to move.
    expect(s().focused).toEqual({ conn: 2, database: null });

    useTabStore.getState().setActiveTab(users);
    store.followActiveTab();
    await settle();
    expect(view().current).toEqual({ conn: 1, database: "shop" });
  });

  it("puts back the previous current database when Database Log In is closed on the way", async () => {
    route("GET", "/api/db/connections/3/databases", fail(428, "Log in to locked", { code: "DB_LOGIN_REQUIRED" }));
    await store.loadConnections();
    await store.setCurrentDatabase({ conn: 1, database: "shop" });
    await store.setCurrentDatabase({ conn: 3, database: "prod" });
    expect(view().current).toEqual({ conn: 1, database: "shop" });
  });
});

describe("after a reload", () => {
  it("opens again what was open, but not a connection that would ask for its password", async () => {
    useSettingsStore.getState().setDbExplorer({ ...DEFAULT_DB_EXPLORER, opened: [1, 3], expandedConns: [1] });
    useSettingsStore.getState().setDbExplorerView({ ...DEFAULT_DB_EXPLORER_VIEW, current: { conn: 1, database: "reporting" } });
    await store.startExplorer();
    await settle();
    expect(s().status[1]).toEqual({ state: "open" });
    expect(s().status[3]).toBeUndefined();
    expect(count("GET", "/api/db/connections/3/databases")).toBe(0);
    expect(tree().opened).toEqual([1]);
    expect(s().objects["1/reporting"]).toMatchObject({ state: "ready" });
    // Restoring is not a choice made in the tree: nothing is focused.
    expect(s().focused).toBeNull();
  });

  it("forgets a connection that is gone and closes one whose login the server dropped", async () => {
    await store.loadConnections();
    await store.connectConnection(1);
    await store.connectConnection(2);
    useSettingsStore.getState().setDbExplorer({ ...tree(), emptyFolders: ["Local", "Later"] });
    store.focusRow({ conn: 2, database: null });

    connections = [{ ...appDev, password_mode: "askPassword", logged_in: false }, locked, bare];
    await store.loadConnections();
    expect(s().status[2]).toBeUndefined();
    expect(s().objects["2/"]).toBeUndefined();
    expect(s().status[1]).toBeUndefined();
    expect(tree().opened).toEqual([]);
    expect(s().focused).toBeNull();
    // "Local" holds a connection now, so it needs no empty-folder entry.
    expect(tree().emptyFolders).toEqual(["Later"]);
  });
});

describe("a connection saved from its tab", () => {
  it("with Connect: a single database becomes current", async () => {
    useDbSidebarReveal.setState({ expandId: 2 });
    await store.onConnectionsChanged({ connectionId: 2, refreshTables: true });
    await settle();
    expect(view().current).toEqual({ conn: 2, database: null });
    expect(useDbSidebarReveal.getState().expandId).toBeNull();
  });

  it("with Connect: a server's default database becomes current, its list open", async () => {
    useDbSidebarReveal.setState({ expandId: 1 });
    await store.onConnectionsChanged({ connectionId: 1, refreshTables: true });
    await settle();
    expect(view().current).toEqual({ conn: 1, database: "shop" });
    expect(tree().expandedConns).toEqual([1]);
  });

  it("with Connect: a server naming no database opens its list, nothing made current", async () => {
    useDbSidebarReveal.setState({ expandId: 5 });
    await store.onConnectionsChanged({ connectionId: 5, refreshTables: true });
    await settle();
    expect(view().current).toBeNull();
    expect(s().focused).toEqual({ conn: 5, database: null });
    expect(tree().expandedConns).toEqual([5]);
    expect(s().databases[5]).toEqual({ state: "ready", data: ["postgres", "scratch"] });
  });

  it("with Connect while the sidebar was not showing: opened once it mounts", async () => {
    useDbSidebarReveal.setState({ expandId: 2 });
    await store.startExplorer();
    await settle();
    expect(view().current).toEqual({ conn: 2, database: null });
  });

  it("with Save: an open connection is read again, a closed one only refreshes the palette's tables", async () => {
    await store.loadConnections();
    await store.connectConnection(1);
    await store.onConnectionsChanged({ connectionId: 1, refreshTables: true });
    await settle();
    expect(count("GET", "/api/db/connections/1/databases")).toBe(2);

    await store.onConnectionsChanged({ connectionId: 5, refreshTables: true });
    await settle();
    expect(count("GET", "/api/db/connections/5/databases")).toBe(0);
    expect(count("GET", "/api/db/connections/5/tables")).toBe(1);
  });
});

describe("a driver installed from the notice", () => {
  it("opens again every connection that waited for it", async () => {
    route("GET", "/api/db/connections/2/objects", fail(424, "missing", { code: "DB_DRIVER_MISSING", driver: { id: "d1", displayName: "D1" } }));
    await store.loadConnections();
    await store.connectConnection(2);
    route("GET", "/api/db/connections/2/objects", ok({ schemas: [], objects: [] }));
    store.retryAfterDriverInstall("d1");
    await settle();
    expect(s().status[2]).toEqual({ state: "open" });
  });
});

describe("folders", () => {
  it("adds an empty folder, refusing a blank or taken name", async () => {
    await store.loadConnections();
    expect(store.createFolder("  ")).toBe(false);
    expect(store.createFolder("Local")).toBe(false);
    expect(store.createFolder(" Later ")).toBe(true);
    expect(tree().emptyFolders).toEqual(["Later"]);
  });

  it("renames by moving the connections on the server, and keeps a closed folder closed", async () => {
    route("POST", "/api/db/connections/folder", ok({ moved: 1 }));
    await store.loadConnections();
    store.toggleFolder("Local");
    expect(await store.renameFolder("Local", "Home")).toBe(true);
    expect(requests.find((r) => r.url === "/api/db/connections/folder")?.body).toEqual({ from: "Local", to: "Home" });
    expect(tree().collapsedFolders).toEqual(["Home"]);
    // An empty folder lives in the browser only.
    store.createFolder("Later");
    expect(await store.renameFolder("Later", "Soon")).toBe(true);
    expect(count("POST", "/api/db/connections/folder")).toBe(1);
    expect(tree().emptyFolders).toEqual(["Soon"]);
  });

  it("deletes a folder by moving its connections out of it", async () => {
    route("POST", "/api/db/connections/folder", ok({ moved: 1 }));
    await store.loadConnections();
    await store.deleteFolder("Local");
    expect(requests.find((r) => r.url === "/api/db/connections/folder")?.body).toEqual({ from: "Local", to: null });
  });
});
