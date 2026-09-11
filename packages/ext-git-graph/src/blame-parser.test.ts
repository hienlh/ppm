import { describe, it, expect } from "bun:test";
import { computeAgeWeights, isUncommittedHash, parseBlamePorcelain } from "./blame-parser.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

/** Build one porcelain block; `full` controls whether the commit header repeats. */
function block(hash: string, orig: number, final: number, content: string, full?: {
  author: string; mail: string; time: number; summary: string;
}): string {
  const lines = [`${hash} ${orig} ${final}`];
  if (full) {
    lines.push(
      `author ${full.author}`,
      `author-mail <${full.mail}>`,
      `author-time ${full.time}`,
      "author-tz +0000",
      `summary ${full.summary}`,
      "filename src/app.ts",
    );
  } else {
    lines.push("filename src/app.ts");
  }
  lines.push(`\t${content}`);
  return lines.join("\n");
}

describe("parseBlamePorcelain", () => {
  it("attaches metadata sent once to every later line of the same commit", () => {
    const stdout = [
      block(A, 1, 1, "const a = 1;", { author: "Mai", mail: "mai@example.com", time: 1700000000, summary: "add a" }),
      block(A, 2, 2, "const b = 2;"),
    ].join("\n") + "\n";

    const result = parseBlamePorcelain(stdout);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]!.hash).toBe(A);
    expect(result.lines[1]!.hash).toBe(A);
    // The second block carries no author line — it must still resolve.
    expect(result.commits[A]!.author).toBe("Mai");
    expect(result.commits[A]!.authorMail).toBe("mai@example.com");
    expect(result.commits[A]!.summary).toBe("add a");
  });

  it("keeps the line content verbatim, including a trailing CR", () => {
    const stdout = block(A, 1, 1, "const a = 1;\r", {
      author: "Mai", mail: "mai@example.com", time: 1, summary: "s",
    }) + "\n";

    const result = parseBlamePorcelain(stdout);

    expect(result.lines[0]!.content).toBe("const a = 1;\r");
  });

  it("preserves an empty line rather than dropping it", () => {
    const stdout = [
      block(A, 1, 1, "", { author: "Mai", mail: "m@e.com", time: 1, summary: "s" }),
      block(A, 2, 2, "x"),
    ].join("\n") + "\n";

    const result = parseBlamePorcelain(stdout);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]!.content).toBe("");
  });

  it("labels the all-zero hash as not committed yet", () => {
    const stdout = block(ZERO, 1, 1, "wip") + "\n";

    const result = parseBlamePorcelain(stdout);

    expect(isUncommittedHash(result.lines[0]!.hash)).toBe(true);
    expect(result.commits[ZERO]!.author).toBe("Not Committed Yet");
  });

  it("records the original and final line numbers separately", () => {
    const stdout = block(A, 12, 3, "moved", {
      author: "Mai", mail: "m@e.com", time: 1, summary: "s",
    }) + "\n";

    const result = parseBlamePorcelain(stdout);

    expect(result.lines[0]!.origLine).toBe(12);
    expect(result.lines[0]!.finalLine).toBe(3);
  });

  it("keeps the path a renamed file had at that commit", () => {
    const stdout = [
      `${A} 1 1`,
      "author Mai",
      "author-mail <m@e.com>",
      "author-time 1",
      "summary s",
      "filename src/old-name.ts",
      "\tcode",
    ].join("\n") + "\n";

    const result = parseBlamePorcelain(stdout);

    expect(result.commits[A]!.filename).toBe("src/old-name.ts");
  });

  it("returns nothing for an empty file", () => {
    expect(parseBlamePorcelain("")).toEqual({ lines: [], commits: {} });
  });
});

describe("computeAgeWeights", () => {
  it("scales the oldest commit to 0 and the newest to 1", () => {
    const commits = {
      [A]: { hash: A, author: "", authorMail: "", authorTime: 1000, summary: "", boundary: false },
      [B]: { hash: B, author: "", authorMail: "", authorTime: 2000, summary: "", boundary: false },
    };

    const weights = computeAgeWeights(commits);

    expect(weights[A]).toBe(0);
    expect(weights[B]).toBe(1);
  });

  it("does not let uncommitted lines flatten the scale", () => {
    const commits = {
      [A]: { hash: A, author: "", authorMail: "", authorTime: 1000, summary: "", boundary: false },
      [B]: { hash: B, author: "", authorMail: "", authorTime: 2000, summary: "", boundary: false },
      [ZERO]: { hash: ZERO, author: "", authorMail: "", authorTime: 0, summary: "", boundary: false },
    };

    const weights = computeAgeWeights(commits);

    // Without excluding it, the zero timestamp would become the minimum and
    // push both real commits to the warm end of the heatmap.
    expect(weights[A]).toBe(0);
    expect(weights[B]).toBe(1);
    expect(weights[ZERO]).toBe(1);
  });

  it("gives a single commit the full weight instead of dividing by zero", () => {
    const commits = {
      [A]: { hash: A, author: "", authorMail: "", authorTime: 1000, summary: "", boundary: false },
    };

    expect(computeAgeWeights(commits)[A]).toBe(1);
  });

  it("returns no weights when nothing is committed", () => {
    const commits = {
      [ZERO]: { hash: ZERO, author: "", authorMail: "", authorTime: 0, summary: "", boundary: false },
    };

    expect(computeAgeWeights(commits)).toEqual({});
  });
});
