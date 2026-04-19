import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  openTestDb,
  setDb,
  closeDb,
  getConfigValue,
  setConfigValue,
  getAllConfig,
  deleteConfigValue,
  getProjects,
  upsertProject,
  deleteProject,
  updateProject,
  deleteSessionMapping,
  getSessionProjectPath,
  setSessionMetadata,
  deleteSessionMetadata,
  getSessionTitle,
  setSessionTitle,
  deleteSessionTitle,
  pinSession,
  unpinSession,
  getPinnedSessionIds,
  getPushSubscriptions,
  upsertPushSubscription,
  deletePushSubscription,
  insertSessionLog,
  getSessionLogs,
  insertUsageRecord,
  getUsageSince,
} from "../../../src/services/db.service.ts";

describe("db.service", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  afterEach(() => {
    setDb(openTestDb()); // keep db as in-memory, never null (closeDb → null → getDb opens prod DB)
  });

  describe("schema", () => {
    it("creates all tables", () => {
      const tables = getAllTables();
      expect(tables).toContain("config");
      expect(tables).toContain("projects");
      expect(tables).toContain("session_metadata");
      expect(tables).toContain("push_subscriptions");
      expect(tables).toContain("session_logs");
      expect(tables).toContain("usage_history");
      expect(tables).toContain("accounts");
    });

    it("sets user_version to 19 after all migrations", () => {
      const { openTestDb: open } = require("../../../src/services/db.service.ts");
      const db = open();
      const row = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(row.user_version).toBe(19);
      db.close();
    });

    it("idempotent — calling openTestDb twice is safe", () => {
      const { openTestDb: open } = require("../../../src/services/db.service.ts");
      const db1 = open();
      const db2 = open();
      const t1 = db1.query("SELECT name FROM sqlite_master WHERE type='table'").all();
      const t2 = db2.query("SELECT name FROM sqlite_master WHERE type='table'").all();
      expect(t1.length).toBe(t2.length);
      db1.close();
      db2.close();
    });
  });

  describe("config CRUD", () => {
    it("set and get a string value", () => {
      setConfigValue("device_name", JSON.stringify("my-mac"));
      expect(getConfigValue("device_name")).toBe(JSON.stringify("my-mac"));
    });

    it("set and get a number value", () => {
      setConfigValue("port", JSON.stringify(8081));
      expect(JSON.parse(getConfigValue("port")!)).toBe(8081);
    });

    it("set and get an object value", () => {
      const auth = { enabled: true, token: "abc123" };
      setConfigValue("auth", JSON.stringify(auth));
      expect(JSON.parse(getConfigValue("auth")!)).toEqual(auth);
    });

    it("returns null for missing key", () => {
      expect(getConfigValue("nonexistent")).toBeNull();
    });

    it("upserts on duplicate key", () => {
      setConfigValue("port", "8080");
      setConfigValue("port", "9090");
      expect(getConfigValue("port")).toBe("9090");
    });

    it("getAllConfig returns all rows", () => {
      setConfigValue("a", "1");
      setConfigValue("b", "2");
      const all = getAllConfig();
      expect(all.a).toBe("1");
      expect(all.b).toBe("2");
    });

    it("deleteConfigValue removes a key", () => {
      setConfigValue("x", "y");
      deleteConfigValue("x");
      expect(getConfigValue("x")).toBeNull();
    });
  });

  describe("projects CRUD", () => {
    it("inserts and retrieves projects", () => {
      upsertProject("/home/user/proj1", "proj1");
      upsertProject("/home/user/proj2", "proj2", "#ff0000");
      const projects = getProjects();
      expect(projects).toHaveLength(2);
      expect(projects[0]!.name).toBe("proj1");
      expect(projects[0]!.color).toBeNull();
      expect(projects[1]!.name).toBe("proj2");
      expect(projects[1]!.color).toBe("#ff0000");
    });

    it("upserts by path — updates name on conflict", () => {
      upsertProject("/home/user/proj", "old-name");
      upsertProject("/home/user/proj", "new-name");
      const projects = getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.name).toBe("new-name");
    });

    it("maintains sort order", () => {
      upsertProject("/a", "a-project");
      upsertProject("/b", "b-project");
      upsertProject("/c", "c-project");
      const projects = getProjects();
      expect(projects[0]!.name).toBe("a-project");
      expect(projects[2]!.name).toBe("c-project");
    });

    it("deletes by name", () => {
      upsertProject("/a", "alpha");
      upsertProject("/b", "beta");
      deleteProject("alpha");
      const projects = getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.name).toBe("beta");
    });

    it("deletes by path", () => {
      upsertProject("/a", "alpha");
      deleteProject("/a");
      expect(getProjects()).toHaveLength(0);
    });

    it("updateProject changes name and path", () => {
      upsertProject("/old", "old-name");
      updateProject("old-name", "new-name", "/new", "#00ff00");
      const projects = getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.name).toBe("new-name");
      expect(projects[0]!.path).toBe("/new");
      expect(projects[0]!.color).toBe("#00ff00");
    });
  });

  describe("session metadata CRUD", () => {
    it("set and get project path", () => {
      setSessionMetadata("sess-1", "my-project", "/home/user/proj");
      expect(getSessionProjectPath("sess-1")).toBe("/home/user/proj");
    });

    it("returns null for unknown session", () => {
      expect(getSessionProjectPath("unknown")).toBeNull();
    });

    it("upserts on conflict", () => {
      setSessionMetadata("sess-1", "proj-a", "/path/a");
      setSessionMetadata("sess-1", "proj-b", "/path/b");
      expect(getSessionProjectPath("sess-1")).toBe("/path/b");
    });

    it("deleteSessionMetadata removes metadata", () => {
      setSessionMetadata("sess-del", "proj", "/path");
      expect(getSessionProjectPath("sess-del")).toBe("/path");
      deleteSessionMetadata("sess-del");
      expect(getSessionProjectPath("sess-del")).toBeNull();
    });

    it("deleteSessionMetadata is safe on nonexistent key", () => {
      expect(() => deleteSessionMetadata("nonexistent")).not.toThrow();
    });

    it("deleteSessionMapping (legacy) is safe on nonexistent key", () => {
      expect(() => deleteSessionMapping("nonexistent")).not.toThrow();
    });
  });

  describe("session titles CRUD", () => {
    it("set and get title", () => {
      setSessionTitle("sess-t1", "My Custom Title");
      expect(getSessionTitle("sess-t1")).toBe("My Custom Title");
    });

    it("returns null for unknown session", () => {
      expect(getSessionTitle("unknown")).toBeNull();
    });

    it("upserts on conflict", () => {
      setSessionTitle("sess-t2", "Old Title");
      setSessionTitle("sess-t2", "New Title");
      expect(getSessionTitle("sess-t2")).toBe("New Title");
    });

    it("deleteSessionTitle removes a title", () => {
      setSessionTitle("sess-del", "To Delete");
      expect(getSessionTitle("sess-del")).toBe("To Delete");
      deleteSessionTitle("sess-del");
      expect(getSessionTitle("sess-del")).toBeNull();
    });

    it("deleteSessionTitle is safe on nonexistent key", () => {
      expect(() => deleteSessionTitle("nonexistent")).not.toThrow();
    });
  });

  describe("session pins CRUD", () => {
    it("pin and check", () => {
      pinSession("sess-pin1");
      const pinned = getPinnedSessionIds();
      expect(pinned.has("sess-pin1")).toBe(true);
    });

    it("unpin removes from set", () => {
      pinSession("sess-pin2");
      expect(getPinnedSessionIds().has("sess-pin2")).toBe(true);
      unpinSession("sess-pin2");
      expect(getPinnedSessionIds().has("sess-pin2")).toBe(false);
    });

    it("unpin is safe on nonexistent key", () => {
      expect(() => unpinSession("nonexistent")).not.toThrow();
    });
  });

  describe("push subscriptions CRUD", () => {
    const ep1 = "https://fcm.googleapis.com/send/sub1";
    const ep2 = "https://fcm.googleapis.com/send/sub2";

    it("upsert and list subscriptions", () => {
      upsertPushSubscription(ep1, "key1", "auth1");
      upsertPushSubscription(ep2, "key2", "auth2", "1700000000000");
      const subs = getPushSubscriptions();
      expect(subs).toHaveLength(2);
      expect(subs[0]!.endpoint).toBe(ep1);
      expect(subs[1]!.expiration_time).toBe("1700000000000");
    });

    it("upserts on duplicate endpoint", () => {
      upsertPushSubscription(ep1, "old-key", "old-auth");
      upsertPushSubscription(ep1, "new-key", "new-auth");
      const subs = getPushSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0]!.p256dh).toBe("new-key");
    });

    it("deletes by endpoint", () => {
      upsertPushSubscription(ep1, "k", "a");
      upsertPushSubscription(ep2, "k", "a");
      deletePushSubscription(ep1);
      expect(getPushSubscriptions()).toHaveLength(1);
    });

    it("returns empty array when no subscriptions", () => {
      expect(getPushSubscriptions()).toEqual([]);
    });
  });

  describe("session logs", () => {
    it("inserts and retrieves logs", () => {
      insertSessionLog("sess-1", "INFO", "Started chat");
      insertSessionLog("sess-1", "ERROR", "Something failed");
      const logs = getSessionLogs("sess-1");
      expect(logs).toHaveLength(2);
      // Returned in DESC order
      expect(logs[0]!.level).toBe("ERROR");
      expect(logs[1]!.level).toBe("INFO");
    });

    it("returns empty for unknown session", () => {
      expect(getSessionLogs("unknown")).toEqual([]);
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        insertSessionLog("sess-2", "INFO", `msg-${i}`);
      }
      const logs = getSessionLogs("sess-2", 3);
      expect(logs).toHaveLength(3);
    });

    it("isolates logs by session", () => {
      insertSessionLog("sess-a", "INFO", "a-msg");
      insertSessionLog("sess-b", "INFO", "b-msg");
      expect(getSessionLogs("sess-a")).toHaveLength(1);
      expect(getSessionLogs("sess-b")).toHaveLength(1);
    });
  });

  describe("connection CRUD", () => {
    // Lazy imports to avoid circular ref at module level
    const getConnectionFns = () => {
      const mod = require("../../../src/services/db.service.ts");
      return {
        insertConnection: mod.insertConnection as typeof import("../../../src/services/db.service.ts").insertConnection,
        getConnections: mod.getConnections as typeof import("../../../src/services/db.service.ts").getConnections,
        getConnectionById: mod.getConnectionById as typeof import("../../../src/services/db.service.ts").getConnectionById,
        getConnectionByName: mod.getConnectionByName as typeof import("../../../src/services/db.service.ts").getConnectionByName,
        resolveConnection: mod.resolveConnection as typeof import("../../../src/services/db.service.ts").resolveConnection,
        deleteConnection: mod.deleteConnection as typeof import("../../../src/services/db.service.ts").deleteConnection,
        updateConnection: mod.updateConnection as typeof import("../../../src/services/db.service.ts").updateConnection,
        decryptConfig: mod.decryptConfig as typeof import("../../../src/services/db.service.ts").decryptConfig,
      };
    };

    it("inserts and retrieves a sqlite connection", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("sqlite", "my-sqlite", { type: "sqlite", path: "/tmp/test.db" });
      expect(conn.name).toBe("my-sqlite");
      expect(conn.type).toBe("sqlite");
      expect(conn.readonly).toBe(1);
      expect(conn.sort_order).toBe(0);
    });

    it("inserts a postgres connection", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("postgres", "my-pg", { type: "postgres", connectionString: "postgresql://localhost" });
      expect(conn.type).toBe("postgres");
    });

    it("auto-increments sort_order", () => {
      const fns = getConnectionFns();
      fns.insertConnection("sqlite", "a", { type: "sqlite", path: "/tmp/a.db" });
      fns.insertConnection("sqlite", "b", { type: "sqlite", path: "/tmp/b.db" });
      const all = fns.getConnections();
      expect(all[0]!.sort_order).toBe(0);
      expect(all[1]!.sort_order).toBe(1);
    });

    it("getConnectionById returns correct connection", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("sqlite", "by-id", { type: "sqlite", path: "/tmp/id.db" });
      const found = fns.getConnectionById(conn.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("by-id");
    });

    it("getConnectionById returns null for unknown id", () => {
      const fns = getConnectionFns();
      expect(fns.getConnectionById(999)).toBeNull();
    });

    it("getConnectionByName returns correct connection", () => {
      const fns = getConnectionFns();
      fns.insertConnection("sqlite", "by-name", { type: "sqlite", path: "/tmp/name.db" });
      const found = fns.getConnectionByName("by-name");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("by-name");
    });

    it("getConnectionByName returns null for unknown name", () => {
      const fns = getConnectionFns();
      expect(fns.getConnectionByName("nonexistent")).toBeNull();
    });

    it("resolveConnection by numeric id", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("sqlite", "resolve-id", { type: "sqlite", path: "/tmp/r.db" });
      const found = fns.resolveConnection(String(conn.id));
      expect(found).not.toBeNull();
      expect(found!.name).toBe("resolve-id");
    });

    it("resolveConnection by name", () => {
      const fns = getConnectionFns();
      fns.insertConnection("sqlite", "resolve-name", { type: "sqlite", path: "/tmp/r.db" });
      const found = fns.resolveConnection("resolve-name");
      expect(found).not.toBeNull();
    });

    it("resolveConnection returns null for unknown", () => {
      const fns = getConnectionFns();
      expect(fns.resolveConnection("ghost")).toBeNull();
      expect(fns.resolveConnection("9999")).toBeNull();
    });

    it("deleteConnection by name", () => {
      const fns = getConnectionFns();
      fns.insertConnection("sqlite", "to-delete", { type: "sqlite", path: "/tmp/del.db" });
      expect(fns.deleteConnection("to-delete")).toBe(true);
      expect(fns.getConnections()).toHaveLength(0);
    });

    it("deleteConnection by id", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("sqlite", "del-by-id", { type: "sqlite", path: "/tmp/d.db" });
      expect(fns.deleteConnection(String(conn.id))).toBe(true);
    });

    it("deleteConnection returns false for unknown", () => {
      const fns = getConnectionFns();
      expect(fns.deleteConnection("nonexistent")).toBe(false);
    });

    it("updateConnection changes name", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("sqlite", "old-name", { type: "sqlite", path: "/tmp/u.db" });
      fns.updateConnection(conn.id, { name: "new-name" });
      const updated = fns.getConnectionById(conn.id);
      expect(updated!.name).toBe("new-name");
    });

    it("updateConnection toggles readonly", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("sqlite", "ro-toggle", { type: "sqlite", path: "/tmp/ro.db" });
      expect(conn.readonly).toBe(1);
      fns.updateConnection(conn.id, { readonly: 0 });
      expect(fns.getConnectionById(conn.id)!.readonly).toBe(0);
    });

    it("updateConnection changes group and color", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("sqlite", "style", { type: "sqlite", path: "/tmp/s.db" }, "grp", "#aaa");
      fns.updateConnection(conn.id, { groupName: "new-grp", color: "#bbb" });
      const updated = fns.getConnectionById(conn.id);
      expect(updated!.group_name).toBe("new-grp");
      expect(updated!.color).toBe("#bbb");
    });

    it("updateConnection with no fields is a no-op", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("sqlite", "noop", { type: "sqlite", path: "/tmp/n.db" });
      fns.updateConnection(conn.id, {});
      const same = fns.getConnectionById(conn.id);
      expect(same!.name).toBe("noop");
    });

    it("encrypted config round-trips correctly", () => {
      const fns = getConnectionFns();
      const conn = fns.insertConnection("sqlite", "enc-test", { type: "sqlite", path: "/tmp/enc.db" });
      const decrypted = fns.decryptConfig(conn.connection_config);
      expect(decrypted.type).toBe("sqlite");
      expect((decrypted as any).path).toBe("/tmp/enc.db");
    });

    it("rejects duplicate connection name", () => {
      const fns = getConnectionFns();
      fns.insertConnection("sqlite", "unique-name", { type: "sqlite", path: "/tmp/u1.db" });
      expect(() => fns.insertConnection("sqlite", "unique-name", { type: "sqlite", path: "/tmp/u2.db" })).toThrow();
    });
  });

  describe("usage history", () => {
    it("inserts a usage record", () => {
      insertUsageRecord({
        costUsd: 0.05,
        inputTokens: 1000,
        outputTokens: 500,
        model: "claude-sonnet-4-6",
        sessionId: "sess-1",
        projectName: "my-project",
        fiveHourPct: 0.12,
        weeklyPct: 0.03,
      });
      const rows = getUsageSince("2000-01-01");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.cost_usd).toBe(0.05);
      expect(rows[0]!.model).toBe("claude-sonnet-4-6");
      expect(rows[0]!.five_hour_pct).toBe(0.12);
    });

    it("inserts with partial fields", () => {
      insertUsageRecord({ costUsd: 0.01 });
      const rows = getUsageSince("2000-01-01");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.input_tokens).toBeNull();
      expect(rows[0]!.model).toBeNull();
    });

    it("getUsageSince filters by date", () => {
      insertUsageRecord({ costUsd: 0.01 });
      // Future date should return nothing
      const rows = getUsageSince("2099-01-01");
      expect(rows).toHaveLength(0);
    });
  });
});

/** Helper: get all table names from the DB */
function getAllTables(): string[] {
  const { openTestDb, setDb: setTestDb } = require("../../../src/services/db.service.ts");
  // Use the existing singleton set in beforeEach
  const allConfig = getAllConfig(); // triggers getDb()
  const db = require("../../../src/services/db.service.ts").getDb();
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return rows.map((r: { name: string }) => r.name);
}
