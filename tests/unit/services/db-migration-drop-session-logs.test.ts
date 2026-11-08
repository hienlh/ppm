/**
 * Migration 59 drops `session_logs`, which duplicated the session trace and was never pruned, and
 * the database opened through `getDb()` is then compacted, because most of the file is free pages.
 * A file with few free pages is left alone, and a failed rebuild is retried at the next open.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDbPragmas,
  closeDb,
  compactIfMostlyFree,
  CURRENT_SCHEMA_VERSION,
  fileSizeWithWal,
  getDb,
  getDbPath,
  openTestDb,
  runMigrations,
  setDb,
} from "../../../src/services/db.service.ts";
import { getBackupsDir } from "../../../src/services/db-backup/db-backup-paths.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-drop-session-logs-"));
  tempDirs.push(dir);
  return join(dir, name);
}

/** A database at schema 58 — every installed release — still carrying the table, its indexes and `rows` log lines. */
function seedV58(database: Database, rows: number): void {
  applyDbPragmas(database);
  runMigrations(database);
  database.exec(`
    CREATE TABLE session_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_session_logs_session ON session_logs(session_id);
    CREATE INDEX idx_session_logs_created ON session_logs(created_at);
    PRAGMA user_version = 58;
  `);
  const insert = database.query("INSERT INTO session_logs (session_id, level, message) VALUES (?, 'TEXT', ?)");
  database.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`s${i % 50}`, `line ${i} ${"x".repeat(200)}`);
  })();
}

function names(database: Database, type: "table" | "index"): string[] {
  return (database.query("SELECT name FROM sqlite_master WHERE type = ?").all(type) as { name: string }[]).map((r) => r.name);
}

describe("migration 59: drop session_logs", () => {
  it("a new database never has the table", () => {
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    expect(CURRENT_SCHEMA_VERSION).toBe(59);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(names(db, "table")).not.toContain("session_logs");
    db.close();
  });

  it("drops the table and both indexes from an upgraded database, once", () => {
    const db = new Database(":memory:");
    seedV58(db, 10);

    runMigrations(db);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(names(db, "table")).not.toContain("session_logs");
    expect(names(db, "index").filter((n) => n.startsWith("idx_session_logs"))).toEqual([]);

    // Already current: a second run changes nothing.
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it("reaches 59 when a database at 58 had already lost the table", () => {
    const db = new Database(":memory:");
    applyDbPragmas(db);
    runMigrations(db);
    db.exec("PRAGMA user_version = 58");
    runMigrations(db);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    db.close();
  });
});

describe("compactIfMostlyFree", () => {
  it("shrinks the file and its -wal after the drop", () => {
    const path = tempPath("ppm.db");
    const db = new Database(path);
    seedV58(db, 20_000);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = fileSizeWithWal(path);

    runMigrations(db);
    compactIfMostlyFree(db, path);

    const after = fileSizeWithWal(path);
    expect(after).toBeLessThan(before / 5);
    expect(statSync(`${path}-wal`).size).toBe(0);
    db.close();
  }, 30_000);

  it("logs and carries on when VACUUM cannot run, and retries at the next call", () => {
    const path = tempPath("ppm.db");
    const db = new Database(path);
    seedV58(db, 20_000);
    runMigrations(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = fileSizeWithWal(path);

    // VACUUM is refused inside a transaction; the open must still succeed and the file stays as it was.
    db.exec("BEGIN");
    expect(() => compactIfMostlyFree(db, path)).not.toThrow();
    db.exec("ROLLBACK");
    expect(fileSizeWithWal(path)).toBe(before);

    // Nothing remembers the failure: the free pages are still there, so the next open compacts.
    compactIfMostlyFree(db, path);
    expect(fileSizeWithWal(path)).toBeLessThan(before / 5);
    db.close();
  }, 30_000);

  it("leaves a file with few free pages alone", () => {
    const path = tempPath("ppm.db");
    const db = new Database(path);
    applyDbPragmas(db);
    runMigrations(db);
    db.exec("CREATE TABLE t (x TEXT)");
    const insert = db.query("INSERT INTO t (x) VALUES (?)");
    db.transaction(() => { for (let i = 0; i < 20_000; i++) insert.run("y".repeat(200)); })();
    db.exec("DELETE FROM t WHERE rowid % 10 = 0");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = fileSizeWithWal(path);

    compactIfMostlyFree(db, path);
    expect(fileSizeWithWal(path)).toBe(before);
    db.close();
  }, 30_000);
});

describe("getDb on an upgraded file", () => {
  it("snapshots first, migrates, then compacts the file", () => {
    // A PPM_HOME of its own: the process-wide one may hold a ppm.db another test wrote as a fixture.
    const originalHome = process.env.PPM_HOME;
    const home = join(tempPath("home"), "..");
    process.env.PPM_HOME = home;
    _resetPpmDir();
    closeDb();
    const path = getDbPath();
    expect(path).toBe(join(home, "ppm.db"));
    try {
      const seed = new Database(path);
      seedV58(seed, 20_000);
      seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      seed.close();
      const before = fileSizeWithWal(path);

      const db = getDb();
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(names(db, "table")).not.toContain("session_logs");
      expect(fileSizeWithWal(path)).toBeLessThan(before / 5);
      // The pre-migration snapshot still holds the old table: it is the way back.
      const premigrate = readdirSync(getBackupsDir()).find((n) => n.endsWith("-premigrate.db"));
      expect(premigrate).toBeDefined();
      const snapshot = new Database(join(getBackupsDir(), premigrate!), { readonly: true });
      expect((snapshot.query("SELECT COUNT(*) AS n FROM session_logs").get() as { n: number }).n).toBe(20_000);
      snapshot.close();
    } finally {
      closeDb();
      setDb(openTestDb());
      process.env.PPM_HOME = originalHome;
      _resetPpmDir();
    }
  }, 30_000);
});
