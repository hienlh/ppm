/**
 * Two fixes that share a cause: codex renames a session to its own thread id
 * mid-connect, and the turn's token counts arrive on a notification of their own.
 *
 * The alias half matters beyond tidiness — losing the caller's id meant a
 * follow-up spawned a second app-server and the first was never killed, so each
 * request leaked a ~90 MB process.
 */
import { describe, it, expect } from "bun:test";
import { parseTokenUsage } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";

/** Verbatim shape of a `thread/tokenUsage/updated` notification. */
const PARAMS = {
  threadId: "01a09471-e746-7583-8695-b7af4f466a54",
  turnId: "01a09471-e784-7010-8450-4c57556a9e59",
  tokenUsage: {
    total: {
      totalTokens: 40000, inputTokens: 39000, cachedInputTokens: 30000,
      cacheWriteInputTokens: 1000, outputTokens: 1000, reasoningOutputTokens: 0,
    },
    last: {
      totalTokens: 15454, inputTokens: 15449, cachedInputTokens: 12288,
      cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0,
    },
    modelContextWindow: 258400,
  },
};

describe("codex token usage", () => {
  it("reports the fresh input share, not the whole prefix", () => {
    const u = parseTokenUsage(PARAMS, "gpt-5.6-sol")!;
    // Codex folds the cached tokens into inputTokens; TurnUsage.inputTokens is
    // the uncached part, so 15449 - 12288 is what actually cost full rate.
    expect(u.inputTokens).toBe(3161);
    expect(u.cacheReadTokens).toBe(12288);
    expect(u.cacheWriteTokens).toBe(0);
    expect(u.outputTokens).toBe(5);
    expect(u.contextWindow).toBe(258400);
    expect(u.model).toBe("gpt-5.6-sol");
    expect(u.cacheHitRate).toBeCloseTo(12288 / 15449, 5);
  });

  it("reads this turn, not the thread total", () => {
    // Using `total` would inflate every turn after the first.
    const u = parseTokenUsage(PARAMS)!;
    expect(u.outputTokens).toBe(5);
    expect(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens).toBe(15449);
  });

  it("reports no cost, because a subscription has no per-token price", () => {
    expect(parseTokenUsage(PARAMS)!.costUsd).toBe(0);
  });

  it("subtracts the cache-write share too", () => {
    const params = {
      tokenUsage: {
        last: { inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 300, outputTokens: 7 },
      },
    };
    const u = parseTokenUsage(params)!;
    expect(u.inputTokens).toBe(100);
    expect(u.cacheWriteTokens).toBe(300);
  });

  it("never returns a negative fresh count when the parts do not add up", () => {
    const params = {
      tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 1 } },
    };
    expect(parseTokenUsage(params)!.inputTokens).toBe(0);
  });

  it("returns null rather than a zeroed shape when there is nothing to read", () => {
    expect(parseTokenUsage(undefined)).toBeNull();
    expect(parseTokenUsage({})).toBeNull();
    expect(parseTokenUsage({ tokenUsage: {} })).toBeNull();
    expect(parseTokenUsage({ tokenUsage: { last: {} } })).toBeNull();
  });

  it("treats missing numeric fields as zero instead of NaN", () => {
    const u = parseTokenUsage({ tokenUsage: { last: { inputTokens: 50 } } })!;
    expect(u.outputTokens).toBe(0);
    expect(u.cacheReadTokens).toBe(0);
    expect(u.contextWindow).toBe(0);
    expect(u.inputTokens).toBe(50);
  });
});
