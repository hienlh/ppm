/**
 * Retention for the trace: age first, then size, oldest rows first — and the file must really
 * shrink, which only happens because the database was created with incremental auto-vacuum.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb, getTraceDb, getTraceDbSizeBytes } from "../../../src/services/session-trace/session-trace-db.ts";
import { appendBatch, countTraceEvents, readEvents, recordTraceAlias, resolveTraceId, type TraceRow } from "../../../src/services/session-trace/session-trace-store.ts";
import { cleanupSessionTrace } from "../../../src/services/session-trace/session-trace-cleanup.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-trace-cleanup-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeTraceDb();
  _resetPpmDir();
});

afterAll(() => {
  closeTraceDb();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

function seed(traceId: string, count: number, ts: number, payloadBytes = 20): void {
  const rows: TraceRow[] = Array.from({ length: count }, (_, i) => ({
    traceId, turnId: null, ts: ts + i, source: "agent", origin: "unknown", providerId: null, refId: null,
    type: "tool_result", payloadJson: JSON.stringify({ type: "tool_result", output: "x".repeat(payloadBytes) }),
  }));
  appendBatch(rows);
}

describe("cleanupSessionTrace", () => {
  it("removes rows past the retention window and keeps newer ones", () => {
    seed("old", 5, NOW - 40 * DAY);
    seed("new", 3, NOW - DAY);
    const result = cleanupSessionTrace(30, 500, NOW);
    expect(result.deletedByAge).toBe(5);
    expect(readEvents("old")).toEqual([]);
    expect(readEvents("new")).toHaveLength(3);
  });

  it("brings the file under the size cap, oldest first, and the file really shrinks", () => {
    for (let i = 0; i < 30; i++) seed(`t${i}`, 20, NOW - (30 - i) * 60_000, 5_000); // ~3 MB
    const db = getTraceDb();
    const pagesBefore = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    expect(getTraceDbSizeBytes()).toBeGreaterThan(2 * 1024 * 1024);

    const result = cleanupSessionTrace(30, 1, NOW);

    expect(getTraceDbSizeBytes()).toBeLessThanOrEqual(1024 * 1024);
    expect(result.deletedBySize).toBeGreaterThan(0);
    expect((db.query("PRAGMA page_count").get() as { page_count: number }).page_count).toBeLessThan(pagesBefore);
    // The newest trace survives; the oldest went first.
    expect(readEvents("t29")).toHaveLength(20);
    expect(readEvents("t0")).toEqual([]);
    expect(countTraceEvents()).toBeLessThan(600);
  });

  it("drops an alias once nothing it points at is left, and keeps a live one however old", () => {
    seed("gone", 2, NOW - 40 * DAY);
    seed("alive", 2, NOW - DAY);
    recordTraceAlias("gone-alias", "gone");
    recordTraceAlias("alive-alias", "alive");
    getTraceDb().run("UPDATE trace_aliases SET ts = ?", [NOW - 90 * DAY]);

    cleanupSessionTrace(30, 500, NOW);

    expect(resolveTraceId("gone-alias")).toBe("gone-alias");
    expect(resolveTraceId("alive-alias")).toBe("alive");
  });
});
