import { describe, expect, it, spyOn } from "bun:test";
import { settleWithinBudget } from "../../../src/services/chat-prepare/settle-within-budget.ts";

describe("settleWithinBudget", () => {
  it("resolves with the value when the promise settles before the budget", async () => {
    const result = await settleWithinBudget(Promise.resolve("ok"), 200, "fallback");
    expect(result).toBe("ok");
  });

  it("resolves with the fallback, not a rejection, when the promise rejects", async () => {
    const result = await settleWithinBudget(Promise.reject(new Error("boom")), 200, "fallback");
    expect(result).toBe("fallback");
  });

  it("resolves with the fallback once the budget elapses", async () => {
    const never = new Promise<string>(() => {});
    const started = Date.now();
    const result = await settleWithinBudget(never, 20, "fallback");
    expect(result).toBe("fallback");
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("clears the pending timer once the promise settles before the timeout", async () => {
    const cleared: unknown[] = [];
    const original = globalThis.clearTimeout;
    (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(id);
      return original(id);
    }) as typeof clearTimeout;
    try {
      await settleWithinBudget(Promise.resolve("value"), 5_000, "fallback");
    } finally {
      globalThis.clearTimeout = original;
    }
    expect(cleared.length).toBe(1);
  });

  it("never produces an unhandled rejection for a promise that settles after the timeout", async () => {
    let rejectLate!: (e: Error) => void;
    const late = new Promise<string>((_, reject) => { rejectLate = reject; });
    const result = await settleWithinBudget(late, 10, "fallback");
    expect(result).toBe("fallback");
    // Rejecting after the wrapper already resolved must not surface anywhere — the wrapper
    // attaches a rejection handler to the original promise up front, regardless of timing.
    rejectLate(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("logs a rejection under the part's label, and stays quiet about a timeout", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await settleWithinBudget(Promise.reject(new Error("boom")), 200, null, "usage");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toBe("[chat-prepare] usage failed: boom");

      warn.mockClear();
      await settleWithinBudget(new Promise<string>(() => {}), 10, null, "tags");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
