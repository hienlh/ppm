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
  getSessionMapping,
  setSessionMapping,
  getAllSessionMappings,
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
    closeDb();
  });

  describe("schema", () => {
    it("creates all 6 tables", () => {
      const tables = getAllTables();
      expect(tables).toContain("config");
      expect(tables).toContain("projects");
      expect(tables).toContain("session_map");
      expect(tables).toContain("push_subscriptions");
      expect(tables).toContain("session_logs");
      expect(tables).toContain("usage_history");
    });

    it("sets user_version to 3 after all migrations", () => {
      const { openTestDb: open } = require("../../../src/services/db.service.ts");
      const db = open();
      const row = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(row.user_version).toBe(3);
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

  describe("session map CRUD", () => {
    it("set and get mapping", () => {
      setSessionMapping("ppm-1", "sdk-abc");
      expect(getSessionMapping("ppm-1")).toBe("sdk-abc");
    });

    it("returns null for unknown ppmId", () => {
      expect(getSessionMapping("unknown")).toBeNull();
    });

    it("upserts on conflict", () => {
      setSessionMapping("ppm-1", "sdk-old");
      setSessionMapping("ppm-1", "sdk-new");
      expect(getSessionMapping("ppm-1")).toBe("sdk-new");
    });

    it("getAllSessionMappings returns all", () => {
      setSessionMapping("a", "1");
      setSessionMapping("b", "2");
      const all = getAllSessionMappings();
      expect(all.a).toBe("1");
      expect(all.b).toBe("2");
    });

    it("stores project name", () => {
      setSessionMapping("ppm-1", "sdk-1", "my-project");
      // project_name is stored but not returned by getSessionMapping
      expect(getSessionMapping("ppm-1")).toBe("sdk-1");
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
