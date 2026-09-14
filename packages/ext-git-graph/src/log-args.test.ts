/**
 * `git-exec.ts` opens with the rule this file enforces: every git argument that
 * originates in a webview passes through one of its `assert*` guards before it
 * reaches `spawn`. The branch in a commit window did not — and since the stats
 * pass was split out, that window is built twice per request, so the value
 * reached git on two paths instead of one.
 *
 * git does reject a dash-leading refname by itself, so nothing was exploitable.
 * The guard is what makes that a property of this code rather than a property
 * of whichever git happens to be installed.
 */
import { describe, it, expect } from "bun:test";
import { logArgs } from "./extension.ts";

describe("logArgs", () => {
  it("puts a real branch at the end of the arguments", () => {
    const args = logArgs({ maxCommits: 50, skip: 0, branch: "feature/x" }, "--format=%H");

    expect(args).toEqual(["log", "--format=%H", "--topo-order", "-n", "50", "feature/x"]);
  });

  it("asks for every ref but the stashes when no branch is named", () => {
    for (const window of [{ maxCommits: 10, skip: 0 }, { maxCommits: 10, skip: 0, branch: "all" }]) {
      expect(logArgs(window, "--format=%H")).toEqual([
        "log", "--format=%H", "--topo-order", "-n", "10", "--exclude=refs/stash", "--all",
      ]);
    }
  });

  it("carries the window's paging and ordering", () => {
    expect(logArgs({ maxCommits: 20, skip: 40, ordering: "date", firstParentOnly: true }, "--format=%H"))
      .toEqual([
        "log", "--format=%H", "--date-order", "-n", "20", "--first-parent", "--skip=40",
        "--exclude=refs/stash", "--all",
      ]);
    expect(logArgs({ maxCommits: 20, skip: 0, ordering: "author-date" }, "--format=%H"))
      .toContain("--author-date-order");
  });

  it("refuses a branch git would read as an option", () => {
    expect(() => logArgs({ maxCommits: 10, skip: 0, branch: "--upload-pack=sh" }, "--format=%H"))
      .toThrow(/Invalid git ref/);
  });

  it("refuses a branch that is really a range", () => {
    // `a..b` is two commits, not one ref: it would silently change which
    // commits the graph and the stats pass are asking about.
    expect(() => logArgs({ maxCommits: 10, skip: 0, branch: "main..evil" }, "--format=%H"))
      .toThrow(/Invalid git ref/);
  });

  it("refuses a branch with a control character or a revision operator in it", () => {
    for (const branch of ["main\u0000", "main^{tree}", "main:path", "ma in\n--all"]) {
      expect(() => logArgs({ maxCommits: 10, skip: 0, branch }, "--format=%H")).toThrow(/Invalid git ref/);
    }
  });
});
