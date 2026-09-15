import { describe, it, expect } from "bun:test";
import {
  REFLOG_FIELD_SEP, REFLOG_RECORD_SEP,
  assertValidSelector, parseReflog, reflogKind,
} from "./reflog-parser.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

function record(fields: string[]): string {
  return fields.join(REFLOG_FIELD_SEP) + REFLOG_RECORD_SEP;
}

const STDOUT =
  record([A, "HEAD@{0}", "commit: add the thing", "Ada", "ada@example.com", "1700000000", "add the thing"]) +
  "\n" +
  record([B, "HEAD@{1}", "rebase (finish): returning to refs/heads/main", "Ada", "ada@example.com", "1699999000", "earlier work"]);

describe("parseReflog", () => {
  it("reads every field of an entry", () => {
    const [first] = parseReflog(STDOUT);

    expect(first).toEqual({
      hash: A,
      selector: "HEAD@{0}",
      action: "commit: add the thing",
      kind: "commit",
      author: "Ada",
      authorEmail: "ada@example.com",
      authorDate: 1700000000,
      subject: "add the thing",
    });
  });

  it("does not let the newline between records leak into the next hash", () => {
    // git separates records with the record byte, but the format string leaves a
    // newline after each one; a hash that kept it would fail every later check.
    expect(parseReflog(STDOUT)[1]!.hash).toBe(B);
  });

  it("takes the verb out of a parenthesised action", () => {
    expect(parseReflog(STDOUT)[1]!.kind).toBe("rebase");
  });

  it("drops a record whose framing was lost rather than half-reading it", () => {
    // A truncated record would otherwise yield a selector pointing somewhere
    // else — and the selector is what a recovery command is handed.
    const damaged = "not-a-hash" + REFLOG_FIELD_SEP + "HEAD@{9}" + REFLOG_RECORD_SEP + STDOUT;

    expect(parseReflog(damaged).map((e) => e.hash)).toEqual([A, B]);
  });

  it("returns nothing for empty output", () => {
    expect(parseReflog("")).toEqual([]);
    expect(parseReflog("\n")).toEqual([]);
  });
});

describe("reflogKind", () => {
  it("reads the verb before the colon", () => {
    expect(reflogKind("commit: add the thing")).toBe("commit");
    expect(reflogKind("reset: moving to HEAD~2")).toBe("reset");
    expect(reflogKind("checkout: moving from main to develop")).toBe("checkout");
  });

  it("reads the verb before a parenthesis", () => {
    expect(reflogKind("rebase (finish): returning to refs/heads/main")).toBe("rebase");
    expect(reflogKind("commit (amend): fix typo")).toBe("commit");
  });

  it("is empty for an empty action", () => {
    expect(reflogKind("")).toBe("");
  });
});

describe("assertValidSelector", () => {
  it("accepts the shapes git emits", () => {
    expect(assertValidSelector("HEAD@{0}")).toBe("HEAD@{0}");
    expect(assertValidSelector("HEAD@{123}")).toBe("HEAD@{123}");
    expect(assertValidSelector("refs/heads/main@{3}")).toBe("refs/heads/main@{3}");
    expect(assertValidSelector(A)).toBe(A);
  });

  it("refuses anything that could be read as an option or a range", () => {
    expect(() => assertValidSelector("--exec=rm -rf /")).toThrow(/Invalid reflog selector/);
    expect(() => assertValidSelector("HEAD@{0}..HEAD@{2}")).toThrow(/Invalid reflog selector/);
    expect(() => assertValidSelector("a..b@{1}")).toThrow(/Invalid reflog selector/);
    expect(() => assertValidSelector("HEAD@{0}; rm -rf /")).toThrow(/Invalid reflog selector/);
    expect(() => assertValidSelector("HEAD")).toThrow(/Invalid reflog selector/);
    expect(() => assertValidSelector("")).toThrow(/Invalid reflog selector/);
    expect(() => assertValidSelector(undefined)).toThrow(/Invalid reflog selector/);
  });
});
