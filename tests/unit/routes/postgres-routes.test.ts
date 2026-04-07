import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { postgresRoutes } from "../../../src/server/routes/postgres.ts";

function createApp() {
  return new Hono().route("/postgres", postgresRoutes);
}

beforeEach(() => {
  setDb(openTestDb());
});

describe("POST /postgres/test — input validation", () => {
  it("rejects missing connectionString", async () => {
    const app = createApp();
    const res = await app.request("/postgres/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("connectionString");
  });

  it("rejects empty connectionString", async () => {
    const app = createApp();
    const res = await app.request("/postgres/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionString: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /postgres/tables — input validation", () => {
  it("rejects missing connectionString", async () => {
    const app = createApp();
    const res = await app.request("/postgres/tables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects empty connectionString", async () => {
    const app = createApp();
    const res = await app.request("/postgres/tables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionString: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /postgres/schema — input validation", () => {
  it("rejects missing connectionString", async () => {
    const app = createApp();
    const res = await app.request("/postgres/schema", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects missing table", async () => {
    const app = createApp();
    const res = await app.request("/postgres/schema", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionString: "postgres://localhost" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects both missing connectionString and table", async () => {
    const app = createApp();
    const res = await app.request("/postgres/schema", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("accepts optional schema parameter", async () => {
    const app = createApp();
    // Returns 500 due to service error, not validation
    const res = await app.request("/postgres/schema", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionString: "postgres://invalid",
        table: "users",
        schema: "public",
      }),
    });
    expect(res.status).toBe(500);
  });
});

describe("POST /postgres/data — input validation", () => {
  it("rejects missing connectionString", async () => {
    const app = createApp();
    const res = await app.request("/postgres/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing table", async () => {
    const app = createApp();
    const res = await app.request("/postgres/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionString: "postgres://localhost" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts optional pagination and sort params", async () => {
    const app = createApp();
    // Returns 500 due to service error, not validation
    const res = await app.request("/postgres/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionString: "postgres://invalid",
        table: "users",
        schema: "public",
        page: 2,
        limit: 50,
        orderBy: "id",
        orderDir: "DESC",
      }),
    });
    expect(res.status).toBe(500);
  });
});

describe("POST /postgres/query — input validation", () => {
  it("rejects missing connectionString", async () => {
    const app = createApp();
    const res = await app.request("/postgres/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects missing sql", async () => {
    const app = createApp();
    const res = await app.request("/postgres/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionString: "postgres://localhost" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty connectionString", async () => {
    const app = createApp();
    const res = await app.request("/postgres/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionString: "", sql: "SELECT 1" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty sql", async () => {
    const app = createApp();
    const res = await app.request("/postgres/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionString: "postgres://localhost", sql: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /postgres/cell — input validation", () => {
  it("rejects missing connectionString", async () => {
    const app = createApp();
    const res = await app.request("/postgres/cell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: "users",
        pkColumn: "id",
        pkValue: 1,
        column: "name",
        value: "John",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing table", async () => {
    const app = createApp();
    const res = await app.request("/postgres/cell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionString: "postgres://localhost",
        pkColumn: "id",
        pkValue: 1,
        column: "name",
        value: "John",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing pkColumn", async () => {
    const app = createApp();
    const res = await app.request("/postgres/cell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionString: "postgres://localhost",
        table: "users",
        pkValue: 1,
        column: "name",
        value: "John",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing column", async () => {
    const app = createApp();
    const res = await app.request("/postgres/cell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionString: "postgres://localhost",
        table: "users",
        pkColumn: "id",
        pkValue: 1,
        value: "John",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts optional schema parameter", async () => {
    const app = createApp();
    // Returns 500 due to service error, not validation
    const res = await app.request("/postgres/cell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionString: "postgres://invalid",
        table: "users",
        schema: "public",
        pkColumn: "id",
        pkValue: 1,
        column: "name",
        value: "John",
      }),
    });
    expect(res.status).toBe(500);
  });

  it("accepts null value (valid update)", async () => {
    const app = createApp();
    // Returns 500 due to service error, not validation
    const res = await app.request("/postgres/cell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionString: "postgres://invalid",
        table: "users",
        pkColumn: "id",
        pkValue: 1,
        column: "name",
        value: null,
      }),
    });
    expect(res.status).toBe(500);
  });
});
