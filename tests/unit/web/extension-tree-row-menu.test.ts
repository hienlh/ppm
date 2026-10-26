import { describe, it, expect } from "bun:test";
import { tooltipWithoutTitle } from "../../../src/web/components/extensions/extension-tree-row-menu";

describe("tooltipWithoutTitle", () => {
  it("drops a first line that repeats the title the sheet already shows", () => {
    expect(tooltipWithoutTitle("#415 RTI retry", "#415 RTI retry\nYour PR · CI failing\nppm · 8h")).toBe("Your PR · CI failing\nppm · 8h");
    expect(tooltipWithoutTitle("#415 RTI retry", "  #415 RTI retry  \nYour PR")).toBe("Your PR");
  });

  it("keeps a tooltip that does not start with the title, and is empty without one", () => {
    expect(tooltipWithoutTitle("Title", "Something else\nmore")).toBe("Something else\nmore");
    expect(tooltipWithoutTitle("Title", undefined)).toBe("");
    expect(tooltipWithoutTitle("Title", "Title")).toBe("");
  });
});
