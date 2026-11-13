import { describe, expect, test } from "bun:test";
import { preserveCase } from "../../../../src/services/content-search/preserve-case";

// Cases follow VS Code's `buildReplaceStringWithCasePreserved` (src/vs/base/common/search.ts).
describe("preserveCase", () => {
  test("all upper, all lower, capitalised", () => {
    expect(preserveCase("FOO", "bar")).toBe("BAR");
    expect(preserveCase("foo", "BaR")).toBe("bar");
    expect(preserveCase("Foo", "bar")).toBe("Bar");
    expect(preserveCase("Foo", "barBaz")).toBe("BarBaz");
  });

  test("a match starting lower case but mixed lowers only the first letter", () => {
    expect(preserveCase("fOO", "BarBaz")).toBe("barBaz");
  });

  test("a match with no letters counts as upper case", () => {
    expect(preserveCase("123", "abc")).toBe("ABC");
  });

  test("hyphen- and underscore-separated parts are matched part by part", () => {
    expect(preserveCase("Foo-BAR", "abc-def")).toBe("Abc-DEF");
    expect(preserveCase("foo_BAR_Baz", "one_two_three")).toBe("one_TWO_Three");
  });

  test("a part count that differs falls back to the whole-match rule", () => {
    expect(preserveCase("Foo-Bar", "abc-def-ghi")).toBe("Abc-def-ghi");
    expect(preserveCase("FOO-BAR", "abc")).toBe("ABC");
  });

  test("both hyphens and underscores fall back to the whole-match rule", () => {
    expect(preserveCase("Foo-bar_Baz", "abc-def_ghi")).toBe("Abc-def_ghi");
  });

  test("an empty match or an empty replacement is left alone", () => {
    expect(preserveCase("", "Bar")).toBe("Bar");
    expect(preserveCase("Foo", "")).toBe("");
  });
});
