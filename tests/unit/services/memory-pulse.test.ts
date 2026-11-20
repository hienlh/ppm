import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeGrowth, fastestGrowth, MAX_SAMPLES, prunePulses, readPulse, writePulse, type PulseSample } from "../../../src/services/memory-pulse.ts";
import { parseLinuxMeminfo, describeCommit } from "../../../src/services/system-commit.ts";
import { pulseSample } from "../../../src/services/memory-watchdog.ts";

const sample = (t: number, branches: PulseSample["branches"], freeMB = 20_000): PulseSample => ({
  t, commit: { freeMB, limitMB: 60_000 }, branches,
});

describe("fastestGrowth", () => {
  it("names the tree that grew most, not the biggest (the 20/11 incident's numbers)", () => {
    const g = fastestGrowth([
      sample(0, [
        { pid: 55832, name: "claude", session: "old-chat", treeMB: 1370 },
        { pid: 45716, name: "claude", session: "20decca7", treeMB: 1256 },
      ]),
      sample(30_000, [
        { pid: 45716, name: "claude", session: "20decca7", treeMB: 3714 },
        { pid: 55832, name: "claude", session: "old-chat", treeMB: 1370 },
      ]),
    ]);
    expect(g).toMatchObject({ session: "20decca7", fromMB: 1256, toMB: 3714, seconds: 30 });
    expect(describeGrowth(g!)).toBe("chat session 20decca7 grew from 1256 MB to 3714 MB in 30 s");
  });

  it("counts a tree that appeared only in the newest sample from zero", () => {
    const g = fastestGrowth([
      sample(0, [{ pid: 1, name: "claude", session: "a", treeMB: 900 }]),
      sample(60_000, [{ pid: 1, name: "claude", session: "a", treeMB: 950 }, { pid: 2, name: "node", label: "node jest", treeMB: 800 }]),
    ]);
    expect(g).toMatchObject({ pid: 2, fromMB: 0, toMB: 800 });
    expect(describeGrowth(g!)).toBe("node jest (pid 2) grew from 0 MB to 800 MB in 60 s");
  });

  it("falls back to the biggest tree when nothing grew, and to null with no branches", () => {
    const g = fastestGrowth([sample(0, [{ pid: 1, name: "claude", treeMB: 500 }, { pid: 2, name: "claude", session: "b", treeMB: 700 }])]);
    expect(g).toMatchObject({ pid: 2, toMB: 700, seconds: 0 });
    expect(describeGrowth(g!)).toBe("chat session b held 700 MB");
    expect(fastestGrowth([sample(0, [])])).toBeNull();
    expect(fastestGrowth([])).toBeNull();
  });
});

describe("pulse file", () => {
  it("keeps the last samples per server pid and prunes only stale files of other pids", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-"));
    try {
      for (let i = 0; i < MAX_SAMPLES + 2; i++) writePulse(dir, 111, sample(i, []));
      const pulse = readPulse(dir, 111)!;
      expect(pulse.samples.map((s) => s.t)).toEqual([2, 3, 4, 5]);
      expect(readPulse(dir, 222)).toBeNull();

      writePulse(dir, 222, sample(0, []));
      writePulse(dir, 333, sample(0, []));
      const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
      utimesSync(join(dir, "memory-pulse", "222.json"), old, old);
      utimesSync(join(dir, "memory-pulse", "111.json"), old, old);
      prunePulses(dir, new Set([111]));
      expect(existsSync(join(dir, "memory-pulse", "111.json"))).toBe(true);
      expect(existsSync(join(dir, "memory-pulse", "222.json"))).toBe(false);
      expect(existsSync(join(dir, "memory-pulse", "333.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pulseSample", () => {
  it("keeps what a diagnosis needs from the watchdog's tree", () => {
    const s = pulseSample(5, { freeMB: 100, limitMB: 200 }, {
      count: 3, privateMB: 3000, byName: {}, mcpServers: 18,
      branches: [{ pid: 7, name: "claude", session: "s", label: "claude", ownMB: 700, treeMB: 2500, ageMin: 3 }],
    });
    expect(s).toEqual({
      t: 5, commit: { freeMB: 100, limitMB: 200 }, childrenMB: 3000, mcpServers: 18,
      branches: [{ pid: 7, name: "claude", session: "s", label: "claude", treeMB: 2500 }],
    });
    expect(pulseSample(5, null, undefined)).toEqual({ t: 5, commit: null, branches: [] });
  });
});

describe("system commit", () => {
  it("reads available memory plus free swap on Linux", () => {
    const text = "MemTotal:       32768000 kB\nMemFree: 1000 kB\nMemAvailable:   10240000 kB\nSwapTotal:      8192000 kB\nSwapFree:       2048000 kB\n";
    expect(parseLinuxMeminfo(text)).toEqual({ freeMB: 12000, limitMB: 40000 });
    expect(parseLinuxMeminfo("MemTotal: 1 kB\n")).toBeNull();
  });

  it("describes free commit in GB", () => {
    expect(describeCommit({ freeMB: 4505, limitMB: 53146 })).toBe("4.4 of 51.9 GB free");
  });
});
