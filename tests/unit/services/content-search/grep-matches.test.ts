import { describe, expect, test } from "bun:test";
import { createGrepMatcher } from "../../../../src/services/content-search/grep-matches.ts";

const base = { caseSensitive: false, wholeWord: false, regex: false };

function cols(query: string, line: string, opts: Partial<typeof base> = {}) {
  return createGrepMatcher({ ...base, ...opts, query })
    .matchLine(line)
    .map((m) => [m.column, m.length, m.text]);
}

describe("grep fallback: literal matches", () => {
  test("every match on a line, with UTF-16 columns", () => {
    expect(cols("foo", "foo bar foo", { caseSensitive: true })).toEqual([
      [0, 3, "foo"],
      [8, 3, "foo"],
    ]);
  });

  test("columns count UTF-16 units after é and an emoji", () => {
    expect(cols("x", "é😀x", { caseSensitive: true })).toEqual([[3, 1, "x"]]);
  });

  test("Match Case off finds every case shape and keeps the line's own text", () => {
    expect(cols("foo", "Foo FOO foo")).toEqual([
      [0, 3, "Foo"],
      [4, 3, "FOO"],
      [8, 3, "foo"],
    ]);
  });

  test("Match Case on skips other case shapes", () => {
    expect(cols("foo", "Foo FOO foo", { caseSensitive: true })).toEqual([[8, 3, "foo"]]);
  });

  test("regex characters in a literal query are plain text", () => {
    expect(cols("a.b(", "axb( a.b(", { caseSensitive: true })).toEqual([[5, 4, "a.b("]]);
  });

  test("overlapping occurrences are not counted twice", () => {
    expect(cols("aa", "aaaa", { caseSensitive: true })).toEqual([
      [0, 2, "aa"],
      [2, 2, "aa"],
    ]);
  });

  test("Whole Word keeps only matches bounded by non-word characters, letters with accents included", () => {
    expect(cols("cat", "cat cats concat (cat) écat", { wholeWord: true })).toEqual([
      [0, 3, "cat"],
      [17, 3, "cat"],
    ]);
  });

  test("the replacement of a literal search is the replace text as typed, $ included", () => {
    const m = createGrepMatcher({ ...base, query: "foo", replace: "$1 $& $$" });
    expect(m.replaceAvailable).toBe(true);
    expect(m.matchLine("a foo").map((x) => x.replacement)).toEqual(["$1 $& $$"]);
  });

  test("no replace text means no replacement field", () => {
    const [m] = createGrepMatcher({ ...base, query: "foo" }).matchLine("foo");
    expect(m.replacement).toBeUndefined();
  });
});

describe("grep fallback: regex matches", () => {
  test("every match with its column range", () => {
    expect(cols("\\d+", "a1 b22 c333", { regex: true })).toEqual([
      [1, 1, "1"],
      [4, 2, "22"],
      [8, 3, "333"],
    ]);
  });

  test("Match Case off makes the regex case-insensitive", () => {
    expect(cols("fo+", "FOO", { regex: true })).toEqual([[0, 3, "FOO"]]);
    expect(cols("fo+", "FOO foo", { regex: true, caseSensitive: true })).toEqual([[4, 3, "foo"]]);
  });

  test("Whole Word and Regex together bound the regex by word boundaries", () => {
    expect(cols("ca.", "cat cats scat car", { regex: true, wholeWord: true })).toEqual([
      [0, 3, "cat"],
      [14, 3, "car"],
    ]);
  });

  test("Whole Word with an alternation bounds the whole alternation", () => {
    expect(cols("a|b", "ab a b", { regex: true, wholeWord: true })).toEqual([
      [3, 1, "a"],
      [5, 1, "b"],
    ]);
  });

  test("look-around runs", () => {
    expect(cols("foo(?=bar)", "foobaz foobar", { regex: true })).toEqual([[7, 3, "foo"]]);
  });

  test("a zero-length match is reported once per position and does not loop", () => {
    expect(cols("^", "abc", { regex: true })).toEqual([[0, 0, ""]]);
  });

  test("replacements expand $1, $&, $0, $$ and named groups per match", () => {
    const m = createGrepMatcher({
      ...base,
      regex: true,
      caseSensitive: true,
      query: "(?<k>\\w+)=(\\w+)",
      replace: "$2=$1 [$&] [$0] $$ $<k> ${k}",
    });
    expect(m.replaceAvailable).toBe(true);
    expect(m.matchLine("a=1, bb=22").map((x) => x.replacement)).toEqual([
      "1=a [a=1] [a=1] $ a a",
      "22=bb [bb=22] [bb=22] $ bb bb",
    ]);
  });

  test("a replacement sees the match's own groups when the regex uses look-behind", () => {
    const m = createGrepMatcher({ ...base, regex: true, query: "(?<=x)(\\d)", replace: "<$1>" });
    expect(m.matchLine("x1 y2 x3").map((x) => [x.column, x.replacement])).toEqual([
      [1, "<1>"],
      [7, "<3>"],
    ]);
  });

  test("an unmatched optional group expands to nothing", () => {
    const m = createGrepMatcher({ ...base, regex: true, query: "a(b)?", replace: "[$1]" });
    expect(m.matchLine("a").map((x) => x.replacement)).toEqual(["[]"]);
  });
});

describe("grep fallback: a pattern JavaScript cannot run", () => {
  test("matches the whole line, without a replacement, and says replace is unavailable", () => {
    // POSIX character classes and possessive quantifiers: grep runs them, JS does not.
    const m = createGrepMatcher({ ...base, regex: true, query: "a++[[:digit:]", replace: "x" });
    expect(m.replaceAvailable).toBe(false);
    expect(m.matchLine("  aa1 tail")).toEqual([{ column: 0, length: 10, text: "  aa1 tail" }]);
  });

  test("a JS-runnable regex that finds nothing on a line grep reported still lists the line", () => {
    const m = createGrepMatcher({ ...base, regex: true, caseSensitive: true, query: "zzz", replace: "y" });
    expect(m.replaceAvailable).toBe(true);
    expect(m.matchLine("abc")).toEqual([{ column: 0, length: 3, text: "abc" }]);
  });
});
