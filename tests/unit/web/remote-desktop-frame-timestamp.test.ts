// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/remote-desktop-frame-timestamp.test.ts
import { describe, it, expect } from "bun:test";
import { frameTimestampMicros } from "../../../src/web/components/remote-desktop/remote-desktop-frame-timestamp.ts";

describe("frameTimestampMicros", () => {
  it("is strictly increasing for consecutive frame indices", () => {
    let prev = -Infinity;
    for (let i = 0; i < 200; i++) {
      const ts = frameTimestampMicros(i);
      expect(ts).toBeGreaterThan(prev);
      prev = ts;
    }
  });

  it("produces roughly one frame interval (1_000_000/30 us) apart at 30fps (within 1us rounding)", () => {
    const a = frameTimestampMicros(10);
    const b = frameTimestampMicros(11);
    expect(Math.abs(b - a - 1_000_000 / 30)).toBeLessThan(1);
  });

  it("starts at 0 for frame index 0", () => {
    expect(frameTimestampMicros(0)).toBe(0);
  });

  it("respects a custom fps", () => {
    const a = frameTimestampMicros(5, 60);
    const b = frameTimestampMicros(6, 60);
    expect(Math.abs(b - a - 1_000_000 / 60)).toBeLessThan(1);
  });

  it("never repeats a value for two different indices regardless of real-clock jitter", () => {
    // The whole point versus performance.now()*1000: identical wall-clock arrival time for two
    // chunks must still produce two different (increasing) timestamps, since this function
    // never reads the clock at all.
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const ts = frameTimestampMicros(i);
      expect(seen.has(ts)).toBe(false);
      seen.add(ts);
    }
  });
});
