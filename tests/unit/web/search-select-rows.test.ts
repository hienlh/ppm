/**
 * What a searchable select lists for one query, and how branches are fed to it.
 *
 * The grouping is the part worth pinning: the local branches anyone is actually
 * choosing between are a handful, and they sit above several hundred
 * remote-tracking ones that share their names — so the order and the headings
 * are what make the list readable at all, not decoration.
 */
import { describe, it, expect } from "bun:test";
import { rowIndexOf, searchRows, type SearchSelectItem } from "../../../src/web/lib/search-select-rows.ts";
import { branchItems } from "../../../src/web/lib/branch-select-items.ts";
import type { GitBranch } from "../../../src/types/git.ts";

const b = (name: string, over: Partial<GitBranch> = {}): GitBranch => ({
  name, current: false, remote: false, commitHash: "abc1234", ahead: 0, behind: 0, remotes: [], ...over,
});

// Deliberately interleaved: git does not promise local-first, so the order is ours.
const branches = [
  b("master"),
  b("remotes/origin/NX-5175", { remote: true }),
  b("fix/NX-5175-ni-rounding-unification", { current: true }),
  b("remotes/upstream/master", { remote: true }),
  b("fix/NX-5838-viewer-pass-protect"),
];

const names = (rows: ReturnType<typeof searchRows>) =>
  rows.map((r) => (r.kind === "separator" ? `# ${r.label}` : r.item.label));

describe("branches in the select", () => {
  it("puts local branches above remote ones, each under its own heading", () => {
    expect(names(searchRows(branchItems(branches), ""))).toEqual([
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
    expect(names(searchRows(branchItems(branches), "5175"))).toEqual([
      "# Branches",
      "fix/NX-5175-ni-rounding-unification",
      "# Remote branches",
      "remotes/origin/NX-5175",
    ]);
  });

  it("narrows to one remote when the remote is named", () => {
    expect(names(searchRows(branchItems(branches), "origin"))).toEqual([
      "# Remote branches",
      "remotes/origin/NX-5175",
    ]);
  });

  it("marks the checked-out branch, and only that one", () => {
    const hints = branchItems(branches).filter((i) => i.hint).map((i) => [i.label, i.hint]);
    expect(hints).toEqual([["fix/NX-5175-ni-rounding-unification", "current"]]);
  });
});

describe("searchRows", () => {
  const repos: SearchSelectItem[] = [
    { value: "/w/nxsys-backend-nx5833", label: "nxsys-backend-nx5833" },
    { value: "/w/nxsys-backend-nx5838", label: "nxsys-backend-nx5838" },
    { value: "/w/prod-ref/nxsys-backend", label: "prod-ref/nxsys-backend" },
  ];

  it("lists items with no group without any heading at all", () => {
    expect(names(searchRows(repos, ""))).toEqual([
      "nxsys-backend-nx5833", "nxsys-backend-nx5838", "prod-ref/nxsys-backend",
    ]);
  });

  it("ignores case and surrounding spaces", () => {
    expect(names(searchRows(repos, "  NX5838  "))).toEqual(["nxsys-backend-nx5838"]);
  });

  it("drops a heading whose group matched nothing, and answers nothing when no group did", () => {
    expect(names(searchRows(branchItems(branches), "5838"))).toEqual(["# Branches", "fix/NX-5838-viewer-pass-protect"]);
    expect(searchRows(branchItems(branches), "no-such-branch")).toEqual([]);
  });

  it("keeps the groups in the order of the whole list, not of what matched first", () => {
    const items: SearchSelectItem[] = [
      { value: "a", label: "alpha", group: "One" },
      { value: "b", label: "beta match", group: "Two" },
      { value: "c", label: "gamma match", group: "One" },
    ];
    expect(names(searchRows(items, "match"))).toEqual(["# One", "gamma match", "# Two", "beta match"]);
  });
});

describe("rowIndexOf", () => {
  it("finds the row a value is on, past the heading above it", () => {
    const rows = searchRows(branchItems(branches), "");
    expect(rowIndexOf(rows, "master")).toBe(1);
    expect(rowIndexOf(rows, "remotes/origin/NX-5175")).toBe(5);
  });

  it("answers -1 for a value the filter left out, so the caller falls back", () => {
    expect(rowIndexOf(searchRows(branchItems(branches), "5175"), "master")).toBe(-1);
  });
});
