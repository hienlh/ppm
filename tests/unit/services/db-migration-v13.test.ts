import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb, getDb } from "../../../src/services/db.service.ts";

describe("DB Migration v13 — ClawBot tables", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  it("should create clawbot_sessions table", () => {
    const db = getDb();
    const row = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clawbot_sessions'",
    ).get() as { name: string } | null;
    expect(row?.name).toBe("clawbot_sessions");
  });

  it("should create clawbot_memories table", () => {
    const db = getDb();
    const row = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clawbot_memories'",
    ).get() as { name: string } | null;
    expect(row?.name).toBe("clawbot_memories");
  });

  it("should create clawbot_memories_fts virtual table", () => {
    const db = getDb();
    const row = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clawbot_memories_fts'",
    ).get() as { name: string } | null;
    expect(row?.name).toBe("clawbot_memories_fts");
  });

  it("should create clawbot_paired_chats table", () => {
    const db = getDb();
    const row = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clawbot_paired_chats'",
    ).get() as { name: string } | null;
    expect(row?.name).toBe("clawbot_paired_chats");
  });

  it("should have schema version >= 13", () => {
    const db = getDb();
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBeGreaterThanOrEqual(13);
  });

  it("should insert and query clawbot_sessions", () => {
    const db = getDb();
    db.query(
      `INSERT INTO clawbot_sessions (telegram_chat_id, session_id, provider_id, project_name, project_path)
       VALUES ('12345', 'sess-1', 'claude', 'myproject', '/path/to/project')`,
    ).run();
    const row = db.query("SELECT * FROM clawbot_sessions WHERE telegram_chat_id = '12345'").get();
    expect(row).toBeTruthy();
  });

  it("should insert and query paired chats", () => {
    const db = getDb();
    db.query(
      `INSERT INTO clawbot_paired_chats (telegram_chat_id, display_name, pairing_code, status)
       VALUES ('12345', 'Test User', 'A3K7WR', 'pending')`,
    ).run();
    const row = db.query("SELECT * FROM clawbot_paired_chats WHERE telegram_chat_id = '12345'").get();
    expect(row).toBeTruthy();
  });

  it("should insert memory and search via FTS5", () => {
    const db = getDb();
    db.query(
      `INSERT INTO clawbot_memories (project, content, category, importance)
       VALUES ('myproject', 'The database uses PostgreSQL with migrations', 'architecture', 1.5)`,
    ).run();

    const results = db.query(
      `SELECT m.* FROM clawbot_memories m
       JOIN clawbot_memories_fts fts ON m.id = fts.rowid
       WHERE clawbot_memories_fts MATCH 'PostgreSQL'`,
    ).all();
    expect(results.length).toBe(1);
  });
});
