import { describe, expect, test } from "bun:test";
import { codexPlanLabel } from "../../src/shared/codex-plan-label.ts";

describe("codexPlanLabel", () => {
  test("replaces Codex internal Business identifiers", () => {
    expect(codexPlanLabel("SELF_SERVE_BUSINESS_PROLITE")).toBe("ChatGPT Business");
  });

  test("formats known public tiers and preserves unknown future values", () => {
    expect(codexPlanLabel("plus")).toBe("ChatGPT Plus");
    expect(codexPlanLabel("new_tier")).toBe("new_tier");
    expect(codexPlanLabel(null)).toBeNull();
  });
});
