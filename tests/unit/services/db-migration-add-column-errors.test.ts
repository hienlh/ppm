/**
 * The steps that add the Assistant mark and the project avatar column used to swallow every
 * `ALTER TABLE` error and raise `user_version` anyway, so a failure other than "the column is
 * already there" (another process holding the write lock past the busy timeout, say) left a
 * database every later start took for complete — and that could no longer load its config.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Database } from "bun:sqlite";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../../src/services/db.service.ts";

function migratedDb(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  return db;
}

const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("a migration step that adds a column", () => {
  // A view stands in for any failure that is not "duplicate column": SQLite refuses to alter one.
  for (const [table, before] of [["session_metadata", 56], ["projects", 58]] as const) {
    it(`does not raise user_version past ${before} when ${table} cannot be altered`, () => {
      const db = migratedDb();
      db.exec(`DROP TABLE ${table}; CREATE VIEW ${table} AS SELECT 'x' AS name; PRAGMA user_version = ${before}`);
      expect(() => runMigrations(db)).toThrow();
      expect(version(db)).toBe(before);
      db.close();
    });
  }

  it("goes on when the column is already there, as a build that ran before this one leaves it", () => {
    const db = migratedDb();
    db.exec("PRAGMA user_version = 56");
    runMigrations(db);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});
