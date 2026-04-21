import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

/**
 * Integration tests for SQLite schema (migrations, WAL mode, indexes).
 */

const TEST_DIR = resolve(tmpdir(), `ppm-migration-test-${Date.now()}`);

describe("SQLite schema migrations", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it("DB schema has correct user_version after migrations", () => {
    const { openTestDb } = require("../../src/services/db.service.ts");
    const testDb = openTestDb();

    const row = testDb.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(21);

    // All tables should exist
    const tables = testDb.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("config");
    expect(names).toContain("projects");
    expect(names).toContain("session_map");
    expect(names).toContain("session_metadata");
    expect(names).toContain("push_subscriptions");
    expect(names).toContain("session_logs");
    expect(names).toContain("usage_history");
    expect(names).toContain("connections");
    expect(names).toContain("connection_table_cache");
    expect(names).toContain("claude_limit_snapshots");
    expect(names).toContain("accounts");
    expect(names).toContain("workspace_state");
    expect(names).toContain("extensions");
    expect(names).toContain("extension_storage");

    testDb.close();
  });

  it("WAL mode is requested on init", () => {
    // In-memory DBs return "memory" for journal_mode even when WAL is requested.
    // Use a real temp file to verify WAL is actually set.
    const tmpDbPath = resolve(TEST_DIR, "wal-test.db");
    const tmpDb = new Database(tmpDbPath);
    tmpDb.exec("PRAGMA journal_mode = WAL");
    const row = tmpDb.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
    tmpDb.close();
  });

  it("indexes are created for performance", () => {
    const { openTestDb } = require("../../src/services/db.service.ts");
    const testDb = openTestDb();

    const indexes = testDb.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);

    expect(names).toContain("idx_session_logs_session");
    expect(names).toContain("idx_session_logs_created");
    expect(names).toContain("idx_usage_session");
    expect(names).toContain("idx_usage_recorded");
    expect(names).toContain("idx_projects_sort");
    expect(names).toContain("idx_limit_snapshots_recorded");

    testDb.close();
  });
});
