import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { McpConfigService } from "../../src/services/mcp-config.service";
import { openTestDb } from "../../src/services/db.service";
import { validateMcpName, validateMcpConfig, type McpServerConfig } from "../../src/types/mcp";

describe("McpConfigService", () => {
  let testDb: Database;
  let service: McpConfigService;

  beforeEach(() => {
    testDb = openTestDb();
    service = new McpConfigService(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe("CRUD operations", () => {
    describe("set and get", () => {
      it("stores and retrieves a stdio config", () => {
        const config: McpServerConfig = {
          type: "stdio",
          command: "python3",
          args: ["-m", "mcp.server.stdio"],
        };

        service.set("python-mcp", config);
        const retrieved = service.get("python-mcp");

        expect(retrieved).toEqual(config);
      });

      it("stores and retrieves an http config", () => {
        const config: McpServerConfig = {
          type: "http",
          url: "http://localhost:3000",
          headers: { "Authorization": "Bearer token" },
        };

        service.set("http-server", config);
        const retrieved = service.get("http-server");

        expect(retrieved).toEqual(config);
      });

      it("stores and retrieves an sse config", () => {
        const config: McpServerConfig = {
          type: "sse",
          url: "https://api.example.com/mcp",
        };

        service.set("sse-server", config);
        const retrieved = service.get("sse-server");

        expect(retrieved).toEqual(config);
      });

      it("defaults type to stdio if not specified", () => {
        const config: McpServerConfig = {
          command: "node",
          args: ["server.js"],
        };

        service.set("node-server", config);
        const retrieved = service.get("node-server");

        // Should still be stored as provided
        expect(retrieved?.command).toBe("node");
      });

      it("returns null for nonexistent server", () => {
        const result = service.get("nonexistent");
        expect(result).toBeNull();
      });
    });

    describe("list", () => {
      it("returns empty object when no servers", () => {
        const result = service.list();
        expect(result).toEqual({});
      });

      it("returns all servers as Record", () => {
        const config1: McpServerConfig = { type: "stdio", command: "python3" };
        const config2: McpServerConfig = { type: "http", url: "http://localhost:3000" };

        service.set("server-a", config1);
        service.set("server-b", config2);

        const result = service.list();

        expect(Object.keys(result)).toEqual(["server-a", "server-b"]);
        expect(result["server-a"]).toEqual(config1);
        expect(result["server-b"]).toEqual(config2);
      });

      it("returns servers in alphabetical order", () => {
        service.set("zebra", { type: "stdio", command: "cmd" });
        service.set("apple", { type: "stdio", command: "cmd" });
        service.set("banana", { type: "stdio", command: "cmd" });

        const result = service.list();
        expect(Object.keys(result)).toEqual(["apple", "banana", "zebra"]);
      });
    });

    describe("listWithMeta", () => {
      it("returns empty array when no servers", () => {
        const result = service.listWithMeta();
        expect(result).toEqual([]);
      });

      it("returns servers with metadata", () => {
        const config: McpServerConfig = { type: "stdio", command: "python3" };
        service.set("test-server", config);

        const result = service.listWithMeta();

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          name: "test-server",
          transport: "stdio",
          config,
        });
        expect(result[0].createdAt).toBeDefined();
        expect(result[0].updatedAt).toBeDefined();
      });

      it("updates transport type when config type changes", () => {
        const config1: McpServerConfig = { type: "stdio", command: "python3" };
        service.set("test-server", config1);

        const first = service.listWithMeta()[0];
        expect(first.transport).toBe("stdio");
        expect(first.createdAt).toBeDefined();
        expect(first.updatedAt).toBeDefined();

        const config2: McpServerConfig = { type: "http", url: "http://localhost:3000" };
        service.set("test-server", config2);

        const updated = service.listWithMeta()[0];

        // Transport should change
        expect(updated.transport).toBe("http");
        // CreatedAt should stay same
        expect(updated.createdAt).toBe(first.createdAt);
        // Config should be updated
        expect(updated.config).toEqual(config2);
      });

      it("returns servers in alphabetical order", () => {
        service.set("zebra", { type: "stdio", command: "cmd" });
        service.set("apple", { type: "stdio", command: "cmd" });

        const result = service.listWithMeta();
        expect(result.map((r) => r.name)).toEqual(["apple", "zebra"]);
      });
    });

    describe("exists", () => {
      it("returns false for nonexistent server", () => {
        expect(service.exists("nonexistent")).toBe(false);
      });

      it("returns true after set", () => {
        service.set("test", { type: "stdio", command: "cmd" });
        expect(service.exists("test")).toBe(true);
      });

      it("returns false after remove", () => {
        service.set("test", { type: "stdio", command: "cmd" });
        service.remove("test");
        expect(service.exists("test")).toBe(false);
      });
    });

    describe("remove", () => {
      it("returns false when server does not exist", () => {
        const result = service.remove("nonexistent");
        expect(result).toBe(false);
      });

      it("removes an existing server", () => {
        service.set("test", { type: "stdio", command: "cmd" });
        expect(service.exists("test")).toBe(true);

        const removed = service.remove("test");

        expect(removed).toBe(true);
        expect(service.exists("test")).toBe(false);
        expect(service.get("test")).toBeNull();
      });

      it("returns true only once when called multiple times", () => {
        service.set("test", { type: "stdio", command: "cmd" });

        const first = service.remove("test");
        const second = service.remove("test");

        expect(first).toBe(true);
        expect(second).toBe(false);
      });
    });

    describe("update (set overwrites)", () => {
      it("overwrites config for existing name", () => {
        const config1: McpServerConfig = { type: "stdio", command: "python3" };
        service.set("test", config1);

        const config2: McpServerConfig = { type: "http", url: "http://localhost:3000" };
        service.set("test", config2);

        const result = service.get("test");
        expect(result).toEqual(config2);
      });

      it("updates transport type when config type changes", () => {
        service.set("test", { type: "stdio", command: "cmd" });
        const firstMeta = service.listWithMeta()[0];
        expect(firstMeta.transport).toBe("stdio");

        service.set("test", { type: "http", url: "http://localhost" });
        const secondMeta = service.listWithMeta()[0];
        expect(secondMeta.transport).toBe("http");
      });
    });
  });

  describe("bulkImport", () => {
    it("returns { imported: 0, skipped: 0 } for empty object", () => {
      const result = service.bulkImport({});
      expect(result).toEqual({ imported: 0, skipped: 0 });
    });

    it("imports new servers", () => {
      const servers: Record<string, McpServerConfig> = {
        "server-1": { type: "stdio", command: "python3" },
        "server-2": { type: "http", url: "http://localhost" },
      };

      const result = service.bulkImport(servers);

      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);
      expect(service.list()).toEqual(servers);
    });

    it("skips existing servers", () => {
      service.set("existing", { type: "stdio", command: "cmd" });

      const servers: Record<string, McpServerConfig> = {
        "existing": { type: "http", url: "http://localhost" },
        "new": { type: "stdio", command: "python3" },
      };

      const result = service.bulkImport(servers);

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);

      // Existing should not be overwritten
      expect(service.get("existing")).toEqual({ type: "stdio", command: "cmd" });
      // New should be added
      expect(service.get("new")).toEqual({ type: "stdio", command: "python3" });
    });

    it("handles mixed existing and new servers", () => {
      service.set("server-a", { type: "stdio", command: "a" });
      service.set("server-b", { type: "stdio", command: "b" });

      const servers: Record<string, McpServerConfig> = {
        "server-a": { type: "http", url: "http://new-a" },
        "server-b": { type: "http", url: "http://new-b" },
        "server-c": { type: "stdio", command: "c" },
      };

      const result = service.bulkImport(servers);

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(2);
    });
  });
});

describe("validateMcpName", () => {
  describe("valid names", () => {
    it("accepts lowercase alphanumeric with hyphens", () => {
      expect(validateMcpName("my-server")).toBeNull();
    });

    it("accepts lowercase alphanumeric with underscores", () => {
      expect(validateMcpName("my_server")).toBeNull();
    });

    it("accepts names starting with digit", () => {
      expect(validateMcpName("3tier-server")).toBeNull();
    });

    it("accepts names with mixed lowercase and digits", () => {
      expect(validateMcpName("mcp-server-v2")).toBeNull();
    });

    it("accepts single character names", () => {
      expect(validateMcpName("a")).toBeNull();
      expect(validateMcpName("1")).toBeNull();
    });

    it("accepts exactly 50 chars", () => {
      const name = "a".repeat(50);
      expect(validateMcpName(name)).toBeNull();
    });
  });

  describe("invalid names", () => {
    it("rejects empty string", () => {
      const error = validateMcpName("");
      expect(error).not.toBeNull();
    });

    it("accepts uppercase letters (Claude Code names use them)", () => {
      const error = validateMcpName("MyServer");
      expect(error).toBeNull();
    });

    it("rejects names starting with hyphen", () => {
      const error = validateMcpName("-server");
      expect(error).not.toBeNull();
    });

    it("rejects names starting with underscore", () => {
      const error = validateMcpName("_server");
      expect(error).not.toBeNull();
    });

    it("rejects names with spaces", () => {
      const error = validateMcpName("my server");
      expect(error).not.toBeNull();
    });

    it("rejects names with special characters", () => {
      expect(validateMcpName("my.server")).not.toBeNull();
      expect(validateMcpName("my@server")).not.toBeNull();
      expect(validateMcpName("my/server")).not.toBeNull();
    });

    it("rejects names longer than 50 chars", () => {
      const name = "a".repeat(51);
      const error = validateMcpName(name);
      expect(error).not.toBeNull();
      expect(error).toContain("max 50 chars");
    });

    it("rejects whitespace-only names", () => {
      expect(validateMcpName("   ")).not.toBeNull();
    });
  });
});

describe("validateMcpConfig", () => {
  describe("stdio config", () => {
    it("accepts valid stdio config", () => {
      const config = { type: "stdio", command: "python3" };
      expect(validateMcpConfig(config)).toEqual([]);
    });

    it("accepts stdio with args", () => {
      const config = {
        type: "stdio",
        command: "python3",
        args: ["-m", "mcp.server"],
      };
      expect(validateMcpConfig(config)).toEqual([]);
    });

    it("accepts stdio with env", () => {
      const config = {
        type: "stdio",
        command: "node",
        env: { NODE_ENV: "production" },
      };
      expect(validateMcpConfig(config)).toEqual([]);
    });

    it("defaults to stdio type if not specified", () => {
      const config = { command: "python3" };
      expect(validateMcpConfig(config)).toEqual([]);
    });

    it("requires command for stdio", () => {
      const config = { type: "stdio" };
      const errors = validateMcpConfig(config);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("command"))).toBe(true);
    });

    it("rejects non-string command", () => {
      const config = { type: "stdio", command: 123 };
      const errors = validateMcpConfig(config);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("http config", () => {
    it("accepts valid http config", () => {
      const config = { type: "http", url: "http://localhost:3000" };
      expect(validateMcpConfig(config)).toEqual([]);
    });

    it("accepts https", () => {
      const config = { type: "http", url: "https://api.example.com/mcp" };
      expect(validateMcpConfig(config)).toEqual([]);
    });

    it("accepts http with headers", () => {
      const config = {
        type: "http",
        url: "http://localhost:3000",
        headers: { "Authorization": "Bearer token" },
      };
      expect(validateMcpConfig(config)).toEqual([]);
    });

    it("requires url for http", () => {
      const config = { type: "http" };
      const errors = validateMcpConfig(config);
      expect(errors.some((e) => e.includes("url"))).toBe(true);
    });

    it("rejects invalid url format", () => {
      const errors1 = validateMcpConfig({ type: "http", url: "not-a-url" });
      const errors2 = validateMcpConfig({ type: "http", url: "ftp://example.com" });

      expect(errors1.some((e) => e.includes("HTTP"))).toBe(true);
      expect(errors2.some((e) => e.includes("HTTP"))).toBe(true);
    });
  });

  describe("sse config", () => {
    it("accepts valid sse config", () => {
      const config = { type: "sse", url: "https://api.example.com/mcp" };
      expect(validateMcpConfig(config)).toEqual([]);
    });

    it("accepts sse with headers", () => {
      const config = {
        type: "sse",
        url: "https://api.example.com",
        headers: { "Authorization": "Bearer token" },
      };
      expect(validateMcpConfig(config)).toEqual([]);
    });

    it("requires url for sse", () => {
      const config = { type: "sse" };
      const errors = validateMcpConfig(config);
      expect(errors.some((e) => e.includes("url"))).toBe(true);
    });

    it("rejects invalid url for sse", () => {
      const errors = validateMcpConfig({ type: "sse", url: "invalid-url" });
      expect(errors.some((e) => e.includes("HTTP"))).toBe(true);
    });
  });

  describe("invalid input", () => {
    it("rejects null", () => {
      const errors = validateMcpConfig(null);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects undefined", () => {
      const errors = validateMcpConfig(undefined);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects non-object", () => {
      const errors = validateMcpConfig("not an object");
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects unknown type", () => {
      const config = { type: "websocket", url: "ws://localhost" };
      const errors = validateMcpConfig(config);
      expect(errors.some((e) => e.includes("type must be"))).toBe(true);
    });
  });

  describe("error accumulation", () => {
    it("returns multiple errors when applicable", () => {
      const config = { type: "http" }; // Missing url
      const errors = validateMcpConfig(config);
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
