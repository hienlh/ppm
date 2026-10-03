/**
 * Database Log In for a saved connection that keeps no password: any request the server refuses
 * with `428 DB_LOGIN_REQUIRED` asks here, the login goes to `/login` to be tested and held, and
 * the refused request is sent again. Closing the dialog hands the 428 back to whoever asked.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every Dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { api, ApiError } = await import("../../../src/web/lib/api-client");
const { DbLoginDialogHost } = await import("../../../src/web/components/database/db-login/db-login-dialog");
const { settleDbLogin, useDbLoginStore } = await import("../../../src/web/components/database/db-login/db-login-store");
const { DB_CONNECTIONS_CHANGED } = await import("../../../src/web/components/database/db-sidebar-reveal");

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown; signal?: AbortSignal | null };
type Route = (req: Req) => Answer | Promise<Answer> | undefined;

const realFetch = globalThis.fetch;
let requests: Req[] = [];
let routes: Route[] = [];

function on(method: string, url: string, answer: Answer | ((req: Req) => Answer | Promise<Answer>)): Route {
  return (req) => (req.method === method && req.url === url ? (typeof answer === "function" ? answer(req) : answer) : undefined);
}
const ok = (data: unknown): Answer => ({ body: { ok: true, data } });

const PROMPT = { connectionId: 9, name: "prod", type: "postgres", user: "app", askUser: false };
const LOGIN_REQUIRED: Answer = {
  status: 428,
  body: { ok: false, error: "prod asks for its password", code: "DB_LOGIN_REQUIRED", login: PROMPT },
};
const CONNECTED = { ok: true, version: "PostgreSQL 17.2", databases: ["shop"], target: "db1:5432", elapsedMs: 8 };
const REFUSED = { ok: false, error: 'password authentication failed for user "app"', details: "SQLSTATE 28P01 · invalid_password", elapsedMs: 5 };
const TABLES = [{ name: "orders", schema: "public", rowCount: 3 }];

let changed: unknown[] = [];
const onChanged = (e: Event) => { changed.push((e as CustomEvent).detail); };

/** Tables answer 428 until a login is held, the way the server's guard does. */
let held = false;

beforeEach(() => {
  requests = [];
  changed = [];
  held = false;
  routes = [
    on("GET", "/api/db/connections/9/tables", () => (held ? ok(TABLES) : LOGIN_REQUIRED)),
    on("GET", "/api/db/connections", ok([])),
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Req = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    };
    requests.push(req);
    for (const route of routes) {
      const answer = await route(req);
      if (answer) return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: false, error: `no stub for ${req.method} ${req.url}` }), { status: 599 });
  }) as typeof fetch;
  window.addEventListener(DB_CONNECTIONS_CHANGED, onChanged);
  useDbLoginStore.setState({ queue: [] });
});

let view: Mounted | null = null;
afterEach(async () => {
  // A request a test left waiting on the dialog is ended, or the API client would hand the next
  // test the same pending GET instead of sending its own.
  await act(async () => { for (const p of useDbLoginStore.getState().queue) settleDbLogin(p.id, null); });
  await settle();
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  window.removeEventListener(DB_CONNECTIONS_CHANGED, onChanged);
});

function serve(...extra: Route[]): void {
  routes = [...extra, ...routes];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const dialog = () => document.body.querySelector<HTMLElement>('[data-testid="db-login"]');

function button(text: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

async function typePassword(text: string): Promise<void> {
  const el = document.body.querySelector<HTMLInputElement>("#dbl-pass")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const logins = () => requests.filter((r) => r.method === "POST" && r.url === "/api/db/connections/9/login");
const tableReads = () => requests.filter((r) => r.url === "/api/db/connections/9/tables");

/** A request left running while the dialog is up, with how it ended. */
function pending<T>(promise: Promise<T>): { done: () => boolean; value: () => T | undefined; error: () => unknown } {
  let state: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then((value) => { state = { done: true, value }; }, (error) => { state = { done: true, error }; });
  return { done: () => state.done, value: () => state.value, error: () => state.error };
}

describe("a request the server refuses for want of a login", () => {
  it("asks for the password, holds it on the server, and sends the request again", async () => {
    serve(on("POST", "/api/db/connections/9/login", () => { held = true; return ok(CONNECTED); }));
    view = await mount(<DbLoginDialogHost />);
    const read = pending(api.get<typeof TABLES>("/api/db/connections/9/tables"));
    await settle();

    expect(dialog()).not.toBeNull();
    expect(document.body.textContent).toContain("Database Log In (postgres)");
    expect(document.body.querySelector<HTMLInputElement>("#dbl-conn")!.value).toBe("prod");
    expect(document.body.querySelector<HTMLInputElement>("#dbl-user")!.value).toBe("app");
    expect(document.activeElement).toBe(document.body.querySelector("#dbl-pass"));
    expect(read.done()).toBe(false);

    await typePassword("s3cret");
    await click(button("Connect", dialog()!));
    await settle();

    expect(logins().map((r) => r.body)).toEqual([{ password: "s3cret" }]);
    expect(dialog()).toBeNull();
    expect(read.value()).toEqual(TABLES);
    expect(tableReads()).toHaveLength(2);
    expect(changed).toEqual([{ connectionId: 9 }]);
  });

  it("stays open on a wrong password, with the driver's words and their detail", async () => {
    serve(on("POST", "/api/db/connections/9/login", ok(REFUSED)));
    view = await mount(<DbLoginDialogHost />);
    const read = pending(api.get("/api/db/connections/9/tables"));
    await settle();

    await typePassword("wrong");
    await click(button("Connect", dialog()!));
    await settle();

    expect(dialog()!.textContent).toContain('Connect failed: password authentication failed for user "app"');
    expect(dialog()!.textContent).not.toContain("SQLSTATE 28P01");
    await click(button("Show detail", dialog()!));
    expect(dialog()!.textContent).toContain("SQLSTATE 28P01");
    expect(document.activeElement).toBe(document.body.querySelector("#dbl-pass"));
    expect(read.done()).toBe(false);
    expect(tableReads()).toHaveLength(1);
  });

  it("gives the 428 back to the caller when closed, and sends nothing more", async () => {
    view = await mount(<DbLoginDialogHost />);
    const read = pending(api.get("/api/db/connections/9/tables"));
    await settle();

    await click(button("Close", dialog()!));
    await settle();

    expect(dialog()).toBeNull();
    expect(read.error()).toBeInstanceOf(ApiError);
    expect((read.error() as InstanceType<typeof ApiError>).status).toBe(428);
    expect((read.error() as InstanceType<typeof ApiError>).code).toBe("DB_LOGIN_REQUIRED");
    expect(logins()).toHaveLength(0);
    expect(tableReads()).toHaveLength(1);
  });

  it("asks once for two requests to the same connection, and sends both again", async () => {
    serve(
      on("POST", "/api/db/connections/9/login", () => { held = true; return ok(CONNECTED); }),
      on("POST", "/api/db/connections/9/query", () => (held ? ok({ rows: [[1]] }) : LOGIN_REQUIRED)),
    );
    view = await mount(<DbLoginDialogHost />);
    const read = pending(api.get("/api/db/connections/9/tables"));
    const query = pending(api.post("/api/db/connections/9/query", { sql: "SELECT 1" }));
    await settle();

    expect(useDbLoginStore.getState().queue).toHaveLength(1);
    await typePassword("s3cret");
    await click(button("Connect", dialog()!));
    await settle();

    expect(logins()).toHaveLength(1);
    expect(read.value()).toEqual(TABLES);
    expect(query.value()).toEqual({ rows: [[1]] });
    expect(requests.filter((r) => r.url === "/api/db/connections/9/query").map((r) => r.body)).toEqual([{ sql: "SELECT 1" }, { sql: "SELECT 1" }]);
  });

  it("leaves a 428 to a caller that answers it itself", async () => {
    serve(on("POST", "/api/db/test", LOGIN_REQUIRED));
    view = await mount(<DbLoginDialogHost />);
    const test = pending(api.post("/api/db/test", {}, { dbLogin: false }));
    await settle();

    expect(dialog()).toBeNull();
    expect((test.error() as InstanceType<typeof ApiError>).status).toBe(428);
  });

  it("stops a login being tried, and lets the next one through", async () => {
    let answerHeld: ((a: Answer) => void) | null = null;
    serve(on("POST", "/api/db/connections/9/login", (req) => new Promise<Answer>((resolve, reject) => {
      answerHeld = resolve;
      req.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    view = await mount(<DbLoginDialogHost />);
    pending(api.get("/api/db/connections/9/tables"));
    await settle();

    await typePassword("slow");
    await click(button("Connect", dialog()!));
    await settle();
    expect(dialog()!.textContent).toContain("Testing connection");
    expect(document.body.querySelector<HTMLInputElement>("#dbl-pass")!.disabled).toBe(true);
    const signal = logins()[0]!.signal!;

    await click(button("Stop connecting", dialog()!));
    await settle();
    expect(signal.aborted).toBe(true);
    expect(dialog()!.textContent).not.toContain("Testing connection");
    expect(dialog()!.textContent).not.toContain("Connect failed");
    expect(button("Connect", dialog()!)).not.toBeNull();
    expect(document.body.querySelector<HTMLInputElement>("#dbl-pass")!.disabled).toBe(false);
    expect(answerHeld).not.toBeNull();
  });
});
