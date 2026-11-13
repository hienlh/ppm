/**
 * `db_connection_save`, `db_connection_delete` and `db_connection_test`, run against the real
 * database routes behind the family's own allowlist and gate. Pinned: no body ever carries
 * `readonly` (a new connection is read-only), a URL with a password and a credential file are
 * refused before any card, a moved endpoint with a saved secret is refused, every card is built
 * from what PPM lists, and an answer that comes after a change writes nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getConnectionById, insertConnection, openTestDb, setDb, updateConnection } from "../../../../src/services/db.service.ts";
import { _resetPpmDir, getPpmDir } from "../../../../src/services/ppm-dir.ts";
import { initAdapters } from "../../../../src/services/database/init-adapters.ts";
import { databaseRoutes } from "../../../../src/server/routes/database.ts";
import { ANNOUNCE_DB_CONNECTIONS_ENV_KEY } from "../../../../src/server/routes/database-connections-broadcast.ts";
import { checkRouteCall, isDbConnectionPath } from "../../../../src/services/assistant-mcp/assistant-route-call.ts";
import { DB_CONNECTION_ROUTES, createDbConnectionToolHandlers } from "../../../../src/services/assistant-mcp/assistant-db-connection-tools.ts";
import { DB_CONNECTION_TOOL_DEFINITIONS } from "../../../../src/services/assistant-mcp/assistant-db-connection-tool-definitions.ts";
import { DB_CONNECTION_TOOLS } from "../../../../src/shared/assistant-db-connection-tool-names.ts";
import type { ApprovalAsk, ApprovalVerdict } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { CallPpmRoute, RouteCallResult, RouteMethod } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";

const SECRET = "hunter2-s3cret";
const originalPpmHome = process.env.PPM_HOME;
const app = new Hono().route("/api/db", databaseRoutes);
const roots: string[] = [];
let root: string;

initAdapters();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-dbconn-tools-"));
  roots.push(root);
  process.env.PPM_HOME = join(root, "ppm");
  mkdirSync(process.env.PPM_HOME, { recursive: true });
  _resetPpmDir();
  setDb(openTestDb());
});

afterEach(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function sqliteFile(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.exec("CREATE TABLE t (id INTEGER)");
  db.close();
  return path;
}

function harness(opts: { verdict?: ApprovalVerdict; onAsk?: () => void; now?: () => number } = {}) {
  const asks: ApprovalAsk[] = [];
  const writes: string[] = [];
  const announced: string[] = [];
  const callRoute = (async <T,>(method: RouteMethod, path: string, body?: Record<string, unknown>): Promise<RouteCallResult<T>> => {
    const checked = checkRouteCall(DB_CONNECTION_ROUTES, method, path, body, () => null);
    if (!checked.ok || !isDbConnectionPath(path)) throw new Error(`not allowed: ${method} ${path}`);
    if (method !== "GET") writes.push(`${method} ${path} ${checked.json ?? ""}`);
    const res = await app.request(path, {
      method, ...(checked.json === undefined ? {} : { headers: { "content-type": "application/json" }, body: checked.json }),
    }, { [ANNOUNCE_DB_CONNECTIONS_ENV_KEY]: () => announced.push(method) });
    const json = await res.json() as { ok?: boolean; data?: T; error?: string };
    return { status: res.status, ok: res.ok && json.ok !== false, data: json.data, ...(json.error ? { error: json.error } : {}) };
  }) as CallPpmRoute;
  const deps = { projectRoots: () => [], home: join(root, "home"), now: opts.now };
  const handlers = createDbConnectionToolHandlers(deps);
  const ctx = {
    sessionId: "s1", callRoute,
    ask: async (ask: ApprovalAsk) => { asks.push(ask); opts.onAsk?.(); return opts.verdict ?? { verdict: "approved" as const }; },
  };
  const run = async (tool: string, args: Record<string, unknown>) => {
    const r = await handlers[tool]!(ctx, args) as { content: Array<{ text: string }>; isError?: boolean };
    const text = r.content[0]!.text;
    return { error: !!r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { run, asks, writes, announced };
}

const facts = (ask: ApprovalAsk) => Object.fromEntries(ask.summary.facts.map((f) => [f.label, f.value]));

it("lines up names, definitions and handlers", () => {
  expect(DB_CONNECTION_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...DB_CONNECTION_TOOLS]);
  expect(Object.keys(createDbConnectionToolHandlers({ projectRoots: () => [] }))).toEqual([...DB_CONNECTION_TOOLS]);
});

describe("db_connection_save", () => {
  it("adds a read-only connection, available to the AI, without ever sending readonly", async () => {
    const h = harness();
    const r = await h.run("db_connection_save", { name: "shop", type: "postgres", url: "postgres://app@db.example.com:5432/shop", group: "work" });
    expect(r.error).toBe(false);
    expect(r.json).toMatchObject({ outcome: "created", name: "shop", readonly: true, availableToAi: true });
    expect(h.asks).toHaveLength(1);
    expect(facts(h.asks[0]!)).toMatchObject({
      URL: "postgres://app@db.example.com:5432/shop", "Read-only": "Yes — the AI can only read; switch it off in PPM to allow writes",
    });
    for (const w of h.writes) expect(w).not.toMatch(/readonly|aiAccess/);
    expect(getConnectionById(r.json.id)).toMatchObject({ readonly: 1, ai_access: 1, group_name: "work" });
    expect(h.announced).toEqual(["POST"]);
  });

  it("refuses a URL holding a password before asking anyone", async () => {
    const h = harness();
    for (const url of [`postgres://app:${SECRET}@db/shop`, `postgres://app@db/shop?password=${SECRET}`]) {
      const r = await h.run("db_connection_save", { name: "x", type: "postgres", url });
      expect(r.error).toBe(true);
      expect(r.text).toContain("passwordMode");
    }
    expect([h.asks.length, h.writes.length]).toEqual([0, 0]);
  });

  it("shows a SQLite file by its real path, saves that path, and refuses a link to PPM's database", async () => {
    const real = sqliteFile(join(root, "data", "app.db"));
    const link = join(root, "repo", "app.db");
    mkdirSync(join(root, "repo"));
    symlinkSync(real, link);
    const h = harness();
    const r = await h.run("db_connection_save", { name: "app", type: "sqlite", file: link });
    expect(r.error).toBe(false);
    expect(facts(h.asks[0]!).File).toBe(real);
    expect(h.writes[0]).toContain(JSON.stringify(real).slice(1, -1));

    const ppmDb = sqliteFile(join(getPpmDir(), "ppm.db"));
    symlinkSync(ppmDb, join(root, "repo", "sneaky.db"));
    const cookies = sqliteFile(join(root, "home", ".mozilla", "firefox", "p.default", "cookies.sqlite"));
    for (const file of [join(root, "repo", "sneaky.db"), cookies]) {
      const refused = await h.run("db_connection_save", { name: `n-${file.length}`, type: "sqlite", file });
      expect({ file, error: refused.error, text: refused.text }).toMatchObject({ file, error: true, text: expect.stringContaining("protected location") });
    }
    expect(h.asks).toHaveLength(1);
  });

  it("does nothing when the user declines, or when the name was taken while the card waited", async () => {
    const declined = harness({ verdict: { verdict: "denied", reason: "no" } });
    expect((await declined.run("db_connection_save", { name: "a", type: "postgres", url: "postgres://app@h/db" })).text).toContain("declined");
    const raced = harness({ onAsk: () => insertConnection("postgres", "b", { type: "postgres", connectionString: "postgres://x@h/db" }) });
    const r = await raced.run("db_connection_save", { name: "b", type: "postgres", url: "postgres://app@h/db" });
    expect(r).toMatchObject({ error: true, text: expect.stringContaining("Not added") });
    expect([declined.writes.length, raced.writes.length]).toEqual([0, 0]);
  });

  it("edits a connection, keeping what the form set, and refuses to move one with a saved password", async () => {
    const plain = insertConnection("postgres", "plain", { type: "postgres", connectionString: "postgres://app@a.example.com/shop", passwordMode: "askPassword", queryTimeoutSec: 30 });
    const h = harness();
    const r = await h.run("db_connection_save", { id: plain.id, url: "postgres://app@b.example.com/shop", name: "plain-2" });
    expect(r.json).toMatchObject({ outcome: "updated", name: "plain-2" });
    expect(facts(h.asks[0]!)).toMatchObject({ "Now: URL": "postgres://app@a.example.com/shop", "New URL": "postgres://app@b.example.com/shop", "Read-only": "Yes" });
    const { decryptConfig } = await import("../../../../src/services/db.service.ts");
    expect(decryptConfig(getConnectionById(plain.id)!.connection_config)).toEqual({
      type: "postgres", connectionString: "postgres://app@b.example.com/shop", passwordMode: "askPassword", queryTimeoutSec: 30,
    });
    for (const w of h.writes) expect(w).not.toMatch(/readonly|aiAccess/);

    const saved = insertConnection("postgres", "saved", { type: "postgres", connectionString: `postgres://app:${SECRET}@a.example.com/shop` });
    const moved = await h.run("db_connection_save", { id: saved.id, url: "postgres://app@evil.example.com/shop" });
    expect(moved).toMatchObject({ error: true, text: expect.stringContaining("re-enters the password in PPM") });
    // The same server, another database: allowed, and the password stays.
    expect((await h.run("db_connection_save", { id: saved.id, url: "postgres://app@a.example.com/other" })).error).toBe(false);
    expect(decryptConfig(getConnectionById(saved.id)!.connection_config).connectionString).toContain(SECRET);
  });

  it("touches no connection hidden from the AI, and nothing that changed while the card waited", async () => {
    const hidden = insertConnection("postgres", "hidden", { type: "postgres", connectionString: "postgres://app@h/db" });
    updateConnection(hidden.id, { aiAccess: 0 });
    const h = harness();
    expect((await h.run("db_connection_save", { id: hidden.id, name: "x" })).text).toContain("not available to the AI chat");
    const shown = insertConnection("postgres", "shown", { type: "postgres", connectionString: "postgres://app@h/db" });
    const raced = harness({ onAsk: () => updateConnection(shown.id, { name: "renamed" }) });
    expect((await raced.run("db_connection_save", { id: shown.id, color: "#ff0000" })).text).toContain("changed while the card waited");
    expect(getConnectionById(shown.id)!.color).toBeNull();
  });
});

describe("db_connection_delete", () => {
  it("asks with what PPM lists, re-checks, then deletes", async () => {
    const conn = insertConnection("postgres", "old", { type: "postgres", connectionString: `postgres://app:${SECRET}@db.example.com/shop` }, "work");
    const h = harness();
    const r = await h.run("db_connection_delete", { id: conn.id });
    expect(r.json).toMatchObject({ outcome: "deleted", name: "old" });
    expect(h.asks[0]!.summary).toMatchObject({ headline: 'Delete the connection "old" from PPM', warning: expect.stringContaining("not touched") });
    expect(JSON.stringify(h.asks[0])).not.toContain(SECRET);
    expect(getConnectionById(conn.id)).toBeNull();

    const other = insertConnection("postgres", "keep", { type: "postgres", connectionString: "postgres://app@h/db" });
    const raced = harness({ onAsk: () => updateConnection(other.id, { name: "keep-renamed" }) });
    expect((await raced.run("db_connection_delete", { id: other.id })).text).toContain("Not deleted");
    expect(getConnectionById(other.id)).not.toBeNull();
  });
});

describe("db_connection_test", () => {
  it("says where it went, and runs at most ten a minute from one chat", async () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    const pg = insertConnection("postgres", "closed", { type: "postgres", connectionString: "postgres://app@127.0.0.1:1/shop" });
    const first = await h.run("db_connection_test", { id: pg.id });
    expect(first.json).toMatchObject({ connection: "closed", ok: false, host: "127.0.0.1:1" });
    expect(h.asks).toHaveLength(0);

    const file = insertConnection("sqlite", "file", { type: "sqlite", path: sqliteFile(join(root, "t.db")) });
    for (let i = 1; i < 10; i++) expect((await h.run("db_connection_test", { id: file.id })).json).toMatchObject({ ok: true });
    expect((await h.run("db_connection_test", { id: file.id })).text).toContain("at most 10");
    now += 61_000;
    const again = await h.run("db_connection_test", { id: file.id });
    expect(again.json).toMatchObject({ ok: true });
    expect(again.json.host).toBeUndefined();
  }, 30_000);
});
