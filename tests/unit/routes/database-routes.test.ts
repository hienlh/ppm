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
