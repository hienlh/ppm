import { describe, expect, it } from "bun:test";
import { modelDisplayName } from "../../../src/web/lib/model-display-name";

describe("modelDisplayName", () => {
  it("names a Claude id the model list did not label", () => {
    expect(modelDisplayName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelDisplayName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("leaves anything else as given", () => {
    for (const id of ["gpt-5.2-codex", "claude-opus-5-5[1m]", "o4-mini", "claude"]) expect(modelDisplayName(id)).toBe(id);
  });
});
