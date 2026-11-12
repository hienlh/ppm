import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

/**
 * Source-level assertions that the snapshot mechanism stays wired into the
 * three places that make it automatic.
 *
 * Behaviour tests cover what a snapshot *does*; nothing else covers whether it
 * is still *scheduled*. Silently unwiring the hourly tick or the pre-migration
 * hook would leave every behaviour test green while the database quietly stops
 * being protected — the same shape of failure as a backup that exists but
 * cannot be restored.
 */

const SRC = resolve(import.meta.dir, "../../../../src");

async function read(rel: string): Promise<string> {
  return Bun.file(resolve(SRC, rel)).text();
}

describe("automatic snapshot call sites", () => {
  test("migrations are preceded by a snapshot, before runMigrations executes", async () => {
    const src = await read("services/db.service.ts");
    // Order matters: a snapshot taken after the migration has already rewritten
    // the file protects nothing.
    const backupAt = src.indexOf("backupBeforeMigrations(db)");
    const migrateAt = src.indexOf("runMigrations(db)");
    expect(backupAt).toBeGreaterThan(-1);
    expect(migrateAt).toBeGreaterThan(-1);
    expect(backupAt).toBeLessThan(migrateAt);
    expect(src).toMatch(/backupDbSync\("premigrate"/);
  });

  test("a brand-new database is not snapshotted, an out-of-date one is", async () => {
    const src = await read("services/db.service.ts");
    expect(src).toMatch(/user_version >= CURRENT_SCHEMA_VERSION\) return;/);
    expect(src).toMatch(/user_version === 0\) return;/);
  });

  test("a snapshot failure never blocks the database from opening", async () => {
    const src = await read("services/db.service.ts");
    // The whole hook sits in a try/catch that logs and continues: losing a
    // snapshot is recoverable, refusing to boot is not.
    expect(src).toMatch(/Pre-migration snapshot FAILED \(continuing\)/);
  });

  test("the supervisor schedules both a start-up and an hourly snapshot", async () => {
    const src = await read("services/supervisor.ts");
    expect(src).toMatch(/runDbBackupTick\("start"\)/);
    expect(src).toMatch(/setInterval\(\(\) => void runDbBackupTick\("hourly"\), DB_BACKUP_INTERVAL_MS\)/);
    expect(src).toMatch(/const DB_BACKUP_INTERVAL_MS = 3_600_000;/);
  });

  test("the supervisor warns when snapshots stop keeping up", async () => {
    const src = await read("services/supervisor.ts");
    // A silently-failing backup is worse than none: it is the state where
    // recovery is believed to be available and is not.
    expect(src).toMatch(/DB_BACKUP_STALE_WARN_MS/);
    expect(src).toMatch(/no backups exist yet/);
  });

  test("every supervisor teardown that stops the upgrade timers stops the backup timers too", async () => {
    const src = await read("services/supervisor.ts");
    const upgradeClears = src.match(/if \(upgradeCheckTimer\) clearInterval\(upgradeCheckTimer\);/g) ?? [];
    const backupClears = src.match(/if \(dbBackupTimer\) clearInterval\(dbBackupTimer\);/g) ?? [];
    expect(upgradeClears.length).toBeGreaterThan(0);
    expect(backupClears.length).toBe(upgradeClears.length);
  });

  test("the CLI exposes both backup and restore", async () => {
    const src = await read("cli/commands/backup-cmd.ts");
    expect(src).toMatch(/\.command\("backup"\)/);
    expect(src).toMatch(/\.command\("restore"\)/);
    // Restoring under a running server would have it writing into a file being
    // replaced, so that has to be an explicit opt-in.
    expect(src).toMatch(/--force/);
    const groups = await read("cli/register-command-groups.ts");
    expect(groups).toMatch(/registerBackupCommands\(program\)/);
  });
});
