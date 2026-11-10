/**
 * The PPM Assistant's migrations are 61-63: its builds numbered them 57-59, the numbers main gave
 * to design share links (57), the script-schedule schema (58) and the `session_logs` drop (59).
 * A database such a build opened reads 59 having skipped all three of main's steps; 60 re-applies
 * the last two and 61 creates the share-link table. A database main opened at 60 has none of the
 * Assistant's schema and gets all of it.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../../src/services/db.service.ts";

type Column = { name: string };

function openCurrent(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  return db;
}

const exists = (db: Database, type: "table" | "index", name: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) != null;

const columns = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA table_info(${table})`).all() as Column[]).map((c) => c.name);

const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("the Assistant's migrations after main's", () => {
  it("ends at the latest migration, past the Assistant's 61-63", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(63);
    expect(version(openCurrent())).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("gives a database an Assistant build left at 59 every step of main's it skipped, keeping its rows", () => {
    const db = openCurrent();
    // What such a build left: the Assistant's schema, none of main's 57-60.
    db.exec("DROP INDEX idx_design_share_links_design");
    db.exec("DROP TABLE design_share_links");
    db.exec("DROP TABLE schedule_chats");
    db.exec("DROP TABLE schedule_ai_turns");
    db.exec("DROP TABLE schedule_runtime");
    for (const column of ["kind", "mode", "description", "script", "inputs_json", "input_values_json", "secrets_enc", "state_json"]) {
      db.exec(`ALTER TABLE schedules DROP COLUMN ${column}`);
    }
    db.exec("CREATE TABLE session_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL)");
    db.exec("DROP INDEX idx_session_metadata_spawned_by");
    db.exec("ALTER TABLE session_metadata DROP COLUMN spawned_by");
    db.exec("ALTER TABLE session_metadata DROP COLUMN spawn_depth");
    db.exec("PRAGMA user_version = 59");
    db.query("INSERT INTO session_metadata (session_id, assistant) VALUES ('assistant-1', 1)").run();
    db.query("INSERT INTO assistant_telegram_bindings (telegram_chat_id, session_id, provider_id, updated_at) VALUES ('42', 'assistant-1', 'claude', 1)").run();

    runMigrations(db);

    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(exists(db, "table", "design_share_links")).toBe(true);
    expect(exists(db, "index", "idx_design_share_links_design")).toBe(true);
    for (const table of ["schedule_chats", "schedule_ai_turns", "schedule_runtime"]) expect(exists(db, "table", table)).toBe(true);
    expect(columns(db, "schedules")).toEqual(expect.arrayContaining(["kind", "mode", "script", "state_json"]));
    expect(exists(db, "table", "session_logs")).toBe(false);
    expect(columns(db, "session_metadata")).toEqual(expect.arrayContaining(["spawned_by", "spawn_depth", "assistant"]));
    expect(db.query("SELECT assistant FROM session_metadata WHERE session_id = 'assistant-1'").get()).toEqual({ assistant: 1 });
    expect(db.query("SELECT session_id FROM assistant_telegram_bindings").all()).toEqual([{ session_id: "assistant-1" }]);
    db.close();
  });

  it("gives a database main left at 60 the Assistant's schema, keeping its rows", () => {
    const db = openCurrent();
    db.exec("ALTER TABLE session_metadata DROP COLUMN assistant");
    db.exec("DROP TABLE assistant_telegram_bindings");
    db.exec("DROP TABLE assistant_watches");
    db.exec("ALTER TABLE projects DROP COLUMN image");
    db.exec("PRAGMA user_version = 60");
    db.query("INSERT INTO session_metadata (session_id, spawned_by, spawn_depth) VALUES ('child-1', 'parent-1', 1)").run();

    runMigrations(db);

    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(columns(db, "session_metadata")).toContain("assistant");
    expect(exists(db, "table", "assistant_telegram_bindings")).toBe(true);
    expect(exists(db, "table", "assistant_watches")).toBe(true);
    expect(columns(db, "projects")).toContain("image");
    expect(db.query("SELECT spawned_by, spawn_depth, assistant FROM session_metadata").all())
      .toEqual([{ spawned_by: "parent-1", spawn_depth: 1, assistant: 0 }]);
    db.close();
  });

  it("runs every step again harmlessly on a database that already has all of it", () => {
    const db = openCurrent();
    db.exec("PRAGMA user_version = 56");
    runMigrations(db);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});
