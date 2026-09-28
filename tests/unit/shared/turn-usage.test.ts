import { describe, expect, test } from "bun:test";
import {
  assessTurnCost,
  buildTurnUsage,
  fmtTokens,
  messageContextTokens,
  messageCacheTtl,
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

describe("messageContextTokens", () => {
  // The whole input side of one API call. Cached tokens occupy the context exactly like
  // fresh ones — dropping them reports a warm turn as holding almost nothing.
  test("sums every part of the input side", () => {
    expect(messageContextTokens({
      input_tokens: 4,
      cache_read_input_tokens: 58_000,
      cache_creation_input_tokens: 1_000,
      output_tokens: 900,
    })).toBe(59_004);
  });

  // The next call replays the transcript, not this call's answer — counting output here
  // would inflate every turn by its own reply.
  test("excludes output tokens", () => {
    expect(messageContextTokens({ input_tokens: 100, output_tokens: 9_000 })).toBe(100);
  });

  // The cache pair is nullable on the wire; only `input_tokens` is always sent.
  test("treats a null cache field as zero, not as unmeasurable", () => {
    expect(messageContextTokens({
      input_tokens: 100,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    })).toBe(100);
  });

  // A frame with no usage must not read as a zero-token context, which would display as
  // "re-sends about 0 tokens" on a full session.
  test("reports a missing usage as unmeasured rather than as zero", () => {
    expect(messageContextTokens(undefined)).toBeUndefined();
    expect(messageContextTokens(null)).toBeUndefined();
    expect(messageContextTokens({})).toBeUndefined();
    expect(messageContextTokens({ output_tokens: 10 })).toBeUndefined();
    // An explicit zero on every field is the same non-answer, not a zero-token context.
    expect(messageContextTokens({
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })).toBeUndefined();
  });

  // The API does not promise `input_tokens` on every frame, and a cached prefix is a real
  // context whether or not a fresh-input count came with it.
  test("answers from the cache fields alone when input_tokens is absent", () => {
    expect(messageContextTokens({ cache_read_input_tokens: 58_000 })).toBe(58_000);
  });
});

describe("messageCacheTtl", () => {
  // Measured on real transcripts: 3155 of 3172 assistant messages carry this, so the guess
  // it replaces was being made in the presence of the answer.
  test("reads the window the API actually wrote", () => {
    expect(messageCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 77_200, ephemeral_5m_input_tokens: 0 } })).toBe("1h");
    expect(messageCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 4_100 } })).toBe("5m");
  });

  // A prefix split across both windows still has an hour on the longer half, so reporting
  // five minutes would expire a cache that is still standing.
  test("reports the longer window when a turn wrote into both", () => {
    expect(messageCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 99_999 } })).toBe("1h");
  });

  // Silence, not five minutes: a turn that only read the cache names no window, and
  // defaulting to the short one there is exactly the bug this replaces.
  test("says nothing rather than guessing when no window was written", () => {
    expect(messageCacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } })).toBeUndefined();
    expect(messageCacheTtl({ cache_read_input_tokens: 58_000 })).toBeUndefined();
    expect(messageCacheTtl({ cache_creation: null })).toBeUndefined();
    expect(messageCacheTtl(undefined)).toBeUndefined();
  });
});
