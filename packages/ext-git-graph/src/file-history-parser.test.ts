import { describe, it, expect } from "bun:test";
import {
  FIELD_SEP, RECORD_SEP, buildLineRangeArg, parseFileHistory,
} from "./file-history-parser.ts";

function record(fields: string[], statusLines: string[] = []): string {
  return RECORD_SEP + fields.join(FIELD_SEP) + (statusLines.length ? "\n" + statusLines.join("\n") : "");
}

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("parseFileHistory", () => {
  it("reads one commit with its file status", () => {
    const stdout = record([A, "parent1", "Mai", "mai@example.com", "1700000000", "tidy up"], ["M\tsrc/app.ts"]);

    const entries = parseFileHistory(stdout);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      hash: A,
      parents: ["parent1"],
      author: "Mai",
      authorEmail: "mai@example.com",
      authorDate: 1700000000,
      subject: "tidy up",
      status: "M",
      path: "src/app.ts",
    });
  });

  it("keeps both sides of a rename", () => {
    const stdout = record([A, "p", "Mai", "m@e.com", "1", "move it"], ["R096\tsrc/old.ts\tsrc/new.ts"]);

    const entries = parseFileHistory(stdout);

    expect(entries[0]!.status).toBe("R");
    expect(entries[0]!.oldPath).toBe("src/old.ts");
    expect(entries[0]!.path).toBe("src/new.ts");
  });

  it("treats a copy like a rename", () => {
    const stdout = record([A, "p", "Mai", "m@e.com", "1", "copy"], ["C100\tsrc/a.ts\tsrc/b.ts"]);

    expect(parseFileHistory(stdout)[0]).toMatchObject({
      status: "C", oldPath: "src/a.ts", path: "src/b.ts",
    });
  });

  it("survives a merge commit that reports no file status", () => {
    const stdout = record([A, "p1 p2", "Mai", "m@e.com", "1", "merge branch"]);

    const entries = parseFileHistory(stdout);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.parents).toEqual(["p1", "p2"]);
    expect(entries[0]!.path).toBe("");
  });

  it("keeps a subject containing a tab or a pipe intact", () => {
    // The reason the format uses \x1f rather than a printable separator.
    const subject = "fix: a|b\tc";
    const stdout = record([A, "p", "Mai", "m@e.com", "1", subject], ["M\tsrc/app.ts"]);

    expect(parseFileHistory(stdout)[0]!.subject).toBe(subject);
  });

  it("reads several commits in one go", () => {
    const stdout = [
      record([A, "p", "Mai", "m@e.com", "2", "second"], ["M\tsrc/app.ts"]),
      record([B, "", "Nam", "nam@e.com", "1", "first"], ["A\tsrc/app.ts"]),
    ].join("");

    const entries = parseFileHistory(stdout);

    expect(entries.map((e) => e.hash)).toEqual([A, B]);
    expect(entries[1]!.status).toBe("A");
    expect(entries[1]!.parents).toEqual([]);
  });

  it("ignores a record missing fields rather than emitting a broken entry", () => {
    expect(parseFileHistory(RECORD_SEP + ["only", "two"].join(FIELD_SEP))).toEqual([]);
  });

  it("returns nothing for empty output", () => {
    expect(parseFileHistory("")).toEqual([]);
  });
});

describe("buildLineRangeArg", () => {
  it("builds the -L argument", () => {
    expect(buildLineRangeArg(10, 20, "src/app.ts")).toBe("-L10,20:src/app.ts");
  });

  it("orders an inverted selection so git still accepts it", () => {
    expect(buildLineRangeArg(20, 10, "src/app.ts")).toBe("-L10,20:src/app.ts");
  });

  it("handles a single-line range", () => {
    expect(buildLineRangeArg(7, 7, "a.ts")).toBe("-L7,7:a.ts");
  });
});
