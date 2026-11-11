import { describe, expect, it } from "bun:test";
import { branchTakesMain } from "../../../src/web/lib/assistant-branch-main.ts";

describe("which branch becomes the main Assistant session", () => {
  it("is the one the user moves to from the main session", () => {
    expect(branchTakesMain("main", "edited", "main")).toBe(true);
  });

  it("is never one reached from a one-off session", () => {
    expect(branchTakesMain("old", "edited", "main")).toBe(false);
  });

  it("changes nothing when the move lands on the main session or there is none", () => {
    expect(branchTakesMain("edited", "main", "main")).toBe(false);
    expect(branchTakesMain("main", "main", "main")).toBe(false);
    expect(branchTakesMain("a", "b", null)).toBe(false);
    expect(branchTakesMain(null, "b", "main")).toBe(false);
  });
});
