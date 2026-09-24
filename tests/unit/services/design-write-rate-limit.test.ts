import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  WRITES_PER_MINUTE, designWriteClock, resetDesignWriteLimits, takeDesignWrite,
} from "../../../src/services/design/design-write-rate-limit.ts";

function statusOf(project: string, slug: string): number {
  try {
    takeDesignWrite(project, slug);
    return 200;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

describe("design write rate limit", () => {
  let now = 1_000_000;
  const realNow = designWriteClock.now;
  beforeEach(() => {
    resetDesignWriteLimits();
    now = 1_000_000;
    designWriteClock.now = () => now;
  });
  afterEach(() => { designWriteClock.now = realNow; });

  it("allows one write per 500 ms", () => {
    takeDesignWrite("/p", "home");
    expect(statusOf("/p", "home")).toBe(429);
    now += 499;
    expect(statusOf("/p", "home")).toBe(429);
    now += 1;
    expect(statusOf("/p", "home")).toBe(200);
  });

  it("caps a sustained stream at 30 a minute, then recovers", () => {
    for (let i = 0; i < WRITES_PER_MINUTE; i++) {
      takeDesignWrite("/p", "home");
      now += 600;
    }
    expect(statusOf("/p", "home")).toBe(429);
    // A refused write is not counted, so the window drains as the first writes age out.
    now += 60_000 - WRITES_PER_MINUTE * 600 + 1;
    expect(statusOf("/p", "home")).toBe(200);
  });

  it("counts each design on its own", () => {
    takeDesignWrite("/p", "home");
    expect(statusOf("/p", "about")).toBe(200);
    expect(statusOf("/other", "home")).toBe(200);
  });
});
