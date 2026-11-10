import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { backupDbSync, verifyBackupFile } from "../../../../src/services/db-backup/db-backup-sync.ts";
import { formatBackupStamp, getBackupsDir } from "../../../../src/services/db-backup/db-backup-paths.ts";
import { listBackups } from "../../../../src/services/db-backup/db-backup.service.ts";
import { restoreDb } from "../../../../src/services/db-backup/db-backup-restore.ts";
import { assertIsolatedPpmHome } from "../../../helpers/assert-isolated-ppm-home.ts";
import { rmRetrying } from "../../../helpers/rm-retrying.ts";

// Restore, never delete: the bunfig preload's PPM_HOME shields later test
// files in this process from the real ~/.ppm.
const ORIGINAL_PPM_HOME = process.env.PPM_HOME;

let ppmHome: string;
let dbPath: string;

/** A small database with recognisable rows, standing in for the config store. */
function seedDb(path: string, keys: string[]): void {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO config (key, value) VALUES (?, ?)");
  for (const k of keys) insert.run(k, `value-of-${k}`);
  // Finalize before close: on Windows an unfinalized prepared statement keeps
  // the database file locked even after `close()`, so the temp dir teardown
  // then fails with EBUSY.
  insert.finalize();
  db.close();
}

beforeEach(() => {
  assertIsolatedPpmHome();
  ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-backup-test-"));
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
  dbPath = resolve(ppmHome, "ppm.db");
  seedDb(dbPath, ["auth", "port", "host"]);
});

afterEach(async () => {
  if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
  await rmRetrying(ppmHome);
});

describe("backupDbSync", () => {
  test("writes a snapshot that opens cleanly and carries the data", () => {
    const result = backupDbSync("manual", { dbPath });
    expect(existsSync(result.path)).toBe(true);
    expect(verifyBackupFile(result.path).ok).toBe(true);

    const snap = new Database(result.path, { readonly: true });
    const keys = snap.query("SELECT key FROM config ORDER BY key").all() as Array<{ key: string }>;
    snap.close();
    expect(keys.map((k) => k.key)).toEqual(["auth", "host", "port"]);
  });

  test("keeps snapshots inside PPM_HOME under an isolated home, never in the real home", () => {
    const result = backupDbSync("manual", { dbPath });
    expect(getBackupsDir().startsWith(ppmHome)).toBe(true);
    expect(result.path.startsWith(ppmHome)).toBe(true);
  });

  test("snapshots a database that is open and being written to", () => {
    // The production case: the server holds the database open. VACUUM INTO must
    // still produce a consistent copy without a checkpoint or a file copy.
    const live = new Database(dbPath);
    live.exec("INSERT INTO config (key, value) VALUES ('while-open', 'x')");
    const result = backupDbSync("hourly", { dbPath });
    live.close();

    const snap = new Database(result.path, { readonly: true });
    const row = snap.query("SELECT value FROM config WHERE key='while-open'").get() as { value: string } | null;
    snap.close();
    expect(row?.value).toBe("x");
  });

  test("reuses an already-open handle, as the pre-migration path does", () => {
    const handle = new Database(dbPath);
    try {
      const result = backupDbSync("premigrate", { dbPath, sourceDb: handle });
      expect(verifyBackupFile(result.path).ok).toBe(true);
      // The handle must survive for the migration that follows the snapshot.
      expect(handle.query("SELECT count(*) c FROM config").get()).toMatchObject({ c: 3 });
    } finally {
      handle.close();
    }
  });

  test("refuses a database that does not exist instead of writing an empty snapshot", () => {
    expect(() => backupDbSync("manual", { dbPath: resolve(ppmHome, "absent.db") })).toThrow(
      /No database to back up/,
    );
  });

  test("discards a snapshot of a corrupt source rather than keeping an unusable backup", () => {
    // The exact shape of the incident: the database file replaced by garbage.
    writeFileSync(dbPath, "secret");
    expect(() => backupDbSync("manual", { dbPath })).toThrow();
    expect(listBackups("ppm")).toEqual([]);
    // No `.partial` debris left behind either.
    const dir = getBackupsDir();
    const leftovers = existsSync(dir) ? readdirSync(dir) : [];
    expect(leftovers.filter((n) => n.endsWith(".partial"))).toEqual([]);
  });

  test("applies retention across repeated snapshots", () => {
    const hour = 3_600_000;
    const t0 = Date.UTC(2026, 6, 1);
    for (let i = 0; i < 12; i++) {
      backupDbSync("hourly", {
        dbPath,
        now: new Date(t0 + i * hour),
        retention: { recent: 3, daily: 1, weekly: 1 },
      });
    }
    // 12 hourly snapshots on one day collapse to the union of the tiers.
    expect(listBackups("ppm").length).toBeLessThanOrEqual(3 + 1 + 1);
  });
});

describe("restoreDb", () => {
  test("leaves the live database and directory untouched when copying fails", () => {
    const snapshot = backupDbSync("manual", { dbPath }).path;
    const before = readFileSync(dbPath);
    const files = readdirSync(ppmHome).sort();
    const failure = new Error("disk full");
    expect(() => restoreDb(snapshot, {
      dbPath, force: true,
      fs: { copyFileSync(_from, to) {
        writeFileSync(to, "partial copy");
        writeFileSync(`${to}-wal`, "partial wal");
        writeFileSync(`${to}-shm`, "partial shm");
        throw failure;
      } },
    })).toThrow(failure);
    expect(readFileSync(dbPath)).toEqual(before);
    expect(readdirSync(ppmHome).sort()).toEqual(files);
  });

  test("leaves the live database and directory untouched when staging is corrupt", () => {
    const snapshot = backupDbSync("manual", { dbPath }).path;
    const before = readFileSync(dbPath);
    const files = readdirSync(ppmHome).sort();
    expect(() => restoreDb(snapshot, {
      dbPath, force: true,
      fs: { copyFileSync(_from, to) {
        writeFileSync(to, "not a database");
        writeFileSync(`${to}-wal`, "partial wal");
        writeFileSync(`${to}-shm`, "partial shm");
      } },
    })).toThrow(/integrity_check/);
    expect(readFileSync(dbPath)).toEqual(before);
    expect(readdirSync(ppmHome).sort()).toEqual(files);
  });

  test("leaves the database and its sidecars in place when the final rename fails", () => {
    const snapshot = backupDbSync("manual", { dbPath }).path;
    const before = readFileSync(dbPath);
    writeFileSync(`${dbPath}-wal`, "original wal");
    writeFileSync(`${dbPath}-shm`, "original shm");
    const files = readdirSync(ppmHome).sort();
    let failed = false;
    expect(() => restoreDb(snapshot, {
      dbPath, force: true,
      fs: {
        renameSync(from, to) {
          if (to === dbPath && !failed) {
            failed = true;
            throw new Error("rename failed");
          }
          renameSync(from, to);
        },
      },
    })).toThrow("rename failed");
    expect(failed).toBe(true);
    expect(readFileSync(dbPath)).toEqual(before);
    expect(readFileSync(`${dbPath}-wal`, "utf8")).toBe("original wal");
    expect(readFileSync(`${dbPath}-shm`, "utf8")).toBe("original shm");
    expect(readdirSync(ppmHome).sort()).toEqual(files);
  });

  test("keeps a database at the live path after every filesystem step", () => {
    // A crash can land between any two steps; the old order renamed the live file
    // away first, so a crash before the swap left the directory with no database.
    const snapshot = backupDbSync("manual", { dbPath }).path;
    writeFileSync(`${dbPath}-wal`, "original wal");
    const missingAfter: string[] = [];
    const watch = <A extends unknown[]>(name: string, call: (...args: A) => void) => (...args: A) => {
      call(...args);
      if (!existsSync(dbPath)) missingAfter.push(`${name}(${args.join(", ")})`);
    };
    restoreDb(snapshot, {
      dbPath, force: true,
      fs: {
        copyFileSync: watch("copyFileSync", (from: string, to: string) => copyFileSync(from, to)),
        renameSync: watch("renameSync", (from: string, to: string) => renameSync(from, to)),
        linkSync: watch("linkSync", (existing: string, newPath: string) => linkSync(existing, newPath)),
      },
    });
    expect(missingAfter).toEqual([]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });

  test("archives by copying when the filesystem has no hard links", () => {
    const snapshot = backupDbSync("manual", { dbPath }).path;
    writeFileSync(dbPath, "secret");
    const result = restoreDb(snapshot, {
      dbPath, force: true,
      fs: { linkSync() { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); } },
    });
    expect(readFileSync(result.archivedTo!, "utf8")).toBe("secret");
    expect(verifyBackupFile(dbPath).ok).toBe(true);
  });

  test("changes nothing when the current database cannot be archived", () => {
    const snapshot = backupDbSync("manual", { dbPath }).path;
    const before = readFileSync(dbPath);
    const files = readdirSync(ppmHome).sort();
    expect(() => restoreDb(snapshot, {
      dbPath, force: true,
      fs: {
        linkSync() { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); },
        copyFileSync(from, to) {
          if (to.includes(".replaced-")) {
            writeFileSync(to, "half an archive");
            throw new Error("disk full");
          }
          copyFileSync(from, to);
        },
      },
    })).toThrow("disk full");
    expect(readFileSync(dbPath)).toEqual(before);
    expect(readdirSync(ppmHome).sort()).toEqual(files);
  });

  test("never replaces an earlier archive that has the same name", () => {
    const snapshot = backupDbSync("manual", { dbPath }).path;
    const now = new Date("2026-11-07T04:27:30Z");
    const earlier = `${dbPath}.replaced-${formatBackupStamp(now)}`;
    writeFileSync(earlier, "an earlier restore's evidence");
    const before = readFileSync(dbPath);
    expect(() => restoreDb(snapshot, { dbPath, force: true, now })).toThrow();
    expect(readFileSync(earlier, "utf8")).toBe("an earlier restore's evidence");
    expect(readFileSync(dbPath)).toEqual(before);
  });

  test("removes staging files after a successful restore", () => {
    const snapshot = backupDbSync("manual", { dbPath }).path;
    restoreDb(snapshot, { dbPath, force: true });
    expect(readdirSync(ppmHome).filter((name) => name.includes(".restoring-"))).toEqual([]);
  });

  test("restore drill: destroy the database, get the data back", () => {
    // The only test that proves the mechanism works end to end. A backup that
    // has never been restored is not known to be a backup — during the incident
    // two apparent recovery paths both failed at the moment they were needed.
    const snapshot = backupDbSync("manual", { dbPath }).path;

    writeFileSync(dbPath, "secret"); // reproduce the clobber
    expect(verifyBackupFile(dbPath).ok).toBe(false);

    const result = restoreDb(snapshot, { dbPath, force: true });
    expect(result.archivedTo).not.toBeNull();

    const db = new Database(dbPath, { readonly: true });
    const keys = db.query("SELECT key FROM config ORDER BY key").all() as Array<{ key: string }>;
    db.close();
    expect(keys.map((k) => k.key)).toEqual(["auth", "host", "port"]);
  });

  test("preserves the file it replaces instead of deleting it", () => {
    const snapshot = backupDbSync("manual", { dbPath }).path;
    writeFileSync(dbPath, "secret");
    const result = restoreDb(snapshot, { dbPath, force: true });
    // The broken file is the only evidence of what went wrong; destroying it
    // during recovery would make the next diagnosis impossible.
    expect(existsSync(result.archivedTo!)).toBe(true);
    expect(Bun.file(result.archivedTo!).size).toBe(6); // "secret"
  });

  test("clears the stale write-ahead log so it cannot replay onto the restored file", () => {
    const snapshot = backupDbSync("manual", { dbPath }).path;
    // A WAL left beside a restored database is replayed on the next open,
    // silently reintroducing the state being recovered from.
    writeFileSync(`${dbPath}-wal`, "stale wal bytes");
    writeFileSync(`${dbPath}-shm`, "stale shm bytes");

    restoreDb(snapshot, { dbPath, force: true });
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(verifyBackupFile(dbPath).ok).toBe(true);
  });

  test("refuses to restore a corrupt snapshot over a live database", () => {
    const bogus = resolve(ppmHome, "rotted-backup.db");
    writeFileSync(bogus, "not a database");
    expect(() => restoreDb(bogus, { dbPath, force: true })).toThrow(/integrity_check/);
    // The database that was still fine must be untouched.
    expect(verifyBackupFile(dbPath).ok).toBe(true);
  });

  test("refuses a missing snapshot", () => {
    expect(() => restoreDb(resolve(ppmHome, "nope.db"), { dbPath, force: true })).toThrow(/not found/);
  });
});
