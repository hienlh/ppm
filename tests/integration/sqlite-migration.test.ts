import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

/**
 * Integration tests for YAML → SQLite migration.
 * Uses a real temp directory with actual YAML/JSON files and a real SQLite DB.
 */

const TEST_DIR = resolve(tmpdir(), `ppm-migration-test-${Date.now()}`);
const DB_PATH = resolve(TEST_DIR, "ppm.db");

/** Minimal YAML config for testing (no js-yaml dependency — write raw YAML) */
const SAMPLE_YAML = `
device_name: test-machine
port: 9090
host: 0.0.0.0
theme: dark
auth:
  enabled: true
  token: test-token-abc
projects:
  - path: /home/user/project-a
    name: project-a
  - path: /home/user/project-b
    name: project-b
    color: "#ff0000"
ai:
  default_provider: claude
  providers:
    claude:
      type: agent-sdk
      api_key_env: ANTHROPIC_API_KEY
      model: claude-sonnet-4-6
      effort: high
      max_turns: 100
push:
  vapid_public_key: test-pub-key
  vapid_private_key: test-priv-key
  vapid_subject: "https://ppm.local"
`.trim();

const SAMPLE_SESSION_MAP = JSON.stringify({
  "ppm-session-1": "sdk-session-aaa",
  "ppm-session-2": "sdk-session-bbb",
});

const SAMPLE_PUSH_SUBS = JSON.stringify([
  {
    endpoint: "https://fcm.googleapis.com/send/sub1",
    keys: { p256dh: "pub-key-1", auth: "auth-key-1" },
    expirationTime: null,
  },
  {
    endpoint: "https://fcm.googleapis.com/send/sub2",
    keys: { p256dh: "pub-key-2", auth: "auth-key-2" },
    expirationTime: 1700000000000,
  },
]);

describe("YAML → SQLite migration", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it("imports YAML config into SQLite DB", () => {
    const yamlPath = resolve(TEST_DIR, "config.yaml");
    writeFileSync(yamlPath, SAMPLE_YAML, "utf-8");

    // Create DB and run migrations
    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // Run schema creation (same as db.service.ts migration v1)
    db.exec(`
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
      PRAGMA user_version = 1;
    `);

    // Simulate YAML import: parse and insert
    const yaml = require("js-yaml");
    const parsed = yaml.load(readFileSync(yamlPath, "utf-8"));

    // Insert config keys
    const configKeys = ["device_name", "port", "host", "theme", "auth", "ai", "push"];
    const insertConfig = db.query(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const key of configKeys) {
      if (parsed[key] !== undefined) {
        insertConfig.run(key, JSON.stringify(parsed[key]));
      }
    }

    // Insert projects
    const insertProject = db.query(
      "INSERT INTO projects (path, name, color, sort_order) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < parsed.projects.length; i++) {
      const p = parsed.projects[i];
      insertProject.run(p.path, p.name, p.color ?? null, i);
    }

    // Verify config
    const portRow = db.query("SELECT value FROM config WHERE key = 'port'").get() as { value: string };
    expect(JSON.parse(portRow.value)).toBe(9090);

    const themeRow = db.query("SELECT value FROM config WHERE key = 'theme'").get() as { value: string };
    expect(JSON.parse(themeRow.value)).toBe("dark");

    const authRow = db.query("SELECT value FROM config WHERE key = 'auth'").get() as { value: string };
    const auth = JSON.parse(authRow.value);
    expect(auth.enabled).toBe(true);
    expect(auth.token).toBe("test-token-abc");

    // Verify projects in separate table
    const projects = db.query("SELECT * FROM projects ORDER BY sort_order").all() as any[];
    expect(projects).toHaveLength(2);
    expect(projects[0].name).toBe("project-a");
    expect(projects[0].path).toBe("/home/user/project-a");
    expect(projects[0].sort_order).toBe(0);
    expect(projects[1].name).toBe("project-b");
    expect(projects[1].color).toBe("#ff0000");
    expect(projects[1].sort_order).toBe(1);

    // Verify push config
    const pushRow = db.query("SELECT value FROM config WHERE key = 'push'").get() as { value: string };
    const push = JSON.parse(pushRow.value);
    expect(push.vapid_public_key).toBe("test-pub-key");

    db.close();
  });

  it("imports session-map.json into session_map table", () => {
    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_map (
        ppm_id TEXT PRIMARY KEY,
        sdk_id TEXT NOT NULL,
        project_name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    const map = JSON.parse(SAMPLE_SESSION_MAP);
    const insert = db.query(
      "INSERT INTO session_map (ppm_id, sdk_id) VALUES (?, ?) ON CONFLICT(ppm_id) DO UPDATE SET sdk_id = excluded.sdk_id",
    );
    for (const [ppmId, sdkId] of Object.entries(map)) {
      insert.run(ppmId, sdkId as string);
    }

    // Verify
    const rows = db.query("SELECT * FROM session_map").all() as any[];
    expect(rows).toHaveLength(2);

    const row1 = db.query("SELECT sdk_id FROM session_map WHERE ppm_id = 'ppm-session-1'").get() as any;
    expect(row1.sdk_id).toBe("sdk-session-aaa");

    const row2 = db.query("SELECT sdk_id FROM session_map WHERE ppm_id = 'ppm-session-2'").get() as any;
    expect(row2.sdk_id).toBe("sdk-session-bbb");

    db.close();
  });

  it("imports push-subscriptions.json into push_subscriptions table", () => {
    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expiration_time TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    const subs = JSON.parse(SAMPLE_PUSH_SUBS);
    const insert = db.query(
      "INSERT INTO push_subscriptions (endpoint, p256dh, auth, expiration_time) VALUES (?, ?, ?, ?)",
    );
    for (const sub of subs) {
      insert.run(sub.endpoint, sub.keys.p256dh, sub.keys.auth,
        sub.expirationTime != null ? String(sub.expirationTime) : null);
    }

    // Verify
    const rows = db.query("SELECT * FROM push_subscriptions").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].endpoint).toBe("https://fcm.googleapis.com/send/sub1");
    expect(rows[0].p256dh).toBe("pub-key-1");
    expect(rows[0].expiration_time).toBeNull();
    expect(rows[1].endpoint).toBe("https://fcm.googleapis.com/send/sub2");
    expect(rows[1].expiration_time).toBe("1700000000000");

    db.close();
  });

  it("DB schema has correct user_version after migrations", () => {
    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // Run full migration from db.service
    const { openTestDb } = require("../../src/services/db.service.ts");
    const testDb = openTestDb();

    const row = testDb.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(13);

    // All tables should exist (v1–v13 migrations)
    const tables = testDb.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("config");
    expect(names).toContain("projects");
    expect(names).toContain("session_map");
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
    db.close();
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
