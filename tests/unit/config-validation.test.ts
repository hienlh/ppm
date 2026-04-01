import { describe, it, expect } from "bun:test";
import { validateAIProviderConfig } from "../../src/types/config.ts";

describe("validateAIProviderConfig", () => {
  it("returns empty array for valid config", () => {
    const errors = validateAIProviderConfig({
      model: "claude-sonnet-4-6",
      effort: "high",
      max_turns: 100,
      max_budget_usd: 2.0,
      thinking_budget_tokens: 10000,
    });
    expect(errors).toHaveLength(0);
  });

  it("allows empty config (all optional)", () => {
    expect(validateAIProviderConfig({})).toHaveLength(0);
  });

  it("rejects max_turns below 1", () => {
    expect(validateAIProviderConfig({ max_turns: 0 })).toHaveLength(1);
  });

  it("rejects max_turns above 500", () => {
    expect(validateAIProviderConfig({ max_turns: 501 })).toHaveLength(1);
  });

  it("accepts max_turns at boundaries", () => {
    expect(validateAIProviderConfig({ max_turns: 1 })).toHaveLength(0);
    expect(validateAIProviderConfig({ max_turns: 500 })).toHaveLength(0);
  });

  it("rejects invalid effort value", () => {
    expect(validateAIProviderConfig({ effort: "turbo" as any })).toHaveLength(1);
  });

  it("accepts all valid effort values", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      expect(validateAIProviderConfig({ effort })).toHaveLength(0);
    }
  });

  it("rejects negative budget", () => {
    expect(validateAIProviderConfig({ max_budget_usd: -1 })).toHaveLength(1);
  });

  it("rejects budget above 50", () => {
    expect(validateAIProviderConfig({ max_budget_usd: 51 })).toHaveLength(1);
  });

  it("rejects negative thinking tokens", () => {
    expect(validateAIProviderConfig({ thinking_budget_tokens: -1 })).toHaveLength(1);
  });

  it("allows zero thinking tokens (means disabled)", () => {
    expect(validateAIProviderConfig({ thinking_budget_tokens: 0 })).toHaveLength(0);
  });

  it("returns multiple errors for multiple invalid fields", () => {
    const errors = validateAIProviderConfig({
      max_turns: 0,
      max_budget_usd: -1,
      effort: "turbo" as any,
    });
    expect(errors).toHaveLength(3);
  });

  it("rejects invalid model", () => {
    expect(validateAIProviderConfig({ model: "gpt-4" as any })).toHaveLength(1);
  });

  it("accepts valid models", () => {
    expect(validateAIProviderConfig({ model: "claude-sonnet-4-6" })).toHaveLength(0);
    expect(validateAIProviderConfig({ model: "claude-opus-4-6" })).toHaveLength(0);
  });

  it("rejects invalid type", () => {
    expect(validateAIProviderConfig({ type: "cli" as any })).toHaveLength(1);
  });

  it("rejects non-integer max_turns", () => {
    expect(validateAIProviderConfig({ max_turns: 1.5 })).toHaveLength(1);
  });

  it("rejects non-integer thinking_budget_tokens", () => {
    expect(validateAIProviderConfig({ thinking_budget_tokens: 1.5 })).toHaveLength(1);
  });

  // CLI provider validation
  it("accepts valid CLI provider config", () => {
    const errors = validateAIProviderConfig({
      type: "cli",
      cli_command: "cursor-agent",
      model: "any-model-string",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects CLI provider without cli_command", () => {
    const errors = validateAIProviderConfig({ type: "cli" });
    expect(errors.some((e) => e.includes("cli_command"))).toBe(true);
  });

  it("rejects CLI provider with invalid cli_command", () => {
    const errors = validateAIProviderConfig({ type: "cli", cli_command: "rm" });
    expect(errors.some((e) => e.includes("cli_command"))).toBe(true);
  });

  it("accepts 'cli' as valid type", () => {
    const errors = validateAIProviderConfig({ type: "cli", cli_command: "cursor-agent" });
    expect(errors.filter((e) => e.includes("type"))).toHaveLength(0);
  });

  it("CLI provider skips model validation (accepts any string)", () => {
    const errors = validateAIProviderConfig({
      type: "cli",
      cli_command: "cursor-agent",
      model: "custom-cursor-model-v2",
    });
    expect(errors.filter((e) => e.includes("model"))).toHaveLength(0);
  });
});
