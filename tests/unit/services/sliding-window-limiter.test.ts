import { describe, expect, it } from "bun:test";
import { createSlidingWindowLimiter } from "../../../src/services/sliding-window-limiter.ts";

describe("sliding window limiter", () => {
  it("refuses past the window's max and says when the oldest hit ages out", () => {
    const l = createSlidingWindowLimiter({ windowMs: 1000, max: 2 }, { maxKeys: 10 });
    expect(l.take("a", 0)).toBeNull();
    expect(l.take("a", 300)).toBeNull();
    expect(l.take("a", 400)).toEqual({ reason: "window", retryMs: 600 });
    expect(l.take("a", 1000)).toBeNull();
    expect(l.take("b", 400)).toBeNull();
  });

  it("enforces the minimum interval, and check() counts nothing", () => {
    const l = createSlidingWindowLimiter({ windowMs: 60_000, max: 10, minIntervalMs: 500 }, { maxKeys: 10 });
    l.record("a", 0);
    expect(l.check("a", 100)).toEqual({ reason: "interval", retryMs: 400 });
    expect(l.check("a", 500)).toBeNull();
    expect(l.check("a", 500)).toBeNull();
    expect(l.take("a", 500)).toBeNull();
  });

  it("folds hits within the granularity into one entry and still counts each", () => {
    const l = createSlidingWindowLimiter({ windowMs: 60_000, max: 100, granularityMs: 1000 }, { maxKeys: 10 });
    for (let i = 0; i < 100; i++) expect(l.take("a", i)).toBeNull();
    expect(l.take("a", 150)?.reason).toBe("window");
    expect(l.take("a", 60_000)).toBeNull();
  });

  it("drops the least recently used key past maxKeys", () => {
    const l = createSlidingWindowLimiter({ windowMs: 60_000, max: 1 }, { maxKeys: 2 });
    l.record("a", 0);
    l.record("b", 0);
    l.record("a", 1); // touches a, so b is the oldest
    l.record("c", 2);
    expect(l.size).toBe(2);
    expect(l.check("b", 3)).toBeNull();
    expect(l.check("a", 3)?.reason).toBe("window");
  });
});
