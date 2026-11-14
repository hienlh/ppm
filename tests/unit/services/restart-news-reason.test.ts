/**
 * Why a server start happened, as the run log and the supervisor's hand-over record it: each kind
 * the supervisor names, a crash nobody named (the previous run left no stop), the first start ever,
 * and the `ppm restart --reason` request file the supervisor consumes once.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseReasonArg, readStartReasonEnv, RESTART_REQUEST_MAX_AGE_MS, startReasonEnv, takeRestartRequest, writeRestartRequest,
  START_DETAIL_ENV, START_REASON_ENV,
} from "../../../src/services/restart-news/start-reason.ts";
import { recordServerStart, recordServerStop, type RunLogStore } from "../../../src/services/restart-news/server-run-log.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* windows handles */ } });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "ppm-restart-reason-")); dirs.push(d); return d; };

function memoryStore(): RunLogStore & { raw: () => string | null } {
  let json: string | null = null;
  return { load: () => json, save: (j) => { json = j; }, raw: () => json };
}

const T0 = Date.UTC(2026, 10, 15, 1, 0, 0);

/** One run from start to (optionally) a clean stop, then the next start as the supervisor described it. */
function cycle(env: Record<string, string>, opts: { cleanStop: boolean; from?: string; to?: string; first?: boolean } = { cleanStop: true }) {
  const store = memoryStore();
  if (!opts.first) {
    const prev = recordServerStart(store, { now: T0, pid: 100, version: opts.from ?? "0.25.6", given: null });
    if (opts.cleanStop) recordServerStop(store, prev.run.startedAt, { now: T0 + 60_000, trigger: "SIGTERM" });
  }
  return recordServerStart(store, { now: T0 + 120_000, pid: 200, version: opts.to ?? "0.25.7", given: readStartReasonEnv(env) });
}

describe("the start a supervisor names", () => {
  it("records an upgrade with the version it came from", () => {
    const s = cycle(startReasonEnv({ kind: "upgrade" }), { cleanStop: true, from: "0.25.6", to: "0.25.7" });
    expect(s.restart).toMatchObject({ kind: "upgrade", fromVersion: "0.25.6", toVersion: "0.25.7", cleanStop: true, stopTrigger: "SIGTERM" });
    expect(s.restart.stoppedAt).toBe(T0 + 60_000);
  });

  it("records the health check's kill as the watchdog's, with no clean stop behind it", () => {
    const s = cycle(startReasonEnv({ kind: "watchdog", detail: "the server stopped answering health checks" }), { cleanStop: false, from: "0.25.7", to: "0.25.7" });
    expect(s.restart).toMatchObject({ kind: "watchdog", detail: "the server stopped answering health checks", cleanStop: false });
    expect(s.restart.fromVersion).toBeUndefined();
  });

  it("records a recycle and a crash with their detail", () => {
    expect(cycle(startReasonEnv({ kind: "recycle", detail: "RAM 92%" })).restart).toMatchObject({ kind: "recycle", detail: "RAM 92%" });
    const crash = cycle(startReasonEnv({ kind: "crash", detail: "exit 1, signal none, after 30s" }), { cleanStop: false });
    expect(crash.restart).toMatchObject({ kind: "crash", detail: "exit 1, signal none, after 30s", cleanStop: false });
  });

  it("records a manual restart and a boot", () => {
    expect(cycle(startReasonEnv({ kind: "manual" })).restart.kind).toBe("manual");
    expect(cycle(startReasonEnv({ kind: "boot", detail: "the machine started 2 min earlier" }), { cleanStop: false }).restart)
      .toMatchObject({ kind: "boot", cleanStop: false });
  });
});

describe("a start nobody named", () => {
  it("is a crash of unknown cause when the previous run left no stop", () => {
    const s = cycle({}, { cleanStop: false });
    expect(s.restart.kind).toBe("crash");
    expect(s.restart.cleanStop).toBe(false);
    expect(s.restart.detail).toContain("cause unknown");
  });

  it("is unknown after a clean stop", () => {
    expect(cycle({}, { cleanStop: true }).restart).toMatchObject({ kind: "unknown", cleanStop: true });
  });

  it("is unknown on the first recorded start, with nothing said about a previous run", () => {
    const s = cycle({}, { cleanStop: true, first: true });
    expect(s.previous).toBeNull();
    expect(s.restart.kind).toBe("unknown");
    expect(s.restart.cleanStop).toBeUndefined();
    expect(s.restart.fromVersion).toBeUndefined();
  });

  it("refuses a reason that is not one of the kinds", () => {
    expect(readStartReasonEnv({ [START_REASON_ENV]: "because" })).toBeNull();
    expect(readStartReasonEnv({ [START_REASON_ENV]: "manual", [START_DETAIL_ENV]: "a‮b\nc" })).toEqual({ kind: "manual", detail: "a b c" });
  });
});

describe("the run log", () => {
  it("keeps the last 20 runs and survives garbage", () => {
    const store = memoryStore();
    for (let i = 0; i < 25; i++) recordServerStart(store, { now: T0 + i, pid: i, version: "1", given: null });
    expect((JSON.parse(store.raw()!) as { runs: unknown[] }).runs).toHaveLength(20);
    store.save("{not json");
    expect(recordServerStart(store, { now: T0 + 99, pid: 1, version: "1", given: null }).previous).toBeNull();
  });

  it("a store that cannot write does not stop the start", () => {
    const store: RunLogStore = { load: () => null, save: () => { throw new Error("disk full"); } };
    expect(recordServerStart(store, { now: T0, pid: 1, version: "1", given: null }).restart.kind).toBe("unknown");
    expect(() => recordServerStop(store, T0, { now: T0 + 1, trigger: "SIGTERM" })).not.toThrow();
  });
});

describe("ppm restart --reason", () => {
  it("parses a kind by name, a kind with a note, and free text as a manual restart", () => {
    expect(parseReasonArg("watchdog")).toEqual({ kind: "watchdog" });
    expect(parseReasonArg("recycle: RAM at 91%")).toEqual({ kind: "recycle", detail: "RAM at 91%" });
    expect(parseReasonArg("nightly cleanup")).toEqual({ kind: "manual", detail: "nightly cleanup" });
    expect(parseReasonArg("")).toEqual({ kind: "manual" });
  });

  it("is consumed once by the supervisor's next spawn, and ignored when stale", () => {
    const dir = scratch();
    writeRestartRequest(dir, { kind: "watchdog", detail: "RAM" }, 1_000_000);
    expect(takeRestartRequest(dir, 1_000_500)).toEqual({ kind: "watchdog", detail: "RAM" });
    expect(takeRestartRequest(dir, 1_000_600)).toBeNull();
    writeRestartRequest(dir, { kind: "manual" }, 1_000_000);
    expect(takeRestartRequest(dir, 1_000_000 + RESTART_REQUEST_MAX_AGE_MS + 1)).toBeNull();
    expect(existsSync(join(dir, ".restart-reason"))).toBe(false);
  });

  it("reads a request file written with a byte-order mark and drops a malformed one", () => {
    const dir = scratch();
    writeFileSync(join(dir, ".restart-reason"), `﻿${JSON.stringify({ kind: "recycle", at: 5_000 })}`);
    expect(takeRestartRequest(dir, 5_001)).toEqual({ kind: "recycle" });
    writeFileSync(join(dir, ".restart-reason"), JSON.stringify({ kind: "nope", at: 5_000 }));
    expect(takeRestartRequest(dir, 5_001)).toBeNull();
  });
});
