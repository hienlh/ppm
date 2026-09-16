/**
 * `MAX_DETAIL_FILES` bounds what one commit can push into the panel — and until
 * now it did it silently. The parser stopped at 500 and the panel rendered
 * `fileChanges.length`, so a commit touching ten thousand files was reported as
 * "500 files changed": a number with nothing behind it, on exactly the commits
 * where the count is the thing you are reading the panel for. The message cap
 * two constants away has always said `[… N more characters]`.
 *
 * Both halves are here because either alone is a green test over a broken
 * feature: a counter nothing renders, or a label with nothing to report.
 */
import { describe, it, expect } from "bun:test";
import { parseCommitDetail, MAX_DETAIL_FILES } from "./extension.ts";
import { getWebviewHtml } from "./webview-html.ts";

/** `git show --numstat --format=%H%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%B%n<END_MSG>`. */
function showOutput(files: number): string {
  const header = [
    "a".repeat(40), "", "Ada", "ada@example.com", "1700000000",
    "Ada", "ada@example.com", "1700000000", "a commit", "<END_MSG>",
  ].join("\n");
  const numstat = Array.from({ length: files }, (_, i) => `1\t0\tsrc/file-${i}.ts`);
  return `${header}\n\n${numstat.join("\n")}\n`;
}

/** The label as shipped, taken out of the script string rather than imported. */
const fileCountLabel = (() => {
  const html = getWebviewHtml();
  const start = html.indexOf("function fileCountLabel(");
  if (start === -1) throw new Error("no `fileCountLabel` in the shipped script");
  const end = html.indexOf("\n}", start);
  return new Function(`${html.slice(start, end + 2)}\nreturn fileCountLabel;`)() as (
    shown: number,
    omitted: number,
  ) => string;
})();

describe("the file cap counts what it dropped", () => {
  it("keeps every file of a commit that fits", () => {
    const detail = parseCommitDetail(showOutput(3));

    expect(detail.fileChanges).toHaveLength(3);
    expect(detail.filesOmitted).toBe(0);
  });

  it("stops at the cap and counts the rest", () => {
    const detail = parseCommitDetail(showOutput(MAX_DETAIL_FILES + 137));

    expect(detail.fileChanges).toHaveLength(MAX_DETAIL_FILES);
    expect(detail.filesOmitted).toBe(137);
    // The files it did keep are the first ones, not a truncated tail.
    expect(detail.fileChanges[0]!.path).toBe("src/file-0.ts");
  });
});

describe("the panel says the list is not all of it", () => {
  it("reports a complete list as a plain count", () => {
    expect(fileCountLabel(3, 0)).toBe("3 files changed");
    expect(fileCountLabel(1, 0)).toBe("1 file changed");
  });

  it("names the files it is not showing", () => {
    expect(fileCountLabel(500, 137)).toBe("500 files changed [… 137 more]");
  });
});
