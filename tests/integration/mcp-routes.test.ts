import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { openTestDb } from "../../src/services/db.service";
import { McpConfigService } from "../../src/services/mcp-config.service";
import { validateMcpName, validateMcpConfig, type McpServerConfig } from "../../src/types/mcp";
import { ok, err } from "../../src/types/api";

/**
 * Integration tests for MCP routes.
 *
 * Creates custom routes pointing to a test service instance to avoid
 * global singleton DB issues during testing.
 */

describe("MCP Routes Integration", () => {
  let testDb: Database;
  let testService: McpConfigService;

  beforeEach(() => {
    testDb = openTestDb();
    testService = new McpConfigService(testDb);
  });

  function createApp() {
    // Create Hono app with test service instance
    const app = new Hono();

    app.get("/api/settings/mcp", (c) => {
      let servers = testService.listWithMeta();
      if (servers.length === 0) {
        // Skip auto-import in tests
      }
      return c.json(ok(servers));
    });

    app.get("/api/settings/mcp/:name", (c) => {
      const config = testService.get(c.req.param("name"));
      if (!config) return c.json(err("Server not found"), 404);
      return c.json(ok(config));
    });

    app.post("/api/settings/mcp", async (c) => {
      const { name, config } = await c.req.json();
      const nameErr = validateMcpName(name);
      if (nameErr) return c.json(err(nameErr), 400);
      const configErrs = validateMcpConfig(config);
      if (configErrs.length) return c.json(err(configErrs.join("; ")), 400);
      if (testService.exists(name)) return c.json(err("Server already exists"), 409);
      testService.set(name, config);
      return c.json(ok({ name }), 201);
    });

    app.put("/api/settings/mcp/:name", async (c) => {
      const name = c.req.param("name");
      if (!testService.exists(name)) return c.json(err("Server not found"), 404);
      const config = await c.req.json();
      const configErrs = validateMcpConfig(config);
      if (configErrs.length) return c.json(err(configErrs.join("; ")), 400);
      testService.set(name, config);
      return c.json(ok({ name }));
    });

    app.delete("/api/settings/mcp/:name", (c) => {
      const removed = testService.remove(c.req.param("name"));
      if (!removed) return c.json(err("Server not found"), 404);
      return c.json(ok(true));
    });

    return app;
  }

  describe("GET / — list servers", () => {
    it("returns empty array when no servers", async () => {
      const app = createApp();
      const res = await app.request("/api/settings/mcp", { method: "GET" });
      expect(res.status).toBe(200);

      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it("returns list of servers with metadata", async () => {
      const app = createApp();
      // Manually add a server using the test DB
      const config: McpServerConfig = { type: "stdio", command: "python3" };
      const query = testDb.query(`
        INSERT INTO mcp_servers (name, transport, config, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `);
      query.run("test-server", "stdio", JSON.stringify(config));

      const res = await app.request("/api/settings/mcp", { method: "GET" });
      expect(res.status).toBe(200);

      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].name).toBe("test-server");
      expect(json.data[0].transport).toBe("stdio");
      expect(json.data[0].config).toEqual(config);
      expect(json.data[0].createdAt).toBeDefined();
      expect(json.data[0].updatedAt).toBeDefined();
    });
  });

  describe("POST / — create server (happy path)", () => {
    it("creates a new stdio server", async () => {
      const app = createApp();
      const config: McpServerConfig = {
        type: "stdio",
        command: "python3",
        args: ["-m", "mcp.server"],
      };

      const res = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-server", config }),
      });

      expect(res.status).toBe(201);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe("new-server");

      // Verify in DB
      const row = testDb.query(
        "SELECT config FROM mcp_servers WHERE name = ?",
      ).get("new-server") as { config: string } | null;
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.config)).toEqual(config);
    });

    it("creates server with http transport", async () => {
      const app = createApp();
      const config: McpServerConfig = {
        type: "http",
        url: "http://localhost:3000",
        headers: { "Authorization": "Bearer token" },
      };

      const res = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "http-server", config }),
      });

      expect(res.status).toBe(201);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);

      const row = testDb.query(
        "SELECT transport FROM mcp_servers WHERE name = ?",
      ).get("http-server") as { transport: string } | null;
      expect(row!.transport).toBe("http");
    });
  });

  describe("POST / — create server (validation errors)", () => {
    it("rejects invalid name (empty)", async () => {
      const app = createApp();
      const config: McpServerConfig = { type: "stdio", command: "cmd" };

      const res = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", config }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.ok).toBe(false);
      expect(json.error).toContain("Name must start");
    });

    it("rejects invalid name (spaces)", async () => {
      const app = createApp();
      const config: McpServerConfig = { type: "stdio", command: "cmd" };

      const res = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "my server", config }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.ok).toBe(false);
    });

    it("rejects invalid config (missing command for stdio)", async () => {
      const app = createApp();
      const config = { type: "stdio" };

      const res = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test", config }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.ok).toBe(false);
      expect(json.error).toContain("command");
    });

    it("rejects invalid config (missing url for http)", async () => {
      const app = createApp();
      const config = { type: "http" };

      const res = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test", config }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.ok).toBe(false);
      expect(json.error).toContain("url");
    });

    it("rejects invalid config (bad url format)", async () => {
      const app = createApp();
      const config = { type: "http", url: "not-a-url" };

      const res = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test", config }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error).toContain("HTTP");
    });
  });

  describe("POST / — duplicate name", () => {
    it("rejects POST with duplicate name (409)", async () => {
      const app = createApp();
      const config: McpServerConfig = { type: "stdio", command: "cmd" };

      // Create first server
      const res1 = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "duplicate", config }),
      });
      expect(res1.status).toBe(201);

      // Try to create with same name
      const res2 = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "duplicate", config }),
      });

      expect(res2.status).toBe(409);
      const json = await res2.json() as any;
      expect(json.ok).toBe(false);
      expect(json.error).toContain("already exists");
    });
  });

  describe("GET /:name — retrieve single server", () => {
    it("returns server config", async () => {
      const app = createApp();
      const config: McpServerConfig = { type: "stdio", command: "python3" };
      const query = testDb.query(`
        INSERT INTO mcp_servers (name, transport, config, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `);
      query.run("test-server", "stdio", JSON.stringify(config));

      const res = await app.request("/api/settings/mcp/test-server", { method: "GET" });
      expect(res.status).toBe(200);

      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.data).toEqual(config);
    });

    it("returns 404 for nonexistent server", async () => {
      const app = createApp();
      const res = await app.request("/api/settings/mcp/nonexistent", { method: "GET" });
      expect(res.status).toBe(404);

      const json = await res.json() as any;
      expect(json.ok).toBe(false);
      expect(json.error).toContain("not found");
    });
  });

  describe("PUT /:name — update server", () => {
    it("updates existing server config", async () => {
      const app = createApp();
      // Create initial server
      const config1: McpServerConfig = { type: "stdio", command: "python3" };
      const query = testDb.query(`
        INSERT INTO mcp_servers (name, transport, config, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `);
      query.run("test-server", "stdio", JSON.stringify(config1));

      // Update via API
      const config2: McpServerConfig = { type: "http", url: "http://localhost:3000" };
      const res = await app.request("/api/settings/mcp/test-server", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config2),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe("test-server");

      // Verify in DB
      const row = testDb.query(
        "SELECT config, transport FROM mcp_servers WHERE name = ?",
      ).get("test-server") as { config: string; transport: string } | null;
      expect(JSON.parse(row!.config)).toEqual(config2);
      expect(row!.transport).toBe("http");
    });

    it("rejects update with invalid config (404 nonexistent)", async () => {
      const app = createApp();
      const config: McpServerConfig = { type: "stdio", command: "cmd" };

      const res = await app.request("/api/settings/mcp/nonexistent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain("not found");
    });

    it("rejects update with validation error", async () => {
      const app = createApp();
      // Create server
      const config1: McpServerConfig = { type: "stdio", command: "cmd" };
      const query = testDb.query(`
        INSERT INTO mcp_servers (name, transport, config, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `);
      query.run("test-server", "stdio", JSON.stringify(config1));

      // Try invalid update
      const invalidConfig = { type: "http" }; // missing url

      const res = await app.request("/api/settings/mcp/test-server", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invalidConfig),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.ok).toBe(false);
      expect(json.error).toContain("url");
    });
  });

  describe("DELETE /:name — remove server", () => {
    it("deletes existing server", async () => {
      const app = createApp();
      // Create server
      const config: McpServerConfig = { type: "stdio", command: "cmd" };
      const query = testDb.query(`
        INSERT INTO mcp_servers (name, transport, config, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `);
      query.run("test-server", "stdio", JSON.stringify(config));

      const res = await app.request("/api/settings/mcp/test-server", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.data).toBe(true);

      // Verify deleted from DB
      const row = testDb.query(
        "SELECT 1 FROM mcp_servers WHERE name = ?",
      ).get("test-server");
      expect(row).toBeNull();
    });

    it("returns 404 for nonexistent server", async () => {
      const app = createApp();
      const res = await app.request("/api/settings/mcp/nonexistent", {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain("not found");
    });
  });

  describe("Full CRUD flow", () => {
    it("POST → GET (list) → PUT → DELETE → GET (verify gone)", async () => {
      const app = createApp();
      const config1: McpServerConfig = {
        type: "stdio",
        command: "python3",
        args: ["-m", "mcp.server"],
      };

      // 1. Create
      const createRes = await app.request("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "flow-test", config: config1 }),
      });
      expect(createRes.status).toBe(201);

      // 2. List (verify present)
      const listRes = await app.request("/api/settings/mcp", { method: "GET" });
      let listJson = await listRes.json() as any;
      expect(listJson.data).toHaveLength(1);
      expect(listJson.data[0].name).toBe("flow-test");

      // 3. Update
      const config2: McpServerConfig = { type: "http", url: "http://localhost:3000" };
      const updateRes = await app.request("/api/settings/mcp/flow-test", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config2),
      });
      expect(updateRes.status).toBe(200);

      // 4. Delete
      const deleteRes = await app.request("/api/settings/mcp/flow-test", {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);

      // 5. Verify gone from list
      const listRes2 = await app.request("/api/settings/mcp", { method: "GET" });
      listJson = await listRes2.json() as any;
      expect(listJson.data).toHaveLength(0);
    });
  });
});
