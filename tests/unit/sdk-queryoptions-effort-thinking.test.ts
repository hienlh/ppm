import { describe, it, expect } from "bun:test";
import {
  buildModelQueryOptions,
  isThinkingEnabled,
  resolveThinkingConfig,
  THINKING_ADAPTIVE,
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

describe("resolveThinkingConfig — tri-state", () => {
  it("unset defaults to adaptive", () => {
    expect(resolveThinkingConfig(null)).toEqual({ type: "adaptive", display: "summarized" });
    expect(resolveThinkingConfig(undefined)).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("0 disables", () => {
    expect(resolveThinkingConfig(0)).toEqual({ type: "disabled" });
  });

  it("the ON sentinel maps to adaptive, never a fixed budget", () => {
    expect(resolveThinkingConfig(THINKING_ADAPTIVE)).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("a positive budget is an explicit fixed budget", () => {
    expect(resolveThinkingConfig(5000)).toEqual({ type: "enabled", budgetTokens: 5000, display: "summarized" });
  });

  it("REGRESSION: every non-disabled config asks for summarized content", () => {
    // Without an explicit display the CLI streams thinking_delta frames whose `thinking`
    // is "" (only estimated_tokens), so the UI has nothing to render and the blocks vanish.
    for (const budget of [null, undefined, THINKING_ADAPTIVE, 5000]) {
      expect(resolveThinkingConfig(budget)).toHaveProperty("display", "summarized");
    }
  });
});

describe("isThinkingEnabled — UI toggle state", () => {
  it("REGRESSION: nothing set anywhere reads ON, not OFF", () => {
    // Reporting OFF here is what made the client echo `thinking:false` back, which
    // persisted an explicit 0 and killed thinking on sessions that never opted out.
    expect(isThinkingEnabled(null, undefined)).toBe(true);
  });

  it("session override wins over config", () => {
    expect(isThinkingEnabled(0, 5000)).toBe(false);
    expect(isThinkingEnabled(THINKING_ADAPTIVE, 0)).toBe(true);
  });

  it("falls back to config when session unset", () => {
    expect(isThinkingEnabled(null, 0)).toBe(false);
    expect(isThinkingEnabled(null, 5000)).toBe(true);
  });
});

describe("buildModelQueryOptions — thinking", () => {
  it("per-call budget overrides config", () => {
    const out = buildModelQueryOptions({ thinkingBudget: THINKING_ADAPTIVE }, { thinking_budget_tokens: 5000 });
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("falls back to config budget", () => {
    const out = buildModelQueryOptions({}, { thinking_budget_tokens: 5000 });
    expect(out.thinking).toEqual({ type: "enabled", budgetTokens: 5000, display: "summarized" });
  });

  it("REGRESSION: nothing set means adaptive, never an explicit disable", () => {
    const out = buildModelQueryOptions({}, {});
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("keeps 0 from config (explicitly disabled)", () => {
    const out = buildModelQueryOptions({}, { thinking_budget_tokens: 0 });
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("per-call 0 overrides a config budget (explicit OFF beats inherit)", () => {
    const out = buildModelQueryOptions({ thinkingBudget: 0 }, { thinking_budget_tokens: 5000 });
    expect(out.thinking).toEqual({ type: "disabled" });
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
