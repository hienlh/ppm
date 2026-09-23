import { describe, expect, it } from "bun:test";
import {
  buildSystemPromptOption,
  preToolUseDecision,
} from "../../../src/providers/claude-agent-sdk-query-options.ts";

describe("buildSystemPromptOption", () => {
  it("sends the bare preset when there is nothing to add", () => {
    expect(buildSystemPromptOption()).toEqual({ type: "preset", preset: "claude_code" });
    expect(buildSystemPromptOption("", "   ")).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("appends the provider's additional instructions instead of replacing the prompt", () => {
    const option = buildSystemPromptOption("Answer in French.");
    expect(option).toEqual({ type: "preset", preset: "claude_code", append: "Answer in French." });
    // The old shape was `{type:"custom", value}`, which the SDK does not recognise at all.
    expect(option).not.toHaveProperty("value");
    expect(option.type).toBe("preset");
  });

  it("appends the design block alone", () => {
    expect(buildSystemPromptOption(undefined, "# Design mode")).toEqual({
      type: "preset", preset: "claude_code", append: "# Design mode",
    });
  });

  it("puts the additional instructions first and the design block after", () => {
    expect(buildSystemPromptOption("  Be terse.  ", "# Design mode\n")).toEqual({
      type: "preset", preset: "claude_code", append: "Be terse.\n\n# Design mode",
    });
  });
});

describe("preToolUseDecision", () => {
  it("names the event, or the CLI ignores the verdict", () => {
    expect(preToolUseDecision("allow")).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  });

  it("carries a deny reason in the field the CLI reports back", () => {
    expect(preToolUseDecision("deny", "User denied tool execution")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "User denied tool execution",
      },
    });
  });
});
