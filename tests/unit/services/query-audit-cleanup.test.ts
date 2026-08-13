import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { getAuditDb, getAuditDbSizeBytes, closeAuditDb } from "../../../src/services/query-audit/query-audit-db.ts";
import { cleanupQueryAudit, clearQueryAudit } from "../../../src/services/query-audit/query-audit-cleanup.ts";
import { insertQueryLog, countQueryLogs } from "../../../src/services/query-audit/query-audit.service.ts";

const tempDirs: string[] = [];

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-audit-cleanup-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeAuditDb();
  _resetPpmDir();
  getAuditDb();
});

afterAll(() => {
  closeAuditDb();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

function seed(count: number, ageDays = 0, blobBytes = 0): void {
  const rows = blobBytes > 0 ? [{ blob: "x".repeat(blobBytes) }] : null;
  for (let i = 0; i < count; i++) {
    insertQueryLog({
      source: "editor", actor: "human", operation: "select",
      sql: "SELECT 1", status: "ok", rows,
    });
  }
  if (ageDays > 0) {
    getAuditDb().run(
      "UPDATE query_log SET created_at = datetime('now', ?) WHERE created_at >= datetime('now', '-1 minute')",
      [`-${ageDays} days`],
    );
  }
}

describe("cleanupQueryAudit — age", () => {
  it("removes entries past the retention window and keeps newer ones", () => {
    seed(5, 40);
    seed(3);

    const result = cleanupQueryAudit(30, 500);

    expect(result.deletedByAge).toBe(5);
    expect(countQueryLogs()).toBe(3);
  });

  it("keeps everything when nothing is old enough", () => {
    seed(4);
    expect(cleanupQueryAudit(30, 500).deletedByAge).toBe(0);
    expect(countQueryLogs()).toBe(4);
  });
});

describe("cleanupQueryAudit — size", () => {
  it("shrinks the file on disk, not just the row count", () => {
    // ~16KB of sampled result per entry.
    seed(400, 0, 16 * 1024);
    const before = getAuditDbSizeBytes();
    expect(before).toBeGreaterThan(2 * 1024 * 1024);

    const result = cleanupQueryAudit(30, 1);

    expect(result.deletedBySize).toBeGreaterThan(0);
    expect(getAuditDbSizeBytes()).toBeLessThanOrEqual(1024 * 1024);
    expect(result.freedBytes).toBeGreaterThan(0);
  });

  it("drops the oldest entries first", () => {
    seed(300, 5, 16 * 1024);
    seed(300, 0, 16 * 1024);

    cleanupQueryAudit(30, 1);

    const remaining = getAuditDb()
      .query("SELECT MIN(created_at) as oldest FROM query_log")
      .get() as { oldest: string | null };
    const cutoff = getAuditDb()
      .query("SELECT datetime('now', '-1 days') as cutoff")
      .get() as { cutoff: string };

    expect(remaining.oldest).not.toBeNull();
    expect(remaining.oldest! > cutoff.cutoff).toBe(true);
  });

  it("keeps as much history as the cap allows instead of wiping the log", () => {
    seed(400, 0, 16 * 1024);

    cleanupQueryAudit(30, 2);

    // A fixed 500-row batch used to blow past the cap and empty the table.
    expect(countQueryLogs()).toBeGreaterThan(30);
    expect(getAuditDbSizeBytes()).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("stops instead of looping when the table is already empty", () => {
    const result = cleanupQueryAudit(30, 10);
    expect(result.deletedBySize).toBe(0);
    expect(countQueryLogs()).toBe(0);
  });
});

describe("clearQueryAudit", () => {
  it("removes every entry and returns the space", () => {
    seed(200, 0, 16 * 1024);
    const before = getAuditDbSizeBytes();

    expect(clearQueryAudit()).toBe(200);
    expect(countQueryLogs()).toBe(0);
    expect(getAuditDbSizeBytes()).toBeLessThan(before);
  });
});
