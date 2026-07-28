import { describe, it, expect } from "bun:test";
import {
  buildModelQueryOptions,
  VALID_EFFORT_VALUES,
} from "../../src/providers/claude-agent-sdk-query-options.ts";

describe("buildModelQueryOptions — effort", () => {
  it("per-call effort overrides config", () => {
    const out = buildModelQueryOptions({ effort: "xhigh" }, { effort: "high" });
    expect(out.effort).toBe("xhigh");
  });

  it("falls back to config effort when no override", () => {
    const out = buildModelQueryOptions({}, { effort: "high" });
    expect(out.effort).toBe("high");
  });

  it("omits effort when neither set", () => {
    const out = buildModelQueryOptions({}, {});
    expect(out.effort).toBeUndefined();
  });

  it("accepts every valid effort value", () => {
    for (const e of VALID_EFFORT_VALUES) {
      expect(buildModelQueryOptions({ effort: e }, {}).effort).toBe(e);
    }
  });

  it("HARD: 'extra' is rejected (throws), never emitted", () => {
    expect(() => buildModelQueryOptions({ effort: "extra" }, {})).toThrow();
  });

  it("HARD: any non-enum effort throws", () => {
    expect(() => buildModelQueryOptions({ effort: "turbo" }, {})).toThrow();
    expect(() => buildModelQueryOptions({}, { effort: "extra" })).toThrow();
  });
});

describe("buildModelQueryOptions — thinking (maxThinkingTokens)", () => {
  it("per-call budget overrides config", () => {
    const out = buildModelQueryOptions({ maxThinkingTokens: 12000 }, { thinking_budget_tokens: 5000 });
    expect(out.maxThinkingTokens).toBe(12000);
  });

  it("falls back to config budget", () => {
    const out = buildModelQueryOptions({}, { thinking_budget_tokens: 5000 });
    expect(out.maxThinkingTokens).toBe(5000);
  });

  it("omits when neither set (thinking OFF)", () => {
    const out = buildModelQueryOptions({}, {});
    expect(out).not.toHaveProperty("maxThinkingTokens");
  });

  it("keeps 0 from config (explicitly disabled)", () => {
    const out = buildModelQueryOptions({}, { thinking_budget_tokens: 0 });
    expect(out.maxThinkingTokens).toBe(0);
  });
});

describe("buildModelQueryOptions — model + 1M", () => {
  it("per-call model overrides config", () => {
    const out = buildModelQueryOptions({ model: "claude-opus-5" }, { model: "claude-sonnet-4-6" });
    expect(out.model).toBe("claude-opus-5");
  });

  it("adds [1m] suffix when 1M enabled", () => {
    const out = buildModelQueryOptions({ model: "claude-opus-5" }, { context_1m: true });
    expect(out.model).toBe("claude-opus-5[1m]");
    expect(out.use1m).toBe(true);
  });

  it("per-call oneMContext=false disables suffix", () => {
    const out = buildModelQueryOptions({ model: "claude-opus-5", oneMContext: false }, { context_1m: true });
    expect(out.model).toBe("claude-opus-5");
  });

  it("does not double-append [1m]", () => {
    const out = buildModelQueryOptions({ model: "claude-opus-5[1m]" }, { context_1m: true });
    expect(out.model).toBe("claude-opus-5[1m]");
  });

  it("omits model when none configured", () => {
    const out = buildModelQueryOptions({}, {});
    expect(out.model).toBeUndefined();
  });
});
