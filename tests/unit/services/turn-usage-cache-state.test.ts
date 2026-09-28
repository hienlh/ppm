import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { getDb, closeDb, insertTurnUsage, getLastTurnCacheState } from "../../../src/services/db.service.ts";

const tempDirs: string[] = [];

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-turn-cache-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeDb();
  _resetPpmDir();
  getDb();
});

afterAll(() => {
  closeDb();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger */ }
  }
});

function seed(over: Partial<Parameters<typeof insertTurnUsage>[0]> = {}): void {
  insertTurnUsage({
    sessionId: "s1",
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 58_000,
    cacheWriteTokens: 1_000,
    coldStart: false,
    ...over,
  });
}

/** Overwrite `recorded_at` with the exact UTC text SQLite's `datetime('now')` produces. */
function stampLastRow(utcText: string): void {
  getDb().query("UPDATE turn_usage SET recorded_at = ? WHERE id = (SELECT MAX(id) FROM turn_usage)")
    .run(utcText);
}

describe("getLastTurnCacheState", () => {
  it("survives the server restart that drops the in-memory session entry", () => {
    seed({ contextTokens: 59_000 });
    expect(getLastTurnCacheState("s1")).toMatchObject({
      prefixTokens: 60_000,
      contextTokens: 59_000,
    });
  });

  // The whole reason the notice went silent: `SessionEntry` is dropped five minutes after
  // the last tab leaves, while the cache it describes lives for an hour.
  it("answers for a session this process never served", () => {
    expect(getLastTurnCacheState("never-seen")).toBeNull();
  });

  it("reads the newest turn, not the first", () => {
    seed({ contextTokens: 10_000 });
    seed({ contextTokens: 120_000 });
    expect(getLastTurnCacheState("s1")?.contextTokens).toBe(120_000);
  });

  // `datetime('now')` is UTC with no zone suffix, which `Date` reads as LOCAL time. In
  // Asia/Saigon that is seven hours of error — enough to put the last turn in the future and
  // silence the notice entirely.
  //
  // The TZ override is the whole test. `bun test` runs under **TZ=UTC**, where a zoneless
  // timestamp and a UTC one parse identically — so without this the assertion passes against
  // the broken code and the regression it exists to catch would land unnoticed.
  it("reads SQLite's zoneless timestamp as UTC, not as local time", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Saigon";
    try {
      seed();
      stampLastRow("2026-08-31 16:28:33");
      expect(getLastTurnCacheState("s1")?.endedAtMs).toBe(Date.parse("2026-08-31T16:28:33Z"));
    } finally {
      if (tz == null) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  // The window the API reported has to outlive the process, or a reopened session falls back
  // to the credential-shaped guess this replaced.
  it("carries the measured cache window across a restart", () => {
    seed({ cacheTtlMs: 3_600_000 });
    expect(getLastTurnCacheState("s1")?.cacheTtlMs).toBe(3_600_000);
  });

  it("reports an unreported window as absent, so the provider's guess still stands", () => {
    seed({ cacheTtlMs: undefined });
    expect(getLastTurnCacheState("s1")).not.toHaveProperty("cacheTtlMs");
  });

  // The window where this matters is between a compaction and the user's next message, which
  // a restart lands inside often enough to be worth surviving.
  it("carries a compaction across a restart", () => {
    seed({ compactedAt: 1_800_000_000_000 });
    expect(getLastTurnCacheState("s1")?.compactedAt).toBe(1_800_000_000_000);
  });

  it("reports no compaction as absent, not as an epoch timestamp", () => {
    seed({ compactedAt: undefined });
    expect(getLastTurnCacheState("s1")).not.toHaveProperty("compactedAt");
  });

  it("reports an unmeasured context as absent rather than as zero", () => {
    seed({ contextTokens: undefined });
    const state = getLastTurnCacheState("s1");
    expect(state?.prefixTokens).toBe(60_000);
    expect(state).not.toHaveProperty("contextTokens");
  });

  it("does not answer with a timestamp it could not parse", () => {
    seed();
    stampLastRow("not a date");
    expect(getLastTurnCacheState("s1")).toBeNull();
  });
});
