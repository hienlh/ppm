import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";

function createApp() {
  return new Hono().route("/db", databaseRoutes);
}

beforeEach(() => {
  setDb(openTestDb());
});

describe("GET /db/connections", () => {
  it("returns empty array initially", async () => {
    const app = createApp();
    const res = await app.request("/db/connections");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("lists added connections without sensitive config", async () => {
    const app = createApp();

    // Add a connection
    await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "test-db",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });

    // List
    const res = await app.request("/db/connections");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.length).toBe(1);
    expect(json.data[0].name).toBe("test-db");
    // connection_config should be stripped
    expect(json.data[0].connection_config).toBeUndefined();
  });
});

describe("POST /db/connections", () => {
  it("creates a SQLite connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "my-sqlite",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe("my-sqlite");
    expect(json.data.type).toBe("sqlite");
  });

  it("creates a PostgreSQL connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "postgres",
        name: "my-pg",
        connectionConfig: { type: "postgres", connectionString: "postgresql://localhost" },
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.type).toBe("postgres");
  });

  it("rejects missing type with 400", async () => {
    const app = createApp();
    const res = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "no-type",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects missing name with 400", async () => {
    const app = createApp();
    const res = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects missing connectionConfig with 400", async () => {
    const app = createApp();
    const res = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "no-config",
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects invalid type with 400", async () => {
    const app = createApp();
    const res = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "mongodb",
        name: "invalid-type",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("sqlite or postgres");
  });

  it("rejects invalid hex color with 400", async () => {
    const app = createApp();
    const res = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "bad-color",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
        color: "not-a-hex",
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("hex color");
  });

  it("accepts valid hex colors", async () => {
    const app = createApp();
    const res = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "colored",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
        color: "#3b82f6",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.data.color).toBe("#3b82f6");
  });

  it("accepts short hex colors", async () => {
    const app = createApp();
    const res = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "short-hex",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
        color: "#abc",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.data.color).toBe("#abc");
  });
});

describe("GET /db/connections/:id", () => {
  it("returns connection by id", async () => {
    const app = createApp();

    // Create
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "test-conn",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = await createRes.json() as any;
    const id = created.data.id;

    // Get
    const res = await app.request(`/db/connections/${id}`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe("test-conn");
  });

  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999");
    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});

describe("PUT /db/connections/:id", () => {
  it("updates connection name", async () => {
    const app = createApp();

    // Create
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "original",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = await createRes.json() as any;
    const id = created.data.id;

    // Update
    const res = await app.request(`/db/connections/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe("renamed");
  });

  it("updates connection color", async () => {
    const app = createApp();

    // Create
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "test",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = await createRes.json() as any;
    const id = created.data.id;

    // Update color
    const res = await app.request(`/db/connections/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#ff0000" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.data.color).toBe("#ff0000");
  });

  it("rejects invalid hex color in update", async () => {
    const app = createApp();

    // Create
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "test",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = await createRes.json() as any;
    const id = created.data.id;

    // Try invalid color
    const res = await app.request(`/db/connections/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "invalid" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});

describe("DELETE /db/connections/:id", () => {
  it("deletes connection by id", async () => {
    const app = createApp();

    // Create
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "to-delete",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = await createRes.json() as any;
    const id = created.data.id;

    // Delete
    const res = await app.request(`/db/connections/${id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);

    // Verify deleted
    const getRes = await app.request(`/db/connections/${id}`);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});

describe("GET /db/connections/export", () => {
  it("exports connections with config", async () => {
    const app = createApp();

    // Create a connection
    await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "export-me",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });

    // Export
    const res = await app.request("/db/connections/export");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.version).toBe(1);
    expect(json.data.exported_at).toBeDefined();
    expect(Array.isArray(json.data.connections)).toBe(true);
    expect(json.data.connections[0].name).toBe("export-me");
  });
});

describe("POST /db/connections/import", () => {
  it("imports connections from exported format", async () => {
    const app = createApp();

    const res = await app.request("/db/connections/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connections: [
          {
            type: "sqlite",
            name: "imported-db",
            connection_config: JSON.stringify({ type: "sqlite", path: "/tmp/test.db" }),
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.imported).toBe(1);
    expect(json.data.connections[0].name).toBe("imported-db");
  });

  it("deduplicates imported connection names", async () => {
    const app = createApp();

    // Create original
    await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "my-db",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });

    // Import with same name
    const res = await app.request("/db/connections/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connections: [
          {
            type: "sqlite",
            name: "my-db",
            connection_config: JSON.stringify({ type: "sqlite", path: "/tmp/other.db" }),
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.imported).toBe(1);
    // Name should be deduplicated
    expect(json.data.connections[0].name).toBe("my-db (2)");
  });

  it("skips invalid entries during import", async () => {
    const app = createApp();

    const res = await app.request("/db/connections/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connections: [
          {
            type: "sqlite",
            name: "valid",
            connection_config: JSON.stringify({ type: "sqlite", path: "/tmp/test.db" }),
          },
          {
            type: "sqlite",
            name: "missing-config",
            // Missing connection_config
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.imported).toBe(1);
    expect(json.data.skipped).toBeGreaterThan(0);
  });
});

describe("PUT /db/connections/:id — readonly toggle", () => {
  it("toggles readonly off and on", async () => {
    const app = createApp();

    // Create (default readonly=1)
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "ro-test",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;
    expect(created.readonly).toBe(1);

    // Toggle to writable
    const res = await app.request(`/db/connections/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readonly: 0 }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json() as any).data;
    expect(json.readonly).toBe(0);

    // Toggle back to readonly
    const res2 = await app.request(`/db/connections/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readonly: 1 }),
    });
    expect(res2.status).toBe(200);
    const json2 = (await res2.json() as any).data;
    expect(json2.readonly).toBe(1);
  });

  it("updates group name and clears it with null", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "group-test",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
        groupName: "initial-group",
      }),
    });
    const created = (await createRes.json() as any).data;
    expect(created.group_name).toBe("initial-group");

    // Clear group
    const res = await app.request(`/db/connections/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupName: null }),
    });
    const json = (await res.json() as any).data;
    expect(json.group_name).toBeNull();
  });
});

describe("PUT /db/connections/:id/cell — readonly enforcement", () => {
  it("blocks cell edit on readonly connection", async () => {
    const app = createApp();

    // Create readonly connection (default)
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "ro-cell",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;

    // Try cell edit
    const res = await app.request(`/db/connections/${created.id}/cell`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: "users",
        pkColumn: "id",
        pkValue: 1,
        column: "name",
        value: "test",
      }),
    });
    expect(res.status).toBe(403);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("readonly");
  });

  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/cell", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table: "users",
        pkColumn: "id",
        pkValue: 1,
        column: "name",
        value: "test",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for missing required fields", async () => {
    const app = createApp();

    // Create writable connection
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "rw-cell",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;
    // Toggle writable
    await app.request(`/db/connections/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readonly: 0 }),
    });

    // Missing table
    const res = await app.request(`/db/connections/${created.id}/cell`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pkColumn: "id", pkValue: 1, column: "name", value: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /db/connections/:id/row — readonly enforcement", () => {
  it("blocks row delete on readonly connection", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "ro-row",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;

    const res = await app.request(`/db/connections/${created.id}/row`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", pkColumn: "id", pkValue: 1 }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toContain("readonly");
  });

  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/row", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", pkColumn: "id", pkValue: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for missing pkValue", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "rw-row",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;
    await app.request(`/db/connections/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readonly: 0 }),
    });

    const res = await app.request(`/db/connections/${created.id}/row`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", pkColumn: "id" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /db/connections/:id/rows/delete — bulk delete readonly", () => {
  it("blocks bulk delete on readonly connection", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "ro-bulk",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;

    const res = await app.request(`/db/connections/${created.id}/rows/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", pkColumn: "id", pkValues: [1, 2] }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for empty pkValues", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "rw-bulk",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;
    await app.request(`/db/connections/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readonly: 0 }),
    });

    const res = await app.request(`/db/connections/${created.id}/rows/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", pkColumn: "id", pkValues: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/rows/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", pkColumn: "id", pkValues: [1] }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /db/connections/:id/row — insert readonly", () => {
  it("blocks insert on readonly connection", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "ro-insert",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;

    const res = await app.request(`/db/connections/${created.id}/row`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", values: { name: "test" } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toContain("readonly");
  });

  it("returns 400 for empty values", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "rw-insert",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;
    await app.request(`/db/connections/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readonly: 0 }),
    });

    const res = await app.request(`/db/connections/${created.id}/row`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", values: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/row", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "users", values: { name: "test" } }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /db/connections/:id/query — readonly enforcement", () => {
  it("blocks write query on readonly connection", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "ro-query",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;

    const res = await app.request(`/db/connections/${created.id}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "DELETE FROM users WHERE id = 1" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toContain("readonly");
  });

  it("returns 400 for missing sql", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "query-no-sql",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;

    const res = await app.request(`/db/connections/${created.id}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /db/test — raw connection test", () => {
  it("returns 400 for missing fields", async () => {
    const app = createApp();
    const res = await app.request("/db/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /db/connections/:id/test", () => {
  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/test", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /db/connections/:id/tables", () => {
  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/tables");
    expect(res.status).toBe(404);
  });
});

describe("GET /db/connections/:id/schema", () => {
  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/schema?table=users");
    expect(res.status).toBe(404);
  });

  it("returns 400 for missing table param", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "schema-test",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;

    const res = await app.request(`/db/connections/${created.id}/schema`);
    expect(res.status).toBe(400);
  });
});

describe("GET /db/connections/:id/data", () => {
  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/data?table=users");
    expect(res.status).toBe(404);
  });

  it("returns 400 for missing table param", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "data-test",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;

    const res = await app.request(`/db/connections/${created.id}/data`);
    expect(res.status).toBe(400);
  });
});

describe("GET /db/connections/:id/export", () => {
  it("returns 404 for nonexistent connection", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/999/export?table=users");
    expect(res.status).toBe(404);
  });

  it("returns 400 for missing table param", async () => {
    const app = createApp();
    const createRes = await app.request("/db/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sqlite",
        name: "export-test",
        connectionConfig: { type: "sqlite", path: "/tmp/test.db" },
      }),
    });
    const created = (await createRes.json() as any).data;

    const res = await app.request(`/db/connections/${created.id}/export`);
    expect(res.status).toBe(400);
  });
});

describe("POST /db/connections/import — edge cases", () => {
  it("rejects non-array connections", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connections: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });

  it("skips entries with invalid type", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connections: [
          { type: "mongodb", name: "bad-type", connection_config: JSON.stringify({ type: "mongodb" }) },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json() as any).data;
    expect(json.imported).toBe(0);
    expect(json.skipped).toBe(1);
  });

  it("skips entries with invalid JSON in connection_config", async () => {
    const app = createApp();
    const res = await app.request("/db/connections/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connections: [
          { type: "sqlite", name: "bad-json", connection_config: "not-json{" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json() as any).data;
    expect(json.imported).toBe(0);
    expect(json.skipped).toBe(1);
  });
});

describe("GET /db/search", () => {
  it("returns empty for no query", async () => {
    const app = createApp();
    const res = await app.request("/db/search");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("returns empty for no matches", async () => {
    const app = createApp();
    const res = await app.request("/db/search?q=nomatch");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data).toEqual([]);
  });
});
