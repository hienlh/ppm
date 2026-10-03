/**
 * The connection tab against a stub server: what Test, Connect and Save send and when, which box
 * a problem is pointed at, a result going stale once the form moves on, and a connection that
 * keeps no password asking through Database Log In.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { ConnectionFormTab } = await import("../../../src/web/components/database/connection-form/connection-form-tab");
const { DbLoginDialogHost } = await import("../../../src/web/components/database/db-login/db-login-dialog");
const { useDbLoginStore } = await import("../../../src/web/components/database/db-login/db-login-store");
const { DB_CONNECTIONS_CHANGED, useDbSidebarReveal } = await import("../../../src/web/components/database/db-sidebar-reveal");
const { openConnectionForm } = await import("../../../src/web/components/database/open-connection-form");
const { DB_DRIVER_INSTALLED_EVENT } = await import("../../../src/web/lib/db-drivers");
const { DEFAULT_DB_EXPLORER, DEFAULT_DB_EXPLORER_VIEW } = await import("../../../src/shared/db-explorer-prefs");

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown };
type Route = (req: Req) => Answer | undefined;

const realFetch = globalThis.fetch;
let requests: Req[] = [];
let routes: Route[] = [];

function on(method: string, url: string, answer: Answer | ((req: Req) => Answer)): Route {
  return (req) => (req.method === method && req.url === url ? (typeof answer === "function" ? answer(req) : answer) : undefined);
}
const ok = (data: unknown): Answer => ({ body: { ok: true, data } });

const CONNECTED = { ok: true, version: "PostgreSQL 17.2", databases: ["shop", "billing"], target: "db1:5432", elapsedMs: 14 };
const REFUSED = {
  ok: false,
  error: 'password authentication failed for user "app"',
  details: "SQLSTATE 28P01 · invalid_password\nPostgreSQL at db1:5432\nuser app\nChecked from the PPM host.",
  elapsedMs: 21,
};
const SAVED = { id: 41, type: "postgres", name: "shop@db1", group_name: null, color: null, readonly: 1, sort_order: 0, created_at: "", updated_at: "" };

let changed: unknown[] = [];
const onChanged = (e: Event) => { changed.push((e as CustomEvent).detail); };

beforeEach(() => {
  requests = [];
  changed = [];
  routes = [
    on("GET", "/api/db/connections", ok([])),
    on("GET", "/api/db/drivers", ok([])),
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    for (const route of routes) {
      const answer = route(req);
      if (answer) return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: false, error: `no stub for ${req.method} ${req.url}` }), { status: 599 });
  }) as typeof fetch;
  window.addEventListener(DB_CONNECTIONS_CHANGED, onChanged);
  useDbSidebarReveal.setState({ revealId: null, expandId: null });
  useDbLoginStore.setState({ queue: [] });
  useSettingsStore.setState({ dbExplorer: DEFAULT_DB_EXPLORER, dbExplorerView: DEFAULT_DB_EXPLORER_VIEW });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  window.removeEventListener(DB_CONNECTIONS_CHANGED, onChanged);
});

/** Stubs answering before the defaults, for this test only. */
function serve(...extra: Route[]): void {
  routes = [...extra, ...routes];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function $<T extends Element = HTMLElement>(selector: string): T {
  const el = document.body.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

function button(text: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

/** Types into an input or textarea the way React hears it. */
async function type(selector: string, text: string): Promise<void> {
  const el = $<HTMLInputElement | HTMLTextAreaElement>(selector);
  // happy-dom's element classes live on its window; not every one is copied to the global scope.
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(selector: string, value: string): Promise<void> {
  const el = $<HTMLSelectElement>(selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const result = () => $('[data-testid="db-connection-result"]');
const sent = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url);

async function newConnection(): Promise<void> {
  view = await mount(<><ConnectionFormTab /><DbLoginDialogHost /></>);
  await settle();
  await type("#cf-host", "db1");
  await type("#cf-user", "app");
  await type("#cf-password", "pw");
  await type("#cf-database", "shop");
}

describe("Test", () => {
  it("tries what the form holds and shows the version, the database, where and how long", async () => {
    serve(on("POST", "/api/db/test", ok(CONNECTED)));
    await newConnection();

    await click(button("Test"));
    await settle();

    expect(sent("POST", "/api/db/test").map((r) => r.body)).toEqual([{
      type: "postgres",
      connectionConfig: {
        type: "postgres", entry: "fields", passwordMode: "save", allowedDatabases: [], allowedDatabasesRegex: "",
        singleDatabase: true, connectionString: "postgres://app:pw@db1/shop",
        // Sent even when nothing is typed there, so an emptied tab clears what was saved.
        ssh: { enabled: false, host: "", port: "", bastionHost: "", auth: "password", user: "", keyFile: "" },
        ssl: { ca: "", cert: "", key: "" },
      },
    }]);
    expect(result().dataset.state).toBe("ok");
    expect(result().textContent).toContain("Connected: PostgreSQL 17.2");
    expect(result().textContent).toContain("database “shop” · db1:5432 · 14 ms");
    // A test keeps nothing.
    expect(requests.some((r) => r.method !== "GET" && r.url !== "/api/db/test")).toBe(false);
    // On a phone the result is a row of its own above the buttons. tailwind-merge reads a later
    // `flex-1` as replacing `basis-full`, which squeezed it into a column one word wide.
    expect([...result().classList]).toEqual(expect.arrayContaining(["order-first", "basis-full"]));
  });

  it("drops its result once the connection it tested is edited, and not for a rename", async () => {
    serve(on("POST", "/api/db/test", ok(CONNECTED)));
    await newConnection();
    await click(button("Test"));
    await settle();

    await type("#cf-name", "Shop");
    expect(result().dataset.state).toBe("ok");
    await type("#cf-host", "db2");
    expect(result().dataset.state).toBe("idle");
  });

  it("shows the driver's refusal, with the details behind a link", async () => {
    serve(on("POST", "/api/db/test", ok(REFUSED)));
    await newConnection();
    await click(button("Test"));
    await settle();

    expect(result().textContent).toContain('Connection failed: password authentication failed for user "app"');
    expect(document.body.querySelector('[data-testid="db-connection-details"]')).toBeNull();
    await click(button("Details"));
    expect($('[data-testid="db-connection-details"]').textContent).toContain("SQLSTATE 28P01");
  });

  it("points at the port without asking the server, from whichever tab the form was on", async () => {
    await newConnection();
    await type("#cf-port", "99999");
    await click($("#cft-advanced"));
    expect(document.body.querySelector("#cf-port")).toBeNull();

    await click(button("Test"));
    await settle();

    expect($("#cft-general").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe($("#cf-port"));
    expect($("#cf-port").getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain("A number from 1 to 65535.");
    expect(sent("POST", "/api/db/test")).toHaveLength(0);
  });

  it("opens Advanced for a broken regular expression", async () => {
    await newConnection();
    await click($("#cft-advanced"));
    await type("#cf-allowed-re", "[");
    await click($("#cft-general"));

    await click(button("Connect"));
    await settle();

    expect($("#cft-advanced").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe($("#cf-allowed-re"));
    expect(sent("POST", "/api/db/test")).toHaveLength(0);
  });
});

describe("Connect and Save", () => {
  it("saves only a connection that connects, then shows it in the tree, expanded", async () => {
    let works = false;
    serve(
      on("POST", "/api/db/test", () => ok(works ? CONNECTED : REFUSED)),
      on("POST", "/api/db/connections", ok(SAVED)),
    );
    await newConnection();

    await click(button("Connect"));
    await settle();
    expect(result().textContent).toContain("Connection failed");
    expect(sent("POST", "/api/db/connections")).toHaveLength(0);

    works = true;
    await click(button("Connect"));
    await settle();
    const [save] = sent("POST", "/api/db/connections");
    expect(save?.body).toMatchObject({ type: "postgres", name: "shop@db1", readonly: true, aiAccess: true });
    expect(useDbSidebarReveal.getState().revealId).toBe(41);
    expect(useDbSidebarReveal.getState().expandId).toBe(41);
    expect(changed).toContainEqual({ connectionId: 41, refreshTables: true });
  });

  it("closes its tab once saved", async () => {
    serve(on("POST", "/api/db/connections", ok(SAVED)));
    openConnectionForm();
    const tab = useTabStore.getState().tabs.find((t) => t.type === "db-connection");
    expect(tab?.title).toBe("New connection");
    view = await mount(<ConnectionFormTab metadata={tab!.metadata} tabId={tab!.id} />);
    await settle();

    await click(button("Save"));
    await settle();
    expect(sent("POST", "/api/db/connections")).toHaveLength(1);
    expect(useTabStore.getState().tabs.some((t) => t.id === tab!.id)).toBe(false);
  });

  it("saves without testing, and refuses a name another connection has", async () => {
    serve(
      on("GET", "/api/db/connections", ok([{ ...SAVED, id: 3, name: "shop@db1" }])),
      on("POST", "/api/db/connections", ok({ ...SAVED, name: "Shop 2" })),
    );
    await newConnection();

    await click(button("Save"));
    await settle();
    expect(document.activeElement).toBe($("#cf-name"));
    expect(document.body.textContent).toContain("Another connection already has this name.");
    expect(sent("POST", "/api/db/connections")).toHaveLength(0);

    await type("#cf-name", "Shop 2");
    await click(button("Save"));
    await settle();
    expect(sent("POST", "/api/db/test")).toHaveLength(0);
    expect(sent("POST", "/api/db/connections").map((r) => (r.body as { name: string }).name)).toEqual(["Shop 2"]);
    // Saved, not connected: shown, but not opened.
    expect(useDbSidebarReveal.getState().revealId).toBe(41);
    expect(useDbSidebarReveal.getState().expandId).toBeNull();
  });

  it("points at the box a server-side refusal names", async () => {
    serve(on("POST", "/api/db/connections", { status: 400, body: { ok: false, error: "Not a valid isolation level", field: "isolationLevel" } }));
    await newConnection();
    await click(button("Save"));
    await settle();
    expect($("#cft-advanced").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe($("#cf-isolation"));
  });
});

describe("a connection that keeps no password", () => {
  it("hides the password, and asks for it in Database Log In when tested", async () => {
    serve(on("POST", "/api/db/test", (req) => ok((req.body as { login?: { password: string } }).login?.password === "pw" ? CONNECTED : REFUSED)));
    await newConnection();
    await choose("#cf-passmode", "askPassword");
    expect(document.body.querySelector("#cf-password")).toBeNull();
    expect(($("#cf-ai") as HTMLInputElement).disabled).toBe(true);

    await click(button("Test"));
    await settle();
    expect(sent("POST", "/api/db/test")).toHaveLength(0);
    const dialog = $('[data-testid="db-login"]');
    expect(document.body.textContent).toContain("Database Log In (postgres)");
    expect(($("#dbl-conn") as HTMLInputElement).value).toBe("shop@db1");
    expect(($("#dbl-user") as HTMLInputElement).value).toBe("app");
    expect(($("#dbl-user") as HTMLInputElement).readOnly).toBe(true);

    await type("#dbl-pass", "wrong");
    await click(button("Connect", dialog));
    await settle();
    expect($('[data-testid="db-login-state"]').textContent).toContain('Connect failed: password authentication failed for user "app"');
    await click(button("Show detail", dialog));
    expect(dialog.textContent).toContain("SQLSTATE 28P01");

    await type("#dbl-pass", "pw");
    await click(button("Connect", dialog));
    await settle();
    expect(document.body.querySelector('[data-testid="db-login"]')).toBeNull();
    expect(result().textContent).toContain("Connected: PostgreSQL 17.2");
    const tried = sent("POST", "/api/db/test").map((r) => r.body as { login: unknown; connectionConfig: { connectionString: string; passwordMode: string } });
    expect(tried.map((b) => b.login)).toEqual([{ password: "wrong" }, { password: "pw" }]);
    // The URL the form sends never has the password in it.
    expect(tried.every((b) => b.connectionConfig.connectionString === "postgres://app@db1/shop")).toBe(true);
    expect(tried.every((b) => b.connectionConfig.passwordMode === "askPassword")).toBe(true);
  });

  it("asks for the user too, and holds the login once Connect has saved", async () => {
    serve(
      on("POST", "/api/db/test", ok(CONNECTED)),
      on("POST", "/api/db/connections", ok({ ...SAVED, name: "shop@db1" })),
      on("POST", "/api/db/connections/41/login", ok(CONNECTED)),
    );
    await newConnection();
    await choose("#cf-passmode", "askUser");
    expect(document.body.querySelector("#cf-user")).toBeNull();

    await click(button("Connect"));
    await settle();
    const dialog = $('[data-testid="db-login"]');
    expect(($("#dbl-user") as HTMLInputElement).readOnly).toBe(false);
    expect(document.activeElement).toBe($("#dbl-user"));

    // No user: refused here, before anything is tried.
    await type("#dbl-pass", "pw");
    await click(button("Connect", dialog));
    expect(dialog.textContent).toContain("Enter the user name.");
    expect(sent("POST", "/api/db/test")).toHaveLength(0);

    await type("#dbl-user", "alice");
    await click(button("Connect", dialog));
    await settle();

    expect(sent("POST", "/api/db/test").map((r) => (r.body as { login: unknown }).login)).toEqual([{ user: "alice", password: "pw" }]);
    const [save] = sent("POST", "/api/db/connections");
    expect((save?.body as { connectionConfig: { connectionString: string } }).connectionConfig.connectionString).toBe("postgres://db1/shop");
    expect((save?.body as { aiAccess: boolean }).aiAccess).toBe(false);
    expect(sent("POST", "/api/db/connections/41/login").map((r) => r.body)).toEqual([{ user: "alice", password: "pw" }]);
  });

  it("does nothing when Database Log In is closed", async () => {
    serve(on("POST", "/api/db/test", ok(CONNECTED)));
    await newConnection();
    await choose("#cf-passmode", "askPassword");
    await click(button("Connect"));
    await settle();

    await click(button("Close", $('[data-testid="db-login"]')));
    await settle();
    expect(document.body.querySelector('[data-testid="db-login"]')).toBeNull();
    expect(result().dataset.state).toBe("idle");
    expect(requests.filter((r) => r.method !== "GET" && r.url.startsWith("/api/db/"))).toEqual([]);
  });
});

describe("the SSH Tunnel and SSL tabs", () => {
  const agent = (found: boolean) => on("GET", "/api/db/ssh/agent", ok({ found, socket: found ? "/run/user/1000/ssh-agent.socket" : null, user: "deploy" }));
  const THROUGH_SSH = { ...CONNECTED, target: "localhost:5432", tls: null, ssh: [{ host: "ssh.example.com:22", fingerprint: "SHA256:abc", firstSeen: true }] };

  async function tunnelOn(host = "ssh.example.com"): Promise<void> {
    await click($("#cft-ssh"));
    await click($("#cf-ssh"));
    if (host) await type("#cf-ssh-host", host);
  }

  it("keeps the tunnel's fields shut while it is off, and says who an empty Login is", async () => {
    serve(agent(true));
    await newConnection();
    await click($("#cft-ssh"));
    await settle();
    expect($<HTMLFieldSetElement>("fieldset").disabled).toBe(true);
    expect($<HTMLInputElement>("#cf-ssh-login").placeholder).toBe("deploy");
    await click($("#cf-ssh"));
    expect($<HTMLFieldSetElement>("fieldset").disabled).toBe(false);
  });

  it("says whether the PPM host has an agent, asking again when the agent is picked", async () => {
    serve(agent(false));
    await newConnection();
    await tunnelOn();
    await settle();
    await choose("#cf-ssh-auth", "agent");
    await settle();
    expect($('[data-testid="db-ssh-agent"]').textContent).toContain("No SSH agent found on the PPM host.");
    expect(sent("GET", "/api/db/ssh/agent")).toHaveLength(2);
    // Neither a password nor a key goes with the agent.
    expect(document.body.querySelector("#cf-ssh-pass")).toBeNull();
    expect(document.body.querySelector("#cf-ssh-key")).toBeNull();
  });

  it("points at the SSH host from General, and sends nothing", async () => {
    serve(agent(true));
    await newConnection();
    await tunnelOn("");
    await click($("#cft-general"));
    await click(button("Test"));
    await settle();
    expect($("#cft-ssh").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe($("#cf-ssh-host"));
    expect(document.body.textContent).toContain("Enter the SSH host.");
    expect(sent("POST", "/api/db/test")).toHaveLength(0);
  });

  it("offers the SSH driver on its own tab when the tunnel needs it, and tests again once it is in", async () => {
    let installed = false;
    serve(agent(true), on("POST", "/api/db/test", () => (installed ? ok(THROUGH_SSH) : {
      status: 424, body: { ok: false, error: "The SSH tunnel driver is not installed", code: "DB_DRIVER_MISSING", driver: { id: "ssh", displayName: "SSH tunnel" } },
    })));
    await newConnection();
    await tunnelOn();
    await click($("#cft-general"));
    await click(button("Test"));
    await settle();
    expect($("#cft-ssh").getAttribute("aria-selected")).toBe("true");
    expect($('[data-testid="db-driver-missing"]').textContent).toContain("The SSH tunnel driver is not installed");

    installed = true;
    await act(async () => { window.dispatchEvent(new CustomEvent(DB_DRIVER_INSTALLED_EVENT, { detail: "ssh" })); });
    await settle();
    expect(sent("POST", "/api/db/test")).toHaveLength(2);
    expect(result().dataset.state).toBe("ok");
    expect(document.body.querySelector('[data-testid="db-driver-missing"]')).toBeNull();
  });

  it("says the way it went, and opens Details on a host key PPM has just started trusting", async () => {
    let firstSeen = true;
    serve(agent(true), on("POST", "/api/db/test", () => ok({ ...THROUGH_SSH, ssh: [{ ...THROUGH_SSH.ssh[0], firstSeen }] })));
    await newConnection();
    await tunnelOn();
    await click(button("Test"));
    await settle();
    expect(result().textContent).toContain("through SSH ssh.example.com:22");
    expect($('[data-testid="db-connection-details"]').textContent).toContain(
      "SSH server ssh.example.com:22, host key SHA256:abc (first connection: PPM trusts this key from now on)",
    );

    // A key PPM already had: the details wait behind their link.
    firstSeen = false;
    await click(button("Test"));
    await settle();
    expect(document.body.querySelector('[data-testid="db-connection-details"]')).toBeNull();
    await click(button("Details"));
    expect($('[data-testid="db-connection-details"]').textContent).toContain("SSL: off · not set in the URL");
  });

  it("writes SSL into the URL it sends", async () => {
    serve(on("POST", "/api/db/test", ok(CONNECTED)));
    await newConnection();
    await click($("#cft-ssl"));
    expect($<HTMLInputElement>("#cf-ssl-reject").disabled).toBe(true);
    await click($("#cf-ssl"));
    await click($("#cf-ssl-reject"));
    expect(document.body.textContent).toContain("In the URL: sslmode=verify-full.");
    await click(button("Test"));
    await settle();
    expect((sent("POST", "/api/db/test")[0]?.body as { connectionConfig: { connectionString: string } }).connectionConfig.connectionString)
      .toBe("postgres://app:pw@db1/shop?sslmode=verify-full");
  });

  it("keeps a saved SSH password it does not show", async () => {
    serve(
      agent(true),
      on("GET", "/api/db/connections/41", ok(SAVED)),
      on("GET", "/api/db/connections/41/config", ok({
        type: "postgres", connectionString: "postgres://app@localhost/shop", hasPassword: false, entry: "fields",
        ssh: { enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", hasPassword: true, hasPassphrase: false },
      })),
      on("PUT", "/api/db/connections/41", ok(SAVED)),
    );
    view = await mount(<ConnectionFormTab metadata={{ connectionId: 41, connectionName: "shop@db1" }} />);
    await settle();
    await click($("#cft-ssh"));
    expect($<HTMLInputElement>("#cf-ssh-pass").placeholder).toBe("Saved on the PPM host");
    await click(button("Save"));
    await settle();
    const config = (sent("PUT", "/api/db/connections/41")[0]?.body as { connectionConfig: Record<string, unknown> }).connectionConfig;
    expect(config).toMatchObject({ keepPassword: true, ssh: { enabled: true, host: "ssh.example.com", auth: "password", user: "deploy" } });
    expect(config.ssh).not.toHaveProperty("password");
  });
});
