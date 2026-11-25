/**
 * Migration 83: the notification feed. Only adds the `notification_feed` table and its two
 * indexes. A database at 82 is made by running the ladder and dropping them again, so the step
 * runs against the real earlier shape.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../src/services/db.service.ts";

const FEED_INDEXES = ["notification_feed_created", "notification_feed_session"];
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const tableNames = (db: Database) => (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
const indexNames = (db: Database) => (db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);

function fresh(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  return db;
}

/** A database the way migration 82 left it, with a project row in it. */
function databaseAt82(): Database {
  const db = fresh();
  for (const i of FEED_INDEXES) db.exec(`DROP INDEX ${i}`);
  db.exec("DROP TABLE notification_feed");
  db.query("INSERT INTO projects (path, name) VALUES ('/tmp/demo', 'demo')").run();
  db.exec("PRAGMA user_version = 82");
  return db;
}

describe("migration 83: notification feed", () => {
  it("brings a fresh database to the current version with the feed table", () => {
    const db = fresh();
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(83);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableNames(db)).toContain("notification_feed");
  });

  it("adds the feed to a database at 82 and keeps what was there", () => {
    const db = databaseAt82();
    expect(tableNames(db)).not.toContain("notification_feed");
    runMigrations(db);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect((db.query("PRAGMA table_info(notification_feed)").all() as Array<{ name: string }>).map((c) => c.name)).toEqual([
      "id", "kind", "project", "session_id", "schedule_id", "title", "body", "created_at", "read_at",
    ]);
    for (const i of FEED_INDEXES) expect(indexNames(db)).toContain(i);
    expect(db.query("SELECT name FROM projects WHERE path = '/tmp/demo'").get()).toEqual({ name: "demo" });

    db.query("INSERT INTO notification_feed (kind, schedule_id, title, created_at) VALUES ('schedule', '7', 'Schedule: nightly', 1)").run();
    expect(db.query("SELECT kind, project, session_id, schedule_id, body, read_at FROM notification_feed").get()).toEqual({
      kind: "schedule", project: "", session_id: null, schedule_id: "7", body: "", read_at: null,
    });
  });

  it("stays at 82 when an index cannot be created, rather than claiming 83", () => {
    const db = databaseAt82();
    // A table holding the index's name makes that statement fail.
    db.exec("CREATE TABLE notification_feed_created (x)");
    expect(() => runMigrations(db)).toThrow("already a table named notification_feed_created");
    expect(version(db)).toBe(82);
  });
});
