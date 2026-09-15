/**
 * What the branch filter lists, for one query.
 *
 * The grouping is the part worth pinning: the local branches anyone is actually
 * choosing between are a handful, and they sit above several hundred
 * remote-tracking ones that share their names — so the order and the headings
 * are what make the list readable at all, not decoration.
 */
import { describe, it, expect } from "bun:test";
import { branchRows, rowIndexOf } from "../../../src/web/lib/branch-select-rows.ts";
import type { GitBranch } from "../../../src/types/git.ts";

const b = (name: string, over: Partial<GitBranch> = {}): GitBranch => ({
  name, current: false, remote: false, commitHash: "abc1234", ahead: 0, behind: 0, remotes: [], ...over,
});

const branches = [
  b("master"),
  b("fix/NX-5175-ni-rounding-unification", { current: true }),
  b("fix/NX-5838-viewer-pass-protect"),
  b("remotes/origin/NX-5175", { remote: true }),
  b("remotes/upstream/master", { remote: true }),
];

const names = (rows: ReturnType<typeof branchRows>) =>
  rows.map((r) => (r.kind === "separator" ? `# ${r.label}` : r.branch.name));

describe("branchRows", () => {
  it("puts local branches above remote ones, each under its own heading", () => {
    expect(names(branchRows(branches, ""))).toEqual([
      "# Branches",
      "master",
      "fix/NX-5175-ni-rounding-unification",
      "fix/NX-5838-viewer-pass-protect",
      "# Remote branches",
      "remotes/origin/NX-5175",
      "remotes/upstream/master",
    ]);
  });

  it("matches anywhere in the name, which is where a ticket number lives", () => {
    expect(names(branchRows(branches, "5175"))).toEqual([
      "# Branches",
      "fix/NX-5175-ni-rounding-unification",
      "# Remote branches",
      "remotes/origin/NX-5175",
    ]);
  });

  it("narrows to one remote when the remote is named", () => {
    expect(names(branchRows(branches, "origin"))).toEqual([
      "# Remote branches",
      "remotes/origin/NX-5175",
    ]);
  });

  it("ignores case and surrounding spaces", () => {
    expect(names(branchRows(branches, "  VIEWER  "))).toEqual([
      "# Branches",
      "fix/NX-5838-viewer-pass-protect",
    ]);
  });

  it("drops a heading whose group matched nothing, and answers nothing at all when neither did", () => {
    expect(names(branchRows(branches, "5838"))).toEqual(["# Branches", "fix/NX-5838-viewer-pass-protect"]);
    expect(branchRows(branches, "no-such-branch")).toEqual([]);
  });
});

describe("rowIndexOf", () => {
  it("finds the row a branch is on, past the heading above it", () => {
    const rows = branchRows(branches, "");
    expect(rowIndexOf(rows, "master")).toBe(1);
    expect(rowIndexOf(rows, "remotes/origin/NX-5175")).toBe(5);
  });

  it("answers -1 for a branch the filter left out, so the caller falls back", () => {
    expect(rowIndexOf(branchRows(branches, "5175"), "master")).toBe(-1);
  });
});
