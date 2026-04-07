import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { sqliteRoutes } from "../../../src/server/routes/sqlite.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

function createApp() {
  const app = new Hono<Env>();
  app.use("/*", async (c, next) => {
    c.set("projectPath", "/tmp");
    c.set("projectName", "test-project");
    await next();
  });
  app.route("/sqlite", sqliteRoutes);
  return app;
}

beforeEach(() => {
  setDb(openTestDb());
});

describe("GET /sqlite/tables — query validation", () => {
  it("rejects missing path query param", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/tables");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  });

  it("returns 500 with invalid path (service error)", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/tables?path=nonexistent.db");
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});

describe("GET /sqlite/schema — query validation", () => {
  it("rejects missing path query param", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/schema?table=users");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects missing table query param", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/schema?path=test.db");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects missing both path and table", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/schema");
    expect(res.status).toBe(400);
  });
});

describe("GET /sqlite/data — query validation", () => {
  it("rejects missing path query param", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/data?table=users");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects missing table query param", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/data?path=test.db");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("accepts optional pagination params", async () => {
    const app = createApp();
    // Returns 500 due to service error (db doesn't exist), not validation
    const res = await app.request("/sqlite/data?path=test.db&table=users&page=2&limit=50&orderBy=id&orderDir=DESC");
    expect(res.status).toBe(500);
  });
});

describe("POST /sqlite/query — body validation", () => {
  it("rejects missing path field", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT * FROM users" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects missing sql field", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "test.db" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects empty path", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "", sql: "SELECT 1" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty sql", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "test.db", sql: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /sqlite/cell — body validation", () => {
  it("rejects missing path field", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/cell", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", rowid: 1, column: "name", value: "John" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects missing table field", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/cell", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "test.db", rowid: 1, column: "name", value: "John" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing rowid field", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/cell", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "test.db", table: "users", column: "name", value: "John" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing column field", async () => {
    const app = createApp();
    const res = await app.request("/sqlite/cell", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "test.db", table: "users", rowid: 1, value: "John" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts rowid as 0 (valid row id)", async () => {
    const app = createApp();
    // Returns 500 due to service error, not validation
    const res = await app.request("/sqlite/cell", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "test.db", table: "users", rowid: 0, column: "name", value: "John" }),
    });
    expect(res.status).toBe(500);
  });

  it("accepts null value (valid update)", async () => {
    const app = createApp();
    // Returns 500 due to service error, not validation
    const res = await app.request("/sqlite/cell", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "test.db", table: "users", rowid: 1, column: "name", value: null }),
    });
    expect(res.status).toBe(500);
  });
});
