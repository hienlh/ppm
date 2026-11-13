import { describe, expect, it } from "bun:test";
import { autoModelLabel, modelDisplayName } from "../../../src/web/lib/model-display-name";

describe("modelDisplayName", () => {
  it("names a Claude id the model list did not label", () => {
    expect(modelDisplayName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelDisplayName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("names Antigravity model ids by their shape, so a new model needs no entry", () => {
    expect(modelDisplayName("gemini-4-carbon-high")).toBe("Gemini 4 Carbon");
    expect(modelDisplayName("gemini-4-argon")).toBe("Gemini 4 Argon");
    expect(modelDisplayName("gemini-3.8-flash-medium")).toBe("Gemini 3.8 Flash");
    expect(modelDisplayName("claude-opus-5-5-high")).toBe("Opus 5.5");
  });

  it("names the model Auto runs on when the list marks one", () => {
    expect(autoModelLabel([{ value: "a", label: "A" }, { value: "b", label: "GPT-6.1-Sol", isDefault: true }])).toBe("Auto (GPT-6.1-Sol)");
    expect(autoModelLabel([{ value: "a", label: "A" }])).toBe("Auto (default)");
  });

  it("leaves anything else as given", () => {
    for (const id of ["gpt-5.2-codex", "claude-opus-5-5[1m]", "o4-mini", "claude"]) expect(modelDisplayName(id)).toBe(id);
  });
});
