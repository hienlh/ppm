import { describe, it, expect } from "bun:test";
import {
  SEARCH_FIELD_SEP, SEARCH_RECORD_SEP, buildSearchArgs, isSearchMode, parseSearchResults,
} from "./commit-search.ts";

const REPO = "/tmp/repo";
const A = "a".repeat(40);

describe("buildSearchArgs", () => {
  it("searches messages across all refs", () => {
    const args = buildSearchArgs({ mode: "message", text: "fix login" }, 50, REPO);

    expect(args).toContain("--all");
    expect(args).toContain("--grep=fix login");
    expect(args).toContain("--max-count=50");
  });

  it("searches authors", () => {
    expect(buildSearchArgs({ mode: "author", text: "Mai" }, 10, REPO)).toContain("--author=Mai");
  });

  it("uses the pickaxe for a code change", () => {
    expect(buildSearchArgs({ mode: "content", text: "getUser(" }, 10, REPO)).toContain("-SgetUser(");
  });

  it("puts a path after -- so it cannot be read as an option", () => {
    const args = buildSearchArgs({ mode: "file", text: "src/app.ts" }, 10, REPO);

    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("src/app.ts");
  });

  it("attaches the query to its flag so a leading dash stays data", () => {
    // As a separate argv element, "--output=x" would be read as an option.
    const args = buildSearchArgs({ mode: "message", text: "--output=/tmp/x" }, 10, REPO);

    expect(args).toContain("--grep=--output=/tmp/x");
    expect(args).not.toContain("--output=/tmp/x");
  });

  it("refuses a path that escapes the repository", () => {
    expect(() => buildSearchArgs({ mode: "file", text: "../../etc/passwd" }, 10, REPO))
      .toThrow(/escapes project root/);
  });

  it("refuses an absolute path", () => {
    expect(() => buildSearchArgs({ mode: "file", text: "/etc/passwd" }, 10, REPO))
      .toThrow(/Invalid file path/);
  });

  it("refuses control characters, which would break the record framing", () => {
    expect(() => buildSearchArgs({ mode: "message", text: `a${SEARCH_RECORD_SEP}b` }, 10, REPO))
      .toThrow(/control characters/);
  });

  it("refuses an empty query", () => {
    expect(() => buildSearchArgs({ mode: "message", text: "   " }, 10, REPO))
      .toThrow(/Enter something to search/);
  });

  it("refuses an unknown mode", () => {
    expect(() => buildSearchArgs({ mode: "exec" as never, text: "x" }, 10, REPO))
      .toThrow(/Unknown search mode/);
  });

  it("falls back to a sane limit when given a bad one", () => {
    expect(buildSearchArgs({ mode: "message", text: "x" }, -5, REPO)).toContain("--max-count=200");
  });
});

describe("parseSearchResults", () => {
  function record(fields: string[]): string {
    return SEARCH_RECORD_SEP + fields.join(SEARCH_FIELD_SEP);
  }

  it("reads a hit with its refs", () => {
    const stdout = record([A, "Mai", "mai@example.com", "1700000000", "HEAD -> main, origin/main", "fix login"]);

    expect(parseSearchResults(stdout)).toEqual([{
      hash: A,
      author: "Mai",
      authorEmail: "mai@example.com",
      authorDate: 1700000000,
      refs: ["HEAD -> main", "origin/main"],
      subject: "fix login",
    }]);
  });

  it("reads a hit with no refs", () => {
    const stdout = record([A, "Mai", "m@e.com", "1", "", "subject"]);

    expect(parseSearchResults(stdout)[0]!.refs).toEqual([]);
  });

  it("reads several hits", () => {
    const stdout = record([A, "Mai", "m@e.com", "2", "", "second"])
      + record(["b".repeat(40), "Nam", "n@e.com", "1", "", "first"]);

    expect(parseSearchResults(stdout).map((h) => h.subject)).toEqual(["second", "first"]);
  });

  it("returns nothing when no commit matched", () => {
    expect(parseSearchResults("")).toEqual([]);
  });
});

describe("isSearchMode", () => {
  it("accepts the supported modes", () => {
    for (const mode of ["message", "author", "content", "file"]) {
      expect(isSearchMode(mode)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isSearchMode("loaded")).toBe(false);
    expect(isSearchMode(null)).toBe(false);
  });
});
