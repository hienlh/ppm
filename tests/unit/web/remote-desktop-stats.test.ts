// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/remote-desktop-stats.test.ts
import { describe, it, expect } from "bun:test";
import { computeRemoteDesktopStats } from "../../../src/web/components/remote-desktop/remote-desktop-stats.ts";

describe("computeRemoteDesktopStats", () => {
  it("derives fps and KB/s from the delta between two samples over the elapsed time", () => {
    const prev = { frameCount: 100, totalBytes: 500_000, atMs: 1_000 };
    const next = { frameCount: 130, totalBytes: 1_012_000, atMs: 2_000 }; // +30 frames, +512000 bytes, 1s
    const { fps, kbps } = computeRemoteDesktopStats(prev, next);
    expect(fps).toBeCloseTo(30, 5);
    expect(kbps).toBeCloseTo(500, 5); // 512000 bytes / 1024 = 500 KB over 1s
  });

  it("scales correctly over a non-1-second window (e.g. the ~500ms poll interval)", () => {
    const prev = { frameCount: 0, totalBytes: 0, atMs: 0 };
    const next = { frameCount: 15, totalBytes: 256_000, atMs: 500 }; // half a second
    const { fps, kbps } = computeRemoteDesktopStats(prev, next);
    expect(fps).toBeCloseTo(30, 5); // 15 frames / 0.5s
    expect(kbps).toBeCloseTo(500, 5); // 250KB / 0.5s
  });

  it("returns zeros for a non-positive elapsed time instead of dividing by zero", () => {
    const sample = { frameCount: 10, totalBytes: 1000, atMs: 1_000 };
    expect(computeRemoteDesktopStats(sample, sample)).toEqual({ fps: 0, kbps: 0 });
    expect(computeRemoteDesktopStats(sample, { ...sample, atMs: 900 })).toEqual({ fps: 0, kbps: 0 });
  });

  it("clamps a negative frame/byte delta to zero instead of a huge negative rate (reconnect resets counters)", () => {
    // A sample straddling a reconnect: prev is from the old (large) counters, next is from a
    // freshly-reset (small) counter after a new connection started.
    const prev = { frameCount: 900, totalBytes: 9_000_000, atMs: 1_000 };
    const next = { frameCount: 2, totalBytes: 4_000, atMs: 1_500 };
    const { fps, kbps } = computeRemoteDesktopStats(prev, next);
    expect(fps).toBe(0);
    expect(kbps).toBe(0);
  });

  it("is zero when nothing changed (e.g. connection idle/stalled)", () => {
    const prev = { frameCount: 50, totalBytes: 100_000, atMs: 1_000 };
    const next = { frameCount: 50, totalBytes: 100_000, atMs: 1_500 };
    expect(computeRemoteDesktopStats(prev, next)).toEqual({ fps: 0, kbps: 0 });
  });
});
