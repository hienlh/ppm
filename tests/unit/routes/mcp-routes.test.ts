import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { mcpRoutes } from "../../../src/server/routes/mcp.ts";
import { mcpConfigService } from "../../../src/services/mcp-config.service.ts";

function createApp() {
  return new Hono().route("/mcp", mcpRoutes);
}

beforeEach(() => {
  const db = openTestDb();
  setDb(db);
  // Use explicit DB for mcp service in tests
  (global as any).mcpConfigService = new (require("../../../src/services/mcp-config.service.ts").McpConfigService)(db);
});

describe("GET /mcp", () => {
  it("returns empty array initially", async () => {
    const app = createApp();
    const res = await app.request("/mcp");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
  });

  it("lists added servers", async () => {
    const app = createApp();

    // Add a server
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-server",
        config: { command: "npx", args: ["-y", "test"] },
      }),
    });

    // List
    const res = await app.request("/mcp");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.length).toBe(1);
    expect(json.data[0].name).toBe("test-server");
  });
});

describe("POST /mcp", () => {
  it("adds server with valid name and config", async () => {
    const app = createApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "my-server",
        config: { command: "npx", args: ["-y", "some-server"] },
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe("my-server");
  });

  it("rejects invalid name (starts with hyphen)", async () => {
    const app = createApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "-invalid",
        config: { command: "npx", args: ["-y", "test"] },
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects invalid name (spaces)", async () => {
    const app = createApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "invalid name",
        config: { command: "npx", args: ["-y", "test"] },
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects invalid config (missing command)", async () => {
    const app = createApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-config",
        config: { args: ["-y", "test"] },
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("rejects duplicate name with 409", async () => {
    const app = createApp();

    // Add first server
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "duplicate",
        config: { command: "npx", args: ["-y", "first"] },
      }),
    });

    // Try to add duplicate
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "duplicate",
        config: { command: "npx", args: ["-y", "second"] },
      }),
    });

    expect(res.status).toBe(409);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("already exists");
  });
});

describe("GET /mcp/:name", () => {
  it("returns server config", async () => {
    const app = createApp();

    // Add server
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-server",
        config: { command: "npx", args: ["-y", "test"] },
      }),
    });

    // Get
    const res = await app.request("/mcp/test-server");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.command).toBe("npx");
    expect(json.data.args[0]).toBe("-y");
  });

  it("returns 404 for nonexistent server", async () => {
    const app = createApp();
    const res = await app.request("/mcp/nonexistent");
    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});

describe("PUT /mcp/:name", () => {
  it("updates server config", async () => {
    const app = createApp();

    // Add server
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "to-update",
        config: { command: "npx", args: ["-y", "old"] },
      }),
    });

    // Update
    const res = await app.request("/mcp/to-update", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "node",
        args: ["./server.js"],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe("to-update");
  });

  it("rejects invalid config in update", async () => {
    const app = createApp();

    // Add server
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "to-update",
        config: { command: "npx", args: ["-y", "test"] },
      }),
    });

    // Try invalid update (missing command)
    const res = await app.request("/mcp/to-update", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: ["--only-args"],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });

  it("returns 404 for nonexistent server", async () => {
    const app = createApp();
    const res = await app.request("/mcp/nonexistent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "npx",
        args: ["-y", "test"],
      }),
    });

    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});

describe("DELETE /mcp/:name", () => {
  it("removes server", async () => {
    const app = createApp();

    // Add server
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "to-delete",
        config: { command: "npx", args: ["-y", "test"] },
      }),
    });

    // Delete
    const res = await app.request("/mcp/to-delete", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);

    // Verify deleted
    const getRes = await app.request("/mcp/to-delete");
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for nonexistent server", async () => {
    const app = createApp();
    const res = await app.request("/mcp/nonexistent", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const json = await res.json() as any;
    expect(json.ok).toBe(false);
  });
});
