/**
 * Settings → Storage: the read-only overview of ppm.db, its snapshots and the session trace, and
 * the session trace's limits. Each test runs in a PPM_HOME of its own, so "missing" really is
 * missing and the backups folder is the isolated one under it.
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { closeTraceDb, getTraceDbPath } from "../../../src/services/session-trace/session-trace-db.ts";
import { appendBatch } from "../../../src/services/session-trace/session-trace-store.ts";
import { DEFAULT_CONFIG } from "../../../src/types/config.ts";
import { SESSION_TRACE_MIN_RETENTION_DAYS, SESSION_TRACE_MIN_SIZE_MB } from "../../../src/shared/storage-settings.ts";

const app = new Hono().route("/settings", settingsRoutes);
const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;
let processConfig: unknown;
let home = "";

beforeAll(() => {
  processConfig = structuredClone((configService as any).config);
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-storage-routes-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeTraceDb();
  _resetPpmDir();
  setDb(openTestDb());
  configService.load();
});

afterAll(() => {
  closeTraceDb();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  setDb(openTestDb());
  (configService as any).config = processConfig;
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

function putLimits(body: unknown) {
  return app.request("/settings/session-trace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /settings/storage", () => {
  it("reads missing files and folders as empty, without creating the session trace", async () => {
    const res = await app.request("/settings/storage");
    expect(res.status).toBe(200);
    const { ok, data } = await res.json();
    expect(ok).toBe(true);
    // The test database is in memory, so there is no ppm.db file to measure.
    expect(data.appDb).toEqual({ path: join(home, "ppm.db"), sizeBytes: 0 });
    expect(data.backups).toEqual({ dir: join(home, "backups"), dbStem: "ppm", count: 0, totalBytes: 0, newest: null, others: [] });
    expect(data.sessionTrace).toEqual({
      path: join(home, "session-trace.db"),
      sizeBytes: 0,
      oldestTs: null,
      retention_days: DEFAULT_CONFIG.session_trace.retention_days,
      max_size_mb: DEFAULT_CONFIG.session_trace.max_size_mb,
    });
    expect(existsSync(getTraceDbPath())).toBe(false);
  });

  it("measures ppm.db with its -wal, the snapshots, and the trace's oldest row", async () => {
    writeFileSync(join(home, "ppm.db"), Buffer.alloc(4096));
    writeFileSync(join(home, "ppm.db-wal"), Buffer.alloc(1000));

    const backups = join(home, "backups");
    mkdirSync(backups);
    writeFileSync(join(backups, "ppm-20261101T000000Z-hourly.db"), Buffer.alloc(300));
    writeFileSync(join(backups, "ppm-20261102T000000Z-premigrate.db"), Buffer.alloc(200));
    writeFileSync(join(backups, "not-a-snapshot.txt"), Buffer.alloc(999));
    writeFileSync(join(backups, "ppm-20261103T000000Z-hourly.db.partial"), Buffer.alloc(999));
    // A dev instance shares the folder: its snapshots are listed apart and never count as this one's newest.
    writeFileSync(join(backups, "ppm.dev-20261104T000000Z-hourly.db"), Buffer.alloc(70));
    writeFileSync(join(backups, "ppm.dev-20261105T000000Z-hourly.db"), Buffer.alloc(30));
    // The newest is decided by when the file was written, not by the stamp in its name.
    utimesSync(join(backups, "ppm-20261101T000000Z-hourly.db"), new Date(2026, 10, 5), new Date(2026, 10, 5));
    utimesSync(join(backups, "ppm-20261102T000000Z-premigrate.db"), new Date(2026, 10, 3), new Date(2026, 10, 3));

    appendBatch([1_700_000_000_500, 1_700_000_000_000].map((ts) => ({
      traceId: "t1", turnId: null, ts, source: "agent" as const, origin: "unknown" as const, providerId: null, refId: null,
      type: "text", payloadJson: "{}",
    })));

    const { data } = await (await app.request("/settings/storage")).json();
    expect(data.appDb.sizeBytes).toBe(5096);
    expect(data.backups.count).toBe(2);
    expect(data.backups.totalBytes).toBe(500);
    expect(data.backups.newest.name).toBe("ppm-20261101T000000Z-hourly.db");
    expect(data.backups.newest.mtimeMs).toBe(new Date(2026, 10, 5).getTime());
    expect(data.backups.dbStem).toBe("ppm");
    expect(data.backups.others).toEqual([{ dbStem: "ppm.dev", count: 2, totalBytes: 100 }]);
    expect(data.sessionTrace.oldestTs).toBe(1_700_000_000_000);
    expect(data.sessionTrace.sizeBytes).toBeGreaterThan(0);
  });
});

describe("PUT /settings/session-trace", () => {
  it("saves whole numbers at or above the minimums and answers the refreshed trace block", async () => {
    const res = await putLimits({ retention_days: SESSION_TRACE_MIN_RETENTION_DAYS, max_size_mb: SESSION_TRACE_MIN_SIZE_MB });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ retention_days: SESSION_TRACE_MIN_RETENTION_DAYS, max_size_mb: SESSION_TRACE_MIN_SIZE_MB, sizeBytes: 0, oldestTs: null });
    expect(configService.get("session_trace")).toEqual({ retention_days: SESSION_TRACE_MIN_RETENTION_DAYS, max_size_mb: SESSION_TRACE_MIN_SIZE_MB });
  });

  it("keeps the field a partial body leaves out", async () => {
    await putLimits({ retention_days: 14, max_size_mb: 200 });
    const { data } = await (await putLimits({ max_size_mb: 300 })).json();
    expect(data.retention_days).toBe(14);
    expect(data.max_size_mb).toBe(300);
  });

  it.each([
    [{ retention_days: 0 }],
    [{ retention_days: 1.5 }],
    [{ retention_days: "7" }],
    [{ max_size_mb: SESSION_TRACE_MIN_SIZE_MB - 1 }],
    [{ max_size_mb: 100.5 }],
    [{ max_size_mb: null }],
  ])("refuses %j with 400 and changes nothing", async (body) => {
    const before = structuredClone(configService.get("session_trace"));
    const res = await putLimits(body);
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(configService.get("session_trace")).toEqual(before);
  });

  it("applies a shorter retention at once instead of at the next daily cleanup", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    appendBatch([now - 10 * day, now - 5 * day, now - 60_000].map((ts) => ({
      traceId: "t1", turnId: null, ts, source: "agent" as const, origin: "unknown" as const, providerId: null, refId: null,
      type: "text", payloadJson: "{}",
    })));

    const { data } = await (await putLimits({ retention_days: 3 })).json();
    expect(data.retention_days).toBe(3);
    // Both rows older than three days are gone; the recent one stays.
    expect(data.oldestTs).toBe(now - 60_000);
  });

  it("refuses a body that is not JSON or not an object", async () => {
    expect((await putLimits("not json")).status).toBe(400);
    expect((await putLimits([1, 2])).status).toBe(400);
  });
});
