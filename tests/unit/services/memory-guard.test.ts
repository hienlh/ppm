import { describe, expect, it } from "bun:test";
import { selectIdleReleases, MAX_MEMORY_RELEASES_PER_TICK, MIN_QUIET_FOR_MEMORY_MS } from "../../../src/services/memory-guard/idle-subprocess-release.ts";
import { lowMemoryMessage, nextAlertLevel, RECOVER_MARGIN_GB } from "../../../src/services/memory-guard/low-memory-alert.ts";
import { MemoryGuard } from "../../../src/services/memory-guard/memory-guard.service.ts";
import { cliDescendants, stillRunning } from "../../../src/services/cli-leftover-reaper.ts";
import type { PulseSample } from "../../../src/services/memory-pulse.ts";

const MIN = 60_000;
const GB = 1024;

describe("selectIdleReleases", () => {
  const now = 1_000 * MIN;
  it("releases chats quiet longer than the setting, tab open or not", () => {
    const picks = selectIdleReleases(
      [{ sessionId: "old", quietSince: now - 61 * MIN }, { sessionId: "recent", quietSince: now - 5 * MIN }],
      now, { idleMinutes: 60, memoryLow: false },
    );
    expect(picks).toEqual([{ sessionId: "old", why: "idle" }]);
    expect(selectIdleReleases([{ sessionId: "old", quietSince: 0 }], now, { idleMinutes: 0, memoryLow: false })).toEqual([]);
  });

  it("under memory pressure also releases the longest-quiet few, never one that just finished", () => {
    const quiet = [
      { sessionId: "a", quietSince: now - 10 * MIN },
      { sessionId: "b", quietSince: now - 30 * MIN },
      { sessionId: "c", quietSince: now - 20 * MIN },
      { sessionId: "d", quietSince: now - 25 * MIN },
      { sessionId: "fresh", quietSince: now - MIN_QUIET_FOR_MEMORY_MS + 1 },
    ];
    const picks = selectIdleReleases(quiet, now, { idleMinutes: 60, memoryLow: true });
    expect(picks).toEqual([
      { sessionId: "b", why: "memory" }, { sessionId: "d", why: "memory" }, { sessionId: "c", why: "memory" },
    ]);
    expect(picks.length).toBe(MAX_MEMORY_RELEASES_PER_TICK);
  });
});

describe("nextAlertLevel", () => {
  it("notifies once per level reached, and resets only well above the warn line", () => {
    let r = nextAlertLevel(0, 14 * GB, 15, 10);
    expect(r).toEqual({ level: 1, notify: true });
    r = nextAlertLevel(r.level, 13 * GB, 15, 10);
    expect(r).toEqual({ level: 1, notify: false });
    r = nextAlertLevel(r.level, 9 * GB, 15, 10);
    expect(r).toEqual({ level: 2, notify: true });
    r = nextAlertLevel(r.level, 16 * GB, 15, 10);
    expect(r).toEqual({ level: 2, notify: false });
    r = nextAlertLevel(r.level, (15 + RECOVER_MARGIN_GB) * GB, 15, 10);
    expect(r).toEqual({ level: 0, notify: false });
    expect(nextAlertLevel(0, 1, 0, 0)).toEqual({ level: 0, notify: false });
  });
});

describe("lowMemoryMessage", () => {
  it("names what grew fastest, the MCP count and what was released, as measurements", () => {
    const m = lowMemoryMessage({
      freeMB: 4505, limitMB: 53146, level: 2, blockGB: 10,
      growth: { pid: 1, name: "claude", session: "20decca7-91e5", fromMB: 1256, toMB: 3714, seconds: 30 },
      growthChat: { title: "NX-6294", project: "Nxsys" },
      mcpServers: 18, released: 2,
    });
    expect(m.title).toBe("Low memory: 4.4 of 51.9 GB free");
    expect(m.body).toBe(
      'Growing fastest: chat "NX-6294" (Nxsys), +2458 MB in 30 s (now 3714 MB). 18 MCP server processes are running under the chats. '
      + "PPM released 2 quiet chat subprocesses. Under 10 GB: new test runs, type checks and builds from chats are held until memory comes back.",
    );
  });
});

describe("MemoryGuard", () => {
  const sample = (t: number, freeMB: number, treeMB: number): PulseSample => ({
    t, commit: { freeMB, limitMB: 60 * GB }, mcpServers: 4,
    branches: [{ pid: 9, name: "claude", session: "s1", treeMB }],
  });

  it("releases on every reading and notifies when the level rises", () => {
    const releases: Array<{ idleMinutes: number; memoryLow: boolean }> = [];
    const notes: Array<{ title: string; body: string; sessionId: string; project: string }> = [];
    const guard = new MemoryGuard({
      settings: () => ({ warnFreeGB: 15, blockFreeGB: 10, idleCliReleaseMinutes: 60 }),
      release: (o) => { releases.push(o); return []; },
      chatInfo: () => ({ title: "T", project: "P" }),
      notify: (n) => notes.push(n),
    });
    guard.onPulse(sample(0, 30 * GB, 1000));
    guard.onPulse(sample(15_000, 12 * GB, 2000));
    guard.onPulse(sample(30_000, 12 * GB, 2500));
    guard.onPulse(sample(45_000, 8 * GB, 4000));
    expect(releases.map((r) => r.memoryLow)).toEqual([false, false, false, true]);
    expect(notes.length).toBe(2);
    expect(notes[0]).toMatchObject({ sessionId: "s1", project: "P", title: "Low memory: 12.0 of 60.0 GB free" });
    expect(notes[1]!.body).toContain('+3000 MB in 45 s');
  });
});

describe("CLI leftovers", () => {
  const list = [
    { pid: 1, ppid: 0, name: "bun", privateMB: 0, startedAt: 1 },
    { pid: 10, ppid: 1, name: "claude", privateMB: 0, startedAt: 2 },
    { pid: 11, ppid: 10, name: "cmd", privateMB: 0, startedAt: 3 },
    { pid: 12, ppid: 11, name: "node", privateMB: 0, startedAt: 4 },
    { pid: 20, ppid: 1, name: "claude", privateMB: 0, startedAt: 5 },
  ];

  it("takes the MCP servers below the released CLI, and only those", () => {
    expect(cliDescendants(list, [10])).toEqual([{ pid: 11, startedAt: 3 }, { pid: 12, startedAt: 4 }]);
    // What a shell command started (a dev server left running) is left alone, as on Linux.
    const withShell = [...list, { pid: 13, ppid: 10, name: "bash", privateMB: 0, startedAt: 6 }, { pid: 14, ppid: 13, name: "node", privateMB: 0, startedAt: 7 }];
    expect(cliDescendants(withShell, [10])).toEqual([{ pid: 11, startedAt: 3 }, { pid: 12, startedAt: 4 }]);
    // The CLI already gone: its children are still found by the parent pid they keep.
    expect(cliDescendants(list.filter((p) => p.pid !== 10), [10])).toEqual([{ pid: 11, startedAt: 3 }, { pid: 12, startedAt: 4 }]);
  });

  it("ends only processes that are still the same ones (a reused pid has another start time)", () => {
    const later = [{ pid: 11, ppid: 0, name: "cmd", privateMB: 0, startedAt: 3 }, { pid: 12, ppid: 0, name: "x", privateMB: 0, startedAt: 99 }];
    expect(stillRunning([{ pid: 11, startedAt: 3 }, { pid: 12, startedAt: 4 }, { pid: 13, startedAt: 5 }], later)).toEqual([11]);
  });
});
