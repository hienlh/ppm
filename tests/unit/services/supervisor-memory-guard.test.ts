import { describe, expect, it } from "bun:test";
import {
  healthMissCounts, LOW_MEMORY_HEALTH_GRACE_MS, memoryExhausted, memoryGuardFromRaw, oomBackoffMs, oomExitReason,
  OOM_BACKOFF_BASE_MS, OOM_BACKOFF_MAX_MS,
} from "../../../src/services/supervisor-memory-guard.ts";
import { edgeHoldsPort, leftoverPidsToKill } from "../../../src/services/supervisor-watchdog/leftover-recovery.ts";
import { previousSupervisorDied } from "../../../src/services/restart-news/previous-run-death.ts";
import {
  DEFAULT_IDLE_CLI_RELEASE_MINUTES, DEFAULT_MEMORY_BLOCK_FREE_GB, DEFAULT_MEMORY_WARN_FREE_GB, belowFreeGB, memoryGuardSettings,
} from "../../../src/shared/memory-guard.ts";

describe("memory guard settings", () => {
  it("defaults to 15 GB warn, 10 GB block, 60 min idle release, and ignores invalid values", () => {
    expect(memoryGuardSettings(undefined)).toEqual({
      warnFreeGB: DEFAULT_MEMORY_WARN_FREE_GB, blockFreeGB: DEFAULT_MEMORY_BLOCK_FREE_GB, idleCliReleaseMinutes: DEFAULT_IDLE_CLI_RELEASE_MINUTES,
    });
    expect(memoryGuardSettings({ memory_warn_free_gb: 20, memory_block_free_gb: 0, idle_cli_release_minutes: 0 }))
      .toEqual({ warnFreeGB: 20, blockFreeGB: 0, idleCliReleaseMinutes: 0 });
    expect(memoryGuardSettings({ memory_warn_free_gb: -1, memory_block_free_gb: 2.3, idle_cli_release_minutes: 1.5 }))
      .toEqual({ warnFreeGB: 15, blockFreeGB: 10, idleCliReleaseMinutes: 60 });
    expect(memoryGuardFromRaw(JSON.stringify({ memory_block_free_gb: 8.5 })).blockFreeGB).toBe(8.5);
    expect(memoryGuardFromRaw("not json").blockFreeGB).toBe(10);
  });

  it("treats a threshold of 0 as off", () => {
    expect(belowFreeGB(100, 0)).toBe(false);
    expect(belowFreeGB(10 * 1024 - 1, 10)).toBe(true);
    expect(belowFreeGB(10 * 1024, 10)).toBe(false);
    expect(memoryExhausted(null, 10)).toBe(false);
    expect(memoryExhausted({ freeMB: 4500, limitMB: 53000 }, 10)).toBe(true);
  });
});

describe("out-of-memory restarts", () => {
  it("back off on their own scale, capped", () => {
    expect(oomBackoffMs(1)).toBe(OOM_BACKOFF_BASE_MS);
    expect(oomBackoffMs(2)).toBe(OOM_BACKOFF_BASE_MS * 2);
    expect(oomBackoffMs(20)).toBe(OOM_BACKOFF_MAX_MS);
  });

  it("give the restart reason with the measurements", () => {
    const r = oomExitReason({ exitCode: 3, signal: "none", upForS: 120 }, { freeMB: 900, limitMB: 61_000 }, {
      pid: 1,
      samples: [
        { t: 0, commit: null, branches: [{ pid: 9, name: "claude", session: "abc", treeMB: 1000 }] },
        { t: 15_000, commit: null, branches: [{ pid: 9, name: "claude", session: "abc", treeMB: 4000 }] },
      ],
    });
    expect(r).toEqual({
      kind: "oom",
      detail: "the server exited (exit 3, signal none, after 120s) with 0.9 of 59.6 GB of commit free; chat session abc grew from 1000 MB to 4000 MB in 15 s before it",
    });
  });

  it("forgive health misses while memory is exhausted, for a while", () => {
    expect(healthMissCounts(false, 123, 1000)).toEqual({ counts: true, lowSince: null });
    expect(healthMissCounts(true, null, 1000)).toEqual({ counts: false, lowSince: 1000 });
    expect(healthMissCounts(true, 1000, 1000 + LOW_MEMORY_HEALTH_GRACE_MS - 1).counts).toBe(false);
    expect(healthMissCounts(true, 1000, 1000 + LOW_MEMORY_HEALTH_GRACE_MS).counts).toBe(true);
  });
});

describe("recovery after a dead supervisor", () => {
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

  it("kills only the previous supervisor and server, never the edge or the tunnel", () => {
    const prev = { supervisorPid: 10, pid: 20, tunnelPid: 30, edgePid: 40 };
    expect(leftoverPidsToKill(prev, alive([10, 20, 30, 40]))).toEqual([10, 20]);
    expect(leftoverPidsToKill(prev, alive([30, 40]))).toEqual([]);
    expect(leftoverPidsToKill({}, alive([1]))).toEqual([]);
  });

  it("leaves the port to the previous edge only when that edge is alive and is the listener", () => {
    const prev = { edgePid: 40 };
    expect(edgeHoldsPort(prev, alive([40]), 40)).toBe(true);
    expect(edgeHoldsPort(prev, alive([40]), 41)).toBe(false);
    expect(edgeHoldsPort(prev, alive([40]), 0)).toBe(false);
    expect(edgeHoldsPort(prev, alive([]), 40)).toBe(false);
    expect(edgeHoldsPort({}, alive([40]), 40)).toBe(false);
  });

  it("calls a supervisor dead only when its run was live", () => {
    const deadPid = 2 ** 30;
    expect(previousSupervisorDied({ supervisorPid: deadPid, state: "running" })).toBe(true);
    expect(previousSupervisorDied({ supervisorPid: deadPid, state: "stopped" })).toBe(false);
    expect(previousSupervisorDied({ supervisorPid: process.ppid || deadPid, state: "running" })).toBe(!process.ppid);
    expect(previousSupervisorDied({})).toBe(false);
  });
});
