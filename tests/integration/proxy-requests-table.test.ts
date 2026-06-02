import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

// Create isolated test directory
const testPpmHome = mkdtempSync(resolve(tmpdir(), "ppm-test-proxy-"));
process.env.PPM_HOME = testPpmHome;
mkdirSync(resolve(testPpmHome, "bin"), { recursive: true });

describe("Proxy Request Logging — Database Schema (Migration v28)", () => {
  let db: Database;

  beforeEach(() => {
    // Create fresh in-memory database and apply migrations manually
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db);
  });

  function applyMigrations(database: Database) {
    // This mimics what db.service.ts does
    // We'll only apply up to v28 to test the proxy_requests table
    const row = database.query("PRAGMA user_version").get() as { user_version: number };
    const current = row.user_version;

    if (current < 1) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL UNIQUE,
          color TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS session_map (
          ppm_id TEXT PRIMARY KEY,
          sdk_id TEXT NOT NULL,
          project_name TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS session_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS usage_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cost_usd REAL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          model TEXT,
          session_id TEXT,
          project_name TEXT,
          five_hour_pct REAL,
          weekly_pct REAL,
          recorded_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_logs_created ON session_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_history(session_id);
        CREATE INDEX IF NOT EXISTS idx_usage_recorded ON usage_history(recorded_at);
        CREATE INDEX IF NOT EXISTS idx_projects_sort ON projects(sort_order);
        PRAGMA user_version = 1;
      `);
    }

    if (current < 28) {
      // Skip to v27 (simplified)
      database.exec("PRAGMA user_version = 27;");
    }

    if (current < 28) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS proxy_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          endpoint TEXT NOT NULL,
          model TEXT,
          account_id TEXT,
          account_label TEXT,
          caller_ip TEXT,
          caller_ua TEXT,
          status TEXT NOT NULL,
          duration_ms INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_proxy_req_created ON proxy_requests(created_at);
        CREATE INDEX IF NOT EXISTS idx_proxy_req_caller ON proxy_requests(caller_ip);
        PRAGMA user_version = 28;
      `);
    }
  }

  describe("Migration v28: proxy_requests table schema", () => {
    it("upgrades schema version to 28", () => {
      const versionRow = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(versionRow.user_version).toBe(28);
    });

    it("creates proxy_requests table", () => {
      const tableRow = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_requests'"
      ).get() as { name: string } | null;

      expect(tableRow).toBeTruthy();
      expect(tableRow?.name).toBe("proxy_requests");
    });

    it("table has correct column structure", () => {
      const columns = db.query("PRAGMA table_info(proxy_requests)").all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      const columnMap = Object.fromEntries(columns.map(c => [c.name, c]));

      // Check all required columns exist
      expect(columnMap).toHaveProperty("id");
      expect(columnMap).toHaveProperty("endpoint");
      expect(columnMap).toHaveProperty("model");
      expect(columnMap).toHaveProperty("account_id");
      expect(columnMap).toHaveProperty("account_label");
      expect(columnMap).toHaveProperty("caller_ip");
      expect(columnMap).toHaveProperty("caller_ua");
      expect(columnMap).toHaveProperty("status");
      expect(columnMap).toHaveProperty("duration_ms");
      expect(columnMap).toHaveProperty("created_at");

      // id is PRIMARY KEY (pk == 1)
      expect(columnMap.id.pk).toBe(1);

      // Required fields: endpoint, status (NOT NULL)
      expect(columnMap.endpoint.notnull).toBe(1);
      expect(columnMap.status.notnull).toBe(1);

      // Optional fields allow NULL
      expect(columnMap.model.notnull).toBe(0);
      expect(columnMap.account_id.notnull).toBe(0);
      expect(columnMap.account_label.notnull).toBe(0);
      expect(columnMap.caller_ip.notnull).toBe(0);
      expect(columnMap.caller_ua.notnull).toBe(0);
      expect(columnMap.duration_ms.notnull).toBe(0);

      // created_at should auto-populate by default
      expect(columnMap.created_at.dflt_value).toContain("datetime");
    });

    it("creates required indexes", () => {
      const indexes = db.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='proxy_requests' AND name NOT LIKE 'sqlite_%'"
      ).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain("idx_proxy_req_created");
      expect(indexNames).toContain("idx_proxy_req_caller");
    });
  });

  describe("Insert operations (test insertProxyRequest behavior)", () => {
    it("inserts record with all fields populated", () => {
      db.query(
        `INSERT INTO proxy_requests
         (endpoint, model, account_id, account_label, caller_ip, caller_ua, status, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "/v1/messages",
        "claude-3-5-sonnet",
        "acc-prod-001",
        "production",
        "192.168.1.100",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "success",
        1250
      );

      const row = db.query("SELECT * FROM proxy_requests").get() as any;
      expect(row).toBeTruthy();
      expect(row.endpoint).toBe("/v1/messages");
      expect(row.model).toBe("claude-3-5-sonnet");
      expect(row.account_id).toBe("acc-prod-001");
      expect(row.account_label).toBe("production");
      expect(row.caller_ip).toBe("192.168.1.100");
      expect(row.caller_ua).toContain("Windows");
      expect(row.status).toBe("success");
      expect(row.duration_ms).toBe(1250);
      expect(row.created_at).toBeTruthy();
    });

    it("inserts record with only required fields (endpoint, status)", () => {
      db.query(
        "INSERT INTO proxy_requests (endpoint, status) VALUES (?, ?)"
      ).run("/v1/completions", "error");

      const row = db.query("SELECT * FROM proxy_requests").get() as any;
      expect(row.endpoint).toBe("/v1/completions");
      expect(row.status).toBe("error");

      // Optional fields should be NULL
      expect(row.model).toBeNull();
      expect(row.account_id).toBeNull();
      expect(row.account_label).toBeNull();
      expect(row.caller_ip).toBeNull();
      expect(row.caller_ua).toBeNull();
      expect(row.duration_ms).toBeNull();

      // created_at auto-populated
      expect(row.created_at).toBeTruthy();
    });

    it("inserts multiple records with different statuses", () => {
      const stmt = db.query(
        "INSERT INTO proxy_requests (endpoint, status, duration_ms) VALUES (?, ?, ?)"
      );

      stmt.run("/v1/messages", "success", 1000);
      stmt.run("/v1/messages", "error", 500);
      stmt.run("/v1/models", "rate_limited", 100);

      const all = db.query("SELECT * FROM proxy_requests ORDER BY id").all() as any[];
      expect(all).toHaveLength(3);
      expect(all[0].status).toBe("success");
      expect(all[1].status).toBe("error");
      expect(all[2].status).toBe("rate_limited");
    });
  });

  describe("getProxyStats behavior (aggregation queries)", () => {
    it("counts total records", () => {
      const stmt = db.query(
        "INSERT INTO proxy_requests (endpoint, status) VALUES (?, ?)"
      );

      for (let i = 0; i < 5; i++) {
        stmt.run("/v1/messages", "success");
      }

      const totalRow = db.query("SELECT COUNT(*) as count FROM proxy_requests").get() as { count: number };
      expect(totalRow.count).toBe(5);
    });

    it("aggregates by model, account_label, caller_ip (lastHour pattern)", () => {
      const stmt = db.query(
        `INSERT INTO proxy_requests
         (endpoint, model, account_label, caller_ip, status)
         VALUES (?, ?, ?, ?, ?)`
      );

      // 2 requests: same (model, account_label, caller_ip)
      stmt.run("/v1/messages", "claude-3-5-sonnet", "prod", "10.0.0.1", "success");
      stmt.run("/v1/messages", "claude-3-5-sonnet", "prod", "10.0.0.1", "success");

      // 1 request: different model
      stmt.run("/v1/messages", "claude-3-opus", "prod", "10.0.0.1", "success");

      const aggregated = db.query(
        `SELECT model, account_label, caller_ip, COUNT(*) as count
         FROM proxy_requests
         GROUP BY model, account_label, caller_ip
         ORDER BY count DESC`
      ).all() as Array<{ model: string; account_label: string; caller_ip: string; count: number }>;

      expect(aggregated).toHaveLength(2);
      expect(aggregated[0].count).toBe(2);
      expect(aggregated[0].model).toBe("claude-3-5-sonnet");
      expect(aggregated[1].count).toBe(1);
      expect(aggregated[1].model).toBe("claude-3-opus");
    });

    it("filters by last hour using datetime", () => {
      // Insert recent record using current timestamp
      db.query(
        "INSERT INTO proxy_requests (endpoint, status) VALUES (?, ?)"
      ).run("/v1/messages", "success");

      // Insert old record using SQLite's datetime subtraction
      db.query(
        `INSERT INTO proxy_requests (endpoint, status, created_at) VALUES (?, ?, datetime('now', '-2 hours'))`
      ).run("/v1/messages", "success");

      const lastHour = db.query(
        `SELECT COUNT(*) as count FROM proxy_requests
         WHERE created_at >= datetime('now', '-1 hour')`
      ).get() as { count: number };

      // Only 1 should be within the last hour (the recent one)
      expect(lastHour.count).toBe(1);
    });

    it("filters by last 24 hours using datetime", () => {
      // Insert recent record using current timestamp
      db.query(
        "INSERT INTO proxy_requests (endpoint, status) VALUES (?, ?)"
      ).run("/v1/messages", "success");

      // Insert old record using SQLite's datetime subtraction (25 hours ago)
      db.query(
        `INSERT INTO proxy_requests (endpoint, status, created_at) VALUES (?, ?, datetime('now', '-25 hours'))`
      ).run("/v1/messages", "success");

      const last24h = db.query(
        `SELECT COUNT(*) as count FROM proxy_requests
         WHERE created_at >= datetime('now', '-24 hours')`
      ).get() as { count: number };

      expect(last24h.count).toBe(1);
    });
  });

  describe("cleanupOldProxyRequests behavior (delete queries)", () => {
    it("deletes records older than 30 days", () => {
      const stmt = db.query(
        "INSERT INTO proxy_requests (endpoint, status, created_at) VALUES (?, ?, ?)"
      );

      // 40 days old (should delete)
      stmt.run("/v1/messages", "old", new Date(Date.now() - 40 * 86400_000).toISOString());

      // 15 days old (should keep)
      stmt.run("/v1/messages", "medium", new Date(Date.now() - 15 * 86400_000).toISOString());

      // Recent (should keep)
      stmt.run("/v1/messages", "recent", new Date().toISOString());

      // Execute cleanup (delete records older than 30 days)
      const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
      const deleteStmt = db.prepare("DELETE FROM proxy_requests WHERE created_at < ?");
      const result = deleteStmt.run(cutoff);

      expect(result.changes).toBe(1);

      // Verify 2 remain
      const remaining = db.query("SELECT COUNT(*) as count FROM proxy_requests").get() as { count: number };
      expect(remaining.count).toBe(2);
    });

    it("returns count of deleted rows", () => {
      const stmt = db.query(
        "INSERT INTO proxy_requests (endpoint, status, created_at) VALUES (?, ?, ?)"
      );

      // Insert 3 old records
      for (let i = 0; i < 3; i++) {
        stmt.run("/v1/messages", "old", new Date(Date.now() - 35 * 86400_000).toISOString());
      }

      // Insert 2 recent records
      for (let i = 0; i < 2; i++) {
        stmt.run("/v1/messages", "recent", new Date().toISOString());
      }

      const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
      const result = db.prepare("DELETE FROM proxy_requests WHERE created_at < ?").run(cutoff);

      expect(result.changes).toBe(3);
    });

    it("handles case with no records to delete", () => {
      const stmt = db.query(
        "INSERT INTO proxy_requests (endpoint, status, created_at) VALUES (?, ?, ?)"
      );

      // Only recent records
      stmt.run("/v1/messages", "success", new Date().toISOString());
      stmt.run("/v1/messages", "success", new Date().toISOString());

      const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
      const result = db.prepare("DELETE FROM proxy_requests WHERE created_at < ?").run(cutoff);

      expect(result.changes).toBe(0);

      // Both should remain
      const remaining = db.query("SELECT COUNT(*) as count FROM proxy_requests").get() as { count: number };
      expect(remaining.count).toBe(2);
    });
  });
});
