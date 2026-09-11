import { describe, it, expect } from "bun:test";
import { parseBlamePorcelain } from "../../../../src/services/git-blame/blame-porcelain.ts";
import {
  formatBlameAnnotation,
  formatRelativeTime,
  UNCOMMITTED_HASH,
} from "../../../../src/shared/blame.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

/**
 * Three lines: two from commit A, one from commit B. A's header is written in
 * full the first time only — the third line references it by sha alone, which
 * is the whole reason this parser accumulates commits into a map.
 */
const PORCELAIN = [
  `${A} 1 1 2`,
  "author Alice",
  "author-mail <alice@example.com>",
  "author-time 1700000000",
  "author-tz +0000",
  "committer Alice",
  "committer-time 1700000000",
  "summary Add the thing",
  "filename src/app.ts",
  "\tconst a = 1;",
  `${B} 7 2 1`,
  "author Bob",
  "author-mail <bob@example.com>",
  "author-time 1710000000",
  "summary Fix the thing",
  "previous 0123456789012345678901234567890123456789 src/app.ts",
  "filename src/app.ts",
  "\tconst b = 2;",
  `${A} 2 3`,
  "\tconst c = 3;",
  "",
].join("\n");

describe("parseBlamePorcelain", () => {
  it("maps every line to the commit that produced it", () => {
    const { lines } = parseBlamePorcelain(PORCELAIN);

    expect(lines).toEqual([
      { hash: A, finalLine: 1, origLine: 1 },
      { hash: B, finalLine: 2, origLine: 7 },
      { hash: A, finalLine: 3, origLine: 2 },
    ]);
  });

  it("keeps the header a repeated commit only sent once", () => {
    const { commits } = parseBlamePorcelain(PORCELAIN);

    expect(commits[A]).toMatchObject({
      author: "Alice",
      authorMail: "alice@example.com",
      authorTime: 1700000000,
      summary: "Add the thing",
      filename: "src/app.ts",
    });
  });

  it("reads only the sha out of a `previous` line", () => {
    const { commits } = parseBlamePorcelain(PORCELAIN);

    expect(commits[B]!.previous).toBe("0123456789012345678901234567890123456789");
    expect(commits[A]!.previous).toBeUndefined();
  });

  it("labels an all-zero sha as uncommitted without waiting for a header", () => {
    const { lines, commits } = parseBlamePorcelain(
      [`${UNCOMMITTED_HASH} 4 4 1`, "author Not Committed Yet", "\tconst d = 4;", ""].join("\n"),
    );

    expect(lines[0]!.hash).toBe(UNCOMMITTED_HASH);
    expect(commits[UNCOMMITTED_HASH]!.summary).toBe("Uncommitted changes");
  });

  it("does not mistake a content line's trailing CR for framing", () => {
    const { lines } = parseBlamePorcelain(
      [`${A} 1 1 1`, "author Alice", "\tconst a = 1;\r", ""].join("\n"),
    );

    expect(lines).toHaveLength(1);
  });

  it("does not treat a content line starting with a sha as a header", () => {
    // A file whose text happens to look like porcelain framing.
    const { lines } = parseBlamePorcelain(
      [`${A} 1 1 1`, "author Alice", `\t${B} 9 9 9`, ""].join("\n"),
    );

    expect(lines).toEqual([{ hash: A, finalLine: 1, origLine: 1 }]);
  });

  it("returns nothing for empty output", () => {
    expect(parseBlamePorcelain("")).toEqual({ lines: [], commits: {} });
  });
});

describe("formatRelativeTime", () => {
  const now = 1_700_000_000_000;
  const ago = (seconds: number) => formatRelativeTime(now - seconds * 1000, now);

  it("reads the scale down from years to seconds", () => {
    expect(ago(10)).toBe("just now");
    expect(ago(60)).toBe("1 minute ago");
    expect(ago(3600)).toBe("1 hour ago");
    expect(ago(86400 * 3)).toBe("3 days ago");
    expect(ago(86400 * 45)).toBe("1 month ago");
    expect(ago(86400 * 400)).toBe("1 year ago");
  });

  it("does not run backwards for a commit dated in the future", () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe("just now");
  });
});

describe("formatBlameAnnotation", () => {
  const now = 1_700_086_400_000; // one day after the commit below

  it("reads author, age and summary", () => {
    const text = formatBlameAnnotation(
      { hash: A, author: "Alice", authorMail: "a@b.c", authorTime: 1_700_000_000, summary: "Add the thing" },
      now,
    );

    expect(text).toBe("Alice, 1 day ago • Add the thing");
  });

  it("says so plainly for a line that is not committed", () => {
    const text = formatBlameAnnotation(
      { hash: UNCOMMITTED_HASH, author: "You", authorMail: "", authorTime: 0, summary: "" },
      now,
    );

    expect(text).toBe("You, uncommitted changes");
  });

  it("leaves out the age when git gave no author time", () => {
    const text = formatBlameAnnotation(
      { hash: A, author: "Alice", authorMail: "", authorTime: 0, summary: "Add the thing" },
      now,
    );

    expect(text).toBe("Alice • Add the thing");
  });

  it("is empty for no commit at all", () => {
    expect(formatBlameAnnotation(undefined, now)).toBe("");
    expect(formatBlameAnnotation(null, now)).toBe("");
  });
});
