import { describe, test, expect } from "bun:test";
import {
  nextNamedRetryDelayMs, NAMED_RETRY_DELAYS_MS,
} from "../../../../src/services/named-tunnel/named-tunnel-retry.ts";

describe("nextNamedRetryDelayMs", () => {
  test("walks the ladder, then stops instead of retrying forever", () => {
    const walked = [0, 1, 2, 3, 4].map(nextNamedRetryDelayMs);
    expect(walked).toEqual([60_000, 300_000, 900_000, null, null]);
  });

  test("every delay grows — a failing setup must back off, not hammer", () => {
    for (let i = 1; i < NAMED_RETRY_DELAYS_MS.length; i++) {
      expect(NAMED_RETRY_DELAYS_MS[i]!).toBeGreaterThan(NAMED_RETRY_DELAYS_MS[i - 1]!);
    }
  });

  test("the first retry is soon enough to cover a resume-from-sleep blip", () => {
    expect(nextNamedRetryDelayMs(0)!).toBeLessThanOrEqual(60_000);
  });

  test("rejects nonsense input rather than scheduling something arbitrary", () => {
    expect(nextNamedRetryDelayMs(-1)).toBeNull();
    expect(nextNamedRetryDelayMs(1.5)).toBeNull();
  });
});
