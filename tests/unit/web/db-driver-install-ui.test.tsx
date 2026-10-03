/**
 * The Install button a missing database driver gets, wherever it surfaces.
 *
 * A connection whose driver is not installed answers `424 DB_DRIVER_MISSING` naming the driver.
 * These mount the pieces that turn that answer into an offer — the notice itself, the Settings
 * pane, the connection form's Test, the sidebar and the viewer's data hook — against a stub
 * server, and read what reaches it: pressing Install must send exactly one install request for
 * the named driver, and whatever needed the driver must run again once it is in, whichever
 * button installed it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { ApiError } = await import("../../../src/web/lib/api-client");
const { DB_DRIVER_INSTALLED_EVENT, installDbDriver, missingDbDriverOf } = await import("../../../src/web/lib/db-drivers");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { DriverMissingNotice } = await import("../../../src/web/components/database/driver-missing-notice");
const { DatabaseDriversSection } = await import("../../../src/web/components/settings/database-drivers-section");
const { ConnectionFormTab } = await import("../../../src/web/components/database/connection-form/connection-form-tab");
const { DatabaseSidebar } = await import("../../../src/web/components/database/database-sidebar");
const { _resetDbExplorer } = await import("../../../src/web/components/database/explorer/db-explorer-store");
const { DEFAULT_DB_EXPLORER, DEFAULT_DB_EXPLORER_VIEW } = await import("../../../src/shared/db-explorer-prefs");
const { useDatabase } = await import("../../../src/web/components/database/use-database");
const { useQueryRunner } = await import("../../../src/web/components/database/query/use-query-runner");
type DbDriverStatus = import("../../../src/shared/db-drivers").DbDriverStatus;
type Connection = import("../../../src/web/components/database/use-connections").Connection;

const DRIVER = { id: "mysql", displayName: "MySQL / MariaDB" };
const MISSING_BODY = {
  ok: false,
  error: "The MySQL / MariaDB driver is not installed. Install it in Settings → Database Drivers, or run: ppm db driver install mysql",
  code: "DB_DRIVER_MISSING",
  driver: DRIVER,
};

function status(state: DbDriverStatus["state"], extra: Partial<DbDriverStatus> = {}): DbDriverStatus {
  return {
    id: "mysql", displayName: "MySQL / MariaDB", engines: ["mysql", "mariadb"], usedFor: "MySQL and MariaDB connections",
    package: "mysql2", version: "3.24.4", license: "MIT", homepage: "https://sidorares.github.io/node-mysql2/docs",
    state,
    installed: state === "missing" ? null : { version: state === "outdated" ? "3.20.0" : "3.24.4", installedAt: "2026-09-29T00:00:00.000Z", bytes: 421_888, sha256: "a".repeat(64) },
    installing: false, removing: false,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// A stub server: every request is recorded, and answered by the first route matching it.

/** `ndjson`: `body` is a list of events, sent one JSON per line — `/query/script`'s stream. */
interface Answer { status?: number; body: unknown; ndjson?: boolean }
type Route = (req: { method: string; url: string; body: unknown }) => Answer | undefined;

const realFetch = globalThis.fetch;
let requests: Array<{ method: string; url: string; body: unknown }> = [];
let routes: Route[] = [];

function serve(...next: Route[]): void {
  routes = next;
}

/** One route: `method` and a URL prefix, answering `answer` (a function to vary it per call). */
function on(method: string, prefix: string, answer: Answer | ((body: unknown) => Answer)): Route {
  return (req) => (req.method === method && req.url.startsWith(prefix)
    ? (typeof answer === "function" ? answer(req.body) : answer)
    : undefined);
}

const ok = (data: unknown): Answer => ({ body: { ok: true, data } });

/** `/query/script`'s stream for one statement — the SQL sent — reading `rows` of one column `x`. */
const script = (body: unknown, rows: unknown[][]): Answer => ({
  ndjson: true,
  body: [
    { type: "start", statements: [{ startLine: 1, endLine: 1 }] },
    { type: "running", index: 0 },
    {
      type: "statement",
      result: { index: 0, startLine: 1, endLine: 1, sql: (body as { sql: string }).sql, resultSets: [{ columns: [{ name: "x", type: "int" }], rows }], durationMs: 1 },
    },
    { type: "done", durationMs: 1 },
  ],
});

beforeEach(() => {
  requests = [];
  routes = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });
    for (const route of routes) {
      const answer = route({ method, url, body });
      if (answer?.ndjson) {
        const lines = (answer.body as unknown[]).map((e) => `${JSON.stringify(e)}\n`).join("");
        return new Response(lines, { status: answer.status ?? 200, headers: { "Content-Type": "application/x-ndjson" } });
      }
      if (answer) {
        return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ ok: false, error: `no stub for ${method} ${url}` }), { status: 599 });
  }) as typeof fetch;
});

// The ids `installDbDriver` announced, which is how everything waiting on a driver hears of it.
let announced: string[] = [];
const onAnnounced = (e: Event) => { announced.push((e as CustomEvent<string>).detail); };
beforeEach(() => {
  announced = [];
  window.addEventListener(DB_DRIVER_INSTALLED_EVENT, onAnnounced);
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  window.removeEventListener(DB_DRIVER_INSTALLED_EVENT, onAnnounced);
});

/** Let the promises a click started settle, then flush what they rendered. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function button(root: ParentNode, text: string): HTMLButtonElement | null {
  return [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
}

const installs = () => requests.filter((r) => r.method === "POST" && r.url === "/api/db/drivers/mysql/install");

// ---------------------------------------------------------------------------------------------

describe("recognising a missing driver", () => {
  it("keeps the server's message and names the driver from a 424", async () => {
    serve(on("GET", "/api/db/connections/1/tables", { status: 424, body: MISSING_BODY }));
    const { api } = await import("../../../src/web/lib/api-client");
    const error = await api.get("/api/db/connections/1/tables").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(MISSING_BODY.error);
    expect(error.status).toBe(424);
    expect(missingDbDriverOf(error)).toEqual(DRIVER);
  });

  it("is not fooled by any other failure", async () => {
    serve(on("POST", "/api/db/connections/1/query", { status: 500, body: { ok: false, error: "boom" } }));
    const { api } = await import("../../../src/web/lib/api-client");
    const error = await api.post("/api/db/connections/1/query").catch((e) => e);
    expect(error.message).toBe("boom");
    expect(missingDbDriverOf(error)).toBeNull();
    expect(missingDbDriverOf(new Error(MISSING_BODY.error))).toBeNull();
    expect(missingDbDriverOf(new ApiError("x", 424, { code: "DB_DRIVER_MISSING" }))).toBeNull();
  });
});

describe("the notice", () => {
  it("installs the named driver once, then announces it to whatever needed it", async () => {
    serve(on("POST", "/api/db/drivers/mysql/install", ok(status("installed"))));
    view = await mount(<DriverMissingNotice driver={DRIVER} />);
    expect(view.container.textContent).toContain("The MySQL / MariaDB driver is not installed");

    await click(button(view.container, "Install"));
    await settle();

    expect(installs()).toHaveLength(1);
    expect(announced).toEqual(["mysql"]);
  });

  it("says why an install failed, and announces nothing", async () => {
    serve(on("POST", "/api/db/drivers/mysql/install", { status: 500, body: { ok: false, error: "Could not download mysql2@3.24.4: offline" } }));
    view = await mount(<DriverMissingNotice driver={DRIVER} />);

    await click(button(view.container, "Install"));
    await settle();

    expect(view.container.textContent).toContain("Could not download mysql2@3.24.4: offline");
    expect(announced).toEqual([]);
    expect(button(view.container, "Install")?.disabled).toBe(false);
  });
});

describe("Settings → Database Drivers", () => {
  it("installs a missing driver and then offers to remove it", async () => {
    let installed = false;
    serve(
      on("GET", "/api/db/drivers", () => ok([status(installed ? "installed" : "missing")])),
      on("POST", "/api/db/drivers/mysql/install", () => { installed = true; return ok(status("installed")); }),
      on("DELETE", "/api/db/drivers/mysql", () => { installed = false; return ok(status("missing")); }),
    );
    view = await mount(<DatabaseDriversSection />);
    await settle();
    const row = () => view!.container.querySelector('[data-testid="db-driver-mysql"]')!;
    expect(row().textContent).toContain("mysql2 3.24.4");
    expect(row().textContent).toContain("MIT");

    await click(button(row(), "Install"));
    await settle();
    expect(installs()).toHaveLength(1);
    expect(row().textContent).toContain("412 KB");
    expect(button(row(), "Install")).toBeNull();

    await click(row().querySelector('button[aria-label="Remove the MySQL / MariaDB driver"]'));
    await settle();
    const confirm = document.body.querySelector('[data-testid="db-driver-remove-confirm"]')!;
    expect(confirm.textContent).toContain("Open MySQL and MariaDB connections close now");
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);

    await click(button(confirm, "Remove"));
    await settle();
    expect(requests.filter((r) => r.method === "DELETE").map((r) => r.url)).toEqual(["/api/db/drivers/mysql"]);
    expect(button(row(), "Install")).not.toBeNull();
  });

  it("follows an install made from a connection's notice while it is open", async () => {
    let installed = false;
    serve(
      on("GET", "/api/db/drivers", () => ok([status(installed ? "installed" : "missing")])),
      on("POST", "/api/db/drivers/mysql/install", () => { installed = true; return ok(status("installed")); }),
    );
    view = await mount(<DatabaseDriversSection />);
    await settle();
    const row = () => view!.container.querySelector('[data-testid="db-driver-mysql"]')!;
    expect(button(row(), "Install")).not.toBeNull();

    await act(async () => { await installDbDriver("mysql"); });
    await settle();
    expect(button(row(), "Install")).toBeNull();
    expect(row().textContent).toContain("412 KB");
  });

  it("offers an update when the installed release is not the one this PPM pins", async () => {
    serve(on("GET", "/api/db/drivers", ok([status("outdated")])));
    view = await mount(<DatabaseDriversSection />);
    await settle();
    const row = view.container.querySelector('[data-testid="db-driver-mysql"]')!;
    expect(row.textContent).toContain("3.20.0 is installed; this PPM was tested with 3.24.4.");
    expect(button(row, "Update")).not.toBeNull();
  });
});

describe("the connection form", () => {
  const mysqlConn: Connection = {
    id: 5, type: "mysql", name: "shop", group_name: null, color: null, readonly: 1, sort_order: 0,
    created_at: "", updated_at: "",
  };
  const CONNECTED = { ok: true, version: "MySQL 8.4.3", databases: ["shop"], target: "localhost:3306", elapsedMs: 9 };

  /** A saved MySQL connection, opened in its tab. The config route is listed before the row's: routes match by prefix. */
  function savedConnection(...extra: Route[]): void {
    serve(
      ...extra,
      on("GET", "/api/db/connections/5/config", ok({ type: "mysql", connectionString: "mysql://root@localhost:3306/shop", hasPassword: true, entry: "fields", passwordMode: "save" })),
      on("GET", "/api/db/connections/5", ok(mysqlConn)),
      on("GET", "/api/db/connections", ok([mysqlConn])),
    );
  }

  const tests = () => requests.filter((r) => r.method === "POST" && r.url === "/api/db/test");
  const result = () => document.body.querySelector('[data-testid="db-connection-result"]')!;

  it("turns a Test that needs the driver into an Install, and tests again once it is in", async () => {
    savedConnection(
      on("GET", "/api/db/drivers", ok([status("installed")])),
      on("POST", "/api/db/drivers/mysql/install", ok(status("installed"))),
      on("POST", "/api/db/test", () => (tests().length === 1 ? { status: 424, body: MISSING_BODY } : ok(CONNECTED))),
    );
    view = await mount(<ConnectionFormTab metadata={{ connectionId: 5, connectionName: "shop" }} />);
    await settle();
    expect(document.body.querySelector('[data-testid="db-driver-missing"]')).toBeNull();

    await click(button(document.body, "Test"));
    await settle();
    const notice = document.body.querySelector('[data-testid="db-driver-missing"]')!;
    expect(notice.textContent).toContain("MySQL / MariaDB");
    expect(result().textContent).not.toContain("Connection failed");

    await click(button(notice, "Install"));
    await settle();
    expect(installs()).toHaveLength(1);
    expect(tests()).toHaveLength(2);
    expect(result().textContent).toContain("Connected: MySQL 8.4.3");
    expect(document.body.querySelector('[data-testid="db-driver-missing"]')).toBeNull();
  });

  it("says a driver is needed as soon as its engine is picked", async () => {
    serve(
      on("GET", "/api/db/drivers", ok([status("missing")])),
      on("GET", "/api/db/connections", ok([])),
    );
    view = await mount(<ConnectionFormTab />);
    await settle();
    const tile = (type: string) => document.body.querySelector<HTMLButtonElement>(`[role="radio"][data-engine="${type}"]`)!;
    expect(tile("postgres").getAttribute("aria-checked")).toBe("true");
    expect(document.body.querySelector('[data-testid="db-driver-missing"]')).toBeNull();

    await click(tile("mariadb"));
    expect(tile("mariadb").getAttribute("aria-checked")).toBe("true");
    expect(document.body.querySelector('[data-testid="db-driver-missing"]')?.textContent).toContain("MySQL / MariaDB");
  });

  it("tests again when the driver is installed from Settings instead", async () => {
    savedConnection(
      on("GET", "/api/db/drivers", ok([status("installed")])),
      on("POST", "/api/db/drivers/mysql/install", ok(status("installed"))),
      on("POST", "/api/db/test", () => (tests().length === 1 ? { status: 424, body: MISSING_BODY } : ok(CONNECTED))),
    );
    view = await mount(<ConnectionFormTab metadata={{ connectionId: 5, connectionName: "shop" }} />);
    await settle();
    await click(button(document.body, "Test"));
    await settle();
    expect(document.body.querySelector('[data-testid="db-driver-missing"]')).not.toBeNull();

    await act(async () => { await installDbDriver("mysql"); });
    await settle();
    expect(tests()).toHaveLength(2);
    expect(result().textContent).toContain("Connected: MySQL 8.4.3");
  });

  it("shows any other Test failure instead of dropping it", async () => {
    savedConnection(
      on("GET", "/api/db/drivers", ok([status("installed")])),
      on("POST", "/api/db/test", { status: 500, body: { ok: false, error: "Access denied for user 'u'" } }),
    );
    view = await mount(<ConnectionFormTab metadata={{ connectionId: 5, connectionName: "shop" }} />);
    await settle();
    await click(button(document.body, "Test"));
    await settle();
    expect(result().textContent).toContain("Connection failed: Access denied for user 'u'");
  });
});

describe("the sidebar", () => {
  const conn = (id: number, type: string, name: string) => ({
    id, type, name, group_name: null, color: null, readonly: 1, sort_order: id, created_at: "", updated_at: "",
    password_mode: "save", default_database: null, single_database: false, server: "localhost", user: "app",
  });
  const databaseReads = (id: number) => requests.filter((r) => r.method === "GET" && r.url === `/api/db/connections/${id}/databases`);
  const row = (name: string) => [...view!.container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .find((r) => [...r.querySelectorAll("span")].some((s) => s.textContent === name))!;

  /** Two opened connections: `shop` waiting for the MySQL driver, `app` failing for another reason. */
  async function mountSidebar(): Promise<void> {
    let driverIn = false;
    serve(
      on("POST", "/api/db/drivers/mysql/install", () => { driverIn = true; return ok(status("installed")); }),
      on("GET", "/api/db/connections/5/databases", () => (driverIn ? ok(["shop"]) : { status: 424, body: MISSING_BODY })),
      on("GET", "/api/db/connections/6/databases", { status: 500, body: { ok: false, error: "connection refused" } }),
      on("GET", "/api/db/connections/5/tables", ok([])),
      on("GET", "/api/db/connections", ok([conn(5, "mysql", "shop"), conn(6, "postgres", "app")])),
      on("PUT", "/api/settings/ui-prefs", ok({})),
    );
    _resetDbExplorer();
    useSettingsStore.setState({ dbExplorer: { ...DEFAULT_DB_EXPLORER, opened: [5, 6] }, dbExplorerView: DEFAULT_DB_EXPLORER_VIEW });
    view = await mount(<DatabaseSidebar />);
    await settle();
    // The tree was restored: both opened connections were tried once, and both failed.
    expect(databaseReads(5)).toHaveLength(1);
    expect(databaseReads(6)).toHaveLength(1);
  }

  it("offers Install in place of the error, and connects once it is in", async () => {
    await mountSidebar();
    const notices = view!.container.querySelectorAll('[data-testid="db-driver-missing"]');
    expect(notices).toHaveLength(1);
    // The other failure is still said, on its own row — and the driver's CLI hint is not.
    expect(row("app").getAttribute("title")).toContain("connection refused");
    expect(row("app").querySelector('[aria-label="Error: connection refused"]') != null).toBe(true);
    expect(view!.container.textContent).not.toContain("ppm db driver install");

    await click(button(notices[0]!, "Install"));
    await settle();
    expect(installs()).toHaveLength(1);
    expect(databaseReads(5)).toHaveLength(2);
    expect(row("shop").querySelector('[aria-label="Connected"]') != null).toBe(true);
    expect(view!.container.querySelectorAll('[data-testid="db-driver-missing"]')).toHaveLength(0);
    // A failure the driver has nothing to do with is not retried behind the user's back.
    expect(databaseReads(6)).toHaveLength(1);
  });

  it("offers Install once, in the object list, when the waiting connection is the current database", async () => {
    let driverIn = false;
    const single = { ...conn(7, "mysql", "orders"), single_database: true, default_database: "orders" };
    serve(
      on("POST", "/api/db/drivers/mysql/install", () => { driverIn = true; return ok(status("installed")); }),
      on("GET", "/api/db/connections/7/objects?database=orders", () => (driverIn ? ok({ schemas: [], objects: [{ schema: null, name: "invoices", kind: "table" }] }) : { status: 424, body: MISSING_BODY })),
      on("GET", "/api/db/connections/7/tables", ok([])),
      on("GET", "/api/db/connections", ok([single])),
      on("PUT", "/api/settings/ui-prefs", ok({})),
    );
    _resetDbExplorer();
    useSettingsStore.setState({
      dbExplorer: { ...DEFAULT_DB_EXPLORER, opened: [7] },
      dbExplorerView: { ...DEFAULT_DB_EXPLORER_VIEW, current: { conn: 7, database: "orders" } },
    });
    view = await mount(<DatabaseSidebar />);
    await settle();
    const objects = view.container.querySelector<HTMLElement>('section[aria-label="Tables, views, functions"]')!;
    const notices = () => view!.container.querySelectorAll('[data-testid="db-driver-missing"]');
    expect(notices()).toHaveLength(1);
    expect(objects.contains(notices()[0]!)).toBe(true);
    expect(objects.textContent).toContain("Error connecting orders");
    expect(view.container.textContent).not.toContain("ppm db driver install");
    // The row still says it failed.
    expect(row("orders").querySelector('[aria-label^="Error:"]') != null).toBe(true);

    // With the list folded away, the offer moves up to the row.
    await act(async () => { useSettingsStore.setState((st) => ({ dbExplorerView: { ...st.dbExplorerView, objectsCollapsed: true } })); });
    expect(notices()).toHaveLength(1);
    expect(view.container.querySelector('section[aria-label="Connections"]')!.contains(notices()[0]!)).toBe(true);
    await act(async () => { useSettingsStore.setState((st) => ({ dbExplorerView: { ...st.dbExplorerView, objectsCollapsed: false } })); });

    await click(button(notices()[0]!, "Install"));
    await settle();
    expect(installs()).toHaveLength(1);
    expect(notices()).toHaveLength(0);
    expect(row("invoices") != null).toBe(true);
  });

  it("offers Install once, in the prompt, when the waiting connection is picked while another database is current", async () => {
    const other = { ...conn(6, "postgres", "app"), single_database: true, default_database: "main" };
    serve(
      on("GET", "/api/db/connections/5/databases", { status: 424, body: MISSING_BODY }),
      on("GET", "/api/db/connections/6/objects?database=main", ok({ schemas: ["public"], objects: [{ schema: "public", name: "accounts", kind: "table" }] })),
      on("GET", "/api/db/connections/6/tables", ok([])),
      on("GET", "/api/db/connections", ok([conn(5, "mysql", "shop"), other])),
      on("PUT", "/api/settings/ui-prefs", ok({})),
    );
    _resetDbExplorer();
    useSettingsStore.setState({
      dbExplorer: { ...DEFAULT_DB_EXPLORER, opened: [5, 6] },
      dbExplorerView: { ...DEFAULT_DB_EXPLORER_VIEW, current: { conn: 6, database: "main" } },
    });
    view = await mount(<DatabaseSidebar />);
    await settle();
    // Until it is picked, the failed connection's own row makes the offer.
    const notices = () => view!.container.querySelectorAll('[data-testid="db-driver-missing"]');
    expect(notices()).toHaveLength(1);
    expect(row("shop").nextElementSibling?.contains(notices()[0]!)).toBe(true);

    await click(row("shop"));
    await settle();
    const prompt = view.container.querySelector<HTMLElement>('[role="region"][aria-label="Current database"]')!;
    expect(prompt.textContent).toContain("Error connecting shop");
    expect(notices()).toHaveLength(1);
    expect(prompt.contains(notices()[0]!)).toBe(true);
    expect(view.container.textContent).not.toContain("ppm db driver install");
  });

  it("brings a waiting connection back when the driver is installed from Settings", async () => {
    await mountSidebar();

    await act(async () => { await installDbDriver("mysql"); });
    await settle();
    expect(databaseReads(5)).toHaveLength(2);
    expect(row("shop").querySelector('[aria-label="Connected"]') != null).toBe(true);
    expect(databaseReads(6)).toHaveLength(1);
  });
});

describe("the viewer's data", () => {
  // One object for the whole test, as a tab's own target is: the hooks read it again when it changes.
  const TARGET = { kind: "connection", connectionId: 5 } as const;

  it("knows the driver is missing until a retry gets through", async () => {
    let driverIn = false;
    const missing: Answer = { status: 424, body: MISSING_BODY };
    serve(
      on("POST", "/api/db/connections/5/grid/count", () => ok({ count: 1, estimate: null })),
      on("POST", "/api/db/connections/5/grid", () => (driverIn ? ok({ columns: [{ name: "id", type: "int" }], rows: [[1]], hasMore: false, sql: "SELECT", rowKey: ["id"] }) : missing)),
      on("GET", "/api/db/connections/5/schema", () => (driverIn ? ok([{ name: "id", type: "int", nullable: false, pk: true, defaultValue: null }]) : missing)),
    );
    const ref = {} as { current: ReturnType<typeof useDatabase> };
    function Harness() {
      ref.current = useDatabase(TARGET);
      return null;
    }
    view = await mount(<Harness />);

    await act(async () => { ref.current.selectTable("users", "shop"); });
    await settle();
    expect(ref.current.driverMissing).toEqual(DRIVER);

    driverIn = true;
    await act(async () => { ref.current.reload(); });
    await settle();
    expect(ref.current.driverMissing).toBeNull();
    expect(ref.current.tableData?.rows).toEqual([{ id: 1 }]);
  });

  it("runs again the very call that found the driver missing, once it is installed", async () => {
    let driverIn = false;
    const missing: Answer = { status: 424, body: MISSING_BODY };
    serve(
      on("POST", "/api/db/drivers/mysql/install", () => { driverIn = true; return ok(status("installed")); }),
      on("POST", "/api/db/connections/5/query/script", (body) => (driverIn ? script(body, [[7]]) : missing)),
    );
    const ref = {} as { current: ReturnType<typeof useQueryRunner> };
    function Harness() {
      ref.current = useQueryRunner(TARGET, { maxRows: 1_000, continueOnError: false });
      return null;
    }
    view = await mount(<Harness />);

    await act(async () => { await ref.current.start({ sql: "SELECT 7 AS x", kind: "statement", lineOffset: 0 }); });
    expect(ref.current.driverMissing).toEqual(DRIVER);
    expect(ref.current.run?.failed).toBe(true);

    await act(async () => { await installDbDriver("mysql"); });
    await settle();
    const queries = requests.filter((r) => r.url === "/api/db/connections/5/query/script");
    expect(queries.map((r) => (r.body as { sql: string }).sql)).toEqual(["SELECT 7 AS x", "SELECT 7 AS x"]);
    expect(ref.current.driverMissing).toBeNull();
    expect(ref.current.run?.done).toBe(true);
    expect(ref.current.run?.failed).toBe(false);
    expect(ref.current.run?.results[0]?.resultSets[0]?.rows).toEqual([[7]]);
  });
});
