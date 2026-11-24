import { describe, expect, test } from "bun:test";
import { INTENT_WINDOW_MS, MIN_DROP_PX, isUnexplainedDrop, rowKind, shortStack } from "../../../src/web/lib/scroll-jump-log";

describe("scroll-jump log (temporary diagnostic)", () => {
  test("records only an upward move bigger than the threshold", () => {
    expect(isUnexplainedDrop(1000, 1000 - MIN_DROP_PX - 1, 10_000, -Infinity)).toBe(true);
    expect(isUnexplainedDrop(1000, 1000 - MIN_DROP_PX, 10_000, -Infinity)).toBe(false);
    expect(isUnexplainedDrop(1000, 1400, 10_000, -Infinity)).toBe(false);
  });

  test("a move just after the reader's own wheel, touch or key is theirs", () => {
    expect(isUnexplainedDrop(1000, 500, 10_000, 10_000 - INTENT_WINDOW_MS + 1)).toBe(false);
    expect(isUnexplainedDrop(1000, 500, 10_000, 10_000 - INTENT_WINDOW_MS - 1)).toBe(true);
  });

  test("a row id leaves the page only as the kind of row it is", () => {
    expect(rowKind("streaming-1795490909466")).toBe("streaming");
    expect(rowKind("final-1795490909466-3")).toBe("final");
    expect(rowKind("user-1795490909466-2-abc")).toBe("user");
    expect(rowKind("a9fa7e27-0795-4eb5-aefe-76224860da3b")).toBe("uuid");
    expect(rowKind("deadbeef-0795-4eb5-aefe-76224860da3b")).toBe("uuid");
    expect(rowKind("rollout-12")).toBe("rollout");
    expect(rowKind(undefined)).toBeNull();
  });

  test("a stack is a few frames with no origin or query string", () => {
    const raw = [
      "Error",
      "    at noteWrite (http://127.0.0.1:5173/lib/scroll-jump-log.ts?t=1:10:5)",
      "    at HTMLDivElement.set (http://127.0.0.1:5173/lib/scroll-jump-log.ts?t=1:162:5)",
      "    at scrollToBottom (https://ppm.example.com/assets/index-abc.js:1:200)",
    ].join("\n");
    expect(shortStack(raw)).toEqual(["at scrollToBottom (/assets/index-abc.js:1:200)"]);
  });
});
