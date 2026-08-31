import { describe, expect, test } from "bun:test";
import {
  assessTurnCost,
  buildTurnUsage,
  fmtTokens,
  prefixCostMultiplier,
  prefixTokens,
  uncachedPrefixTokens,
  type ModelUsageLike,
} from "../../../src/shared/turn-usage.ts";

/** A warm turn: nearly the whole replayed prefix came back from cache. */
const warm: Record<string, ModelUsageLike> = {
  "claude-opus-5": {
    inputTokens: 500,
    outputTokens: 2_000,
    cacheReadInputTokens: 299_500,
    cacheCreationInputTokens: 0,
    contextWindow: 1_000_000,
    costUSD: 0.2,
  },
};

/** The same conversation resumed onto a fresh subprocess — prefix paid for again. */
const cold: Record<string, ModelUsageLike> = {
  "claude-opus-5": {
    inputTokens: 500,
    outputTokens: 2_000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 299_500,
    contextWindow: 1_000_000,
    costUSD: 2.4,
  },
};

describe("buildTurnUsage", () => {
  test("returns undefined when the SDK reported no usage", () => {
    expect(buildTurnUsage(undefined)).toBeUndefined();
    expect(buildTurnUsage({})).toBeUndefined();
  });

  test("derives the cache hit rate from the replayed prefix, excluding output", () => {
    const u = buildTurnUsage(warm)!;
    expect(prefixTokens(u)).toBe(300_000);
    expect(u.cacheHitRate).toBeCloseTo(299_500 / 300_000, 5);
    expect(uncachedPrefixTokens(u)).toBe(500);
  });

  test("sums every model but labels the turn with the one holding the largest prefix", () => {
    const u = buildTurnUsage({
      "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, contextWindow: 200_000 },
      "claude-opus-5": { inputTokens: 500, outputTokens: 2_000, cacheReadInputTokens: 299_500, contextWindow: 1_000_000 },
    })!;
    expect(u.model).toBe("claude-opus-5");
    expect(u.contextWindow).toBe(1_000_000);
    expect(u.inputTokens).toBe(510);
    expect(u.outputTokens).toBe(2_005);
    expect(u.cacheReadTokens).toBe(299_600);
  });

  test("a cold reason marks the turn and is carried through", () => {
    const u = buildTurnUsage(cold, { coldReason: "tab_closed" })!;
    expect(u.coldStart).toBe(true);
    expect(u.coldReason).toBe("tab_closed");
  });

  test("absence of a cold reason means the turn stayed on a warm subprocess", () => {
    const u = buildTurnUsage(warm)!;
    expect(u.coldStart).toBe(false);
    expect(u.coldReason).toBeUndefined();
  });
});

describe("assessTurnCost", () => {
  test("stays silent on a warm prefix", () => {
    expect(assessTurnCost(buildTurnUsage(warm)!).level).toBe("ok");
  });

  test("flags a large prefix that was re-sent uncached", () => {
    const verdict = assessTurnCost(buildTurnUsage(cold, { coldReason: "tab_closed" })!);
    expect(verdict.level).toBe("bad");
    expect(verdict.wastedTokens).toBe(300_000);
    expect(verdict.reason).toContain("tab");
  });

  test("stays silent on a small prefix however it is billed", () => {
    // A new session legitimately starts cold; warning about it would be pure noise.
    const u = buildTurnUsage({
      m: { inputTokens: 200, outputTokens: 50, cacheCreationInputTokens: 1_000, contextWindow: 200_000 },
    }, { coldReason: "resume" })!;
    expect(assessTurnCost(u).level).toBe("ok");
  });

  test("explains an uncached prefix when the teardown reason is unknown", () => {
    // A resume with no recorded cause still replayed the transcript, so it is still flagged.
    const verdict = assessTurnCost(buildTurnUsage(cold, { coldReason: "resume" })!);
    expect(verdict.level).toBe("bad");
    expect(verdict.reason).not.toBe("");
  });

  test("stays silent on a new session's opening turn", () => {
    // The system prompt and instruction files make a large prefix with nothing to read back,
    // which is unavoidable rather than wasteful — warning about it would be pure noise.
    const firstTurn = buildTurnUsage({
      "claude-opus-5": {
        inputTokens: 1_200,
        outputTokens: 900,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 42_000,
        contextWindow: 1_000_000,
        costUSD: 0.4,
      },
    })!;
    expect(firstTurn.coldStart).toBe(false);
    expect(assessTurnCost(firstTurn).level).toBe("ok");
  });
});

describe("prefixCostMultiplier", () => {
  test("a fully cached prefix is the floor", () => {
    const u = buildTurnUsage({
      m: { inputTokens: 0, outputTokens: 10, cacheReadInputTokens: 300_000, contextWindow: 1_000_000 },
    })!;
    expect(prefixCostMultiplier(u)).toBeCloseTo(1, 5);
  });

  test("a fully re-written prefix costs over an order of magnitude more", () => {
    const u = buildTurnUsage(cold)!;
    expect(prefixCostMultiplier(u)).toBeGreaterThan(10);
  });

  test("never drops below the floor and tolerates an empty prefix", () => {
    const u = buildTurnUsage({ m: { inputTokens: 0, outputTokens: 5 } })!;
    expect(prefixCostMultiplier(u)).toBe(1);
  });
});

describe("fmtTokens", () => {
  test("keeps small counts exact and abbreviates large ones", () => {
    expect(fmtTokens(500)).toBe("500");
    expect(fmtTokens(1_500)).toBe("1.5k");
    expect(fmtTokens(320_000)).toBe("320k");
    expect(fmtTokens(2_400_000)).toBe("2.4M");
  });
});
