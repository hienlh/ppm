/**
 * The two decisions in the picker that are not presentation.
 *
 * `checkoutTarget` is the one with teeth: `git checkout origin/foo` succeeds
 * and lands on a **detached HEAD**, so the bug it guards against looks exactly
 * like a working checkout until a commit made on it belongs to no branch.
 */
import { describe, test, expect } from "bun:test";
import {
  buildRows,
  checkoutTarget,
  firstSelectable,
  localNameFor,
  moveSelection,
  refDetail,
  PICKER_ACTIONS,
} from "../../../src/web/lib/git-ref-picker.ts";
import type { GitRef } from "../../../src/types/git.ts";

function ref(partial: Partial<GitRef> & Pick<GitRef, "name" | "type">): GitRef {
  return {
    refName: `refs/${partial.type === "branch" ? "heads" : partial.type === "remote" ? "remotes" : "tags"}/${partial.name}`,
    current: false,
    hash: "c".repeat(40),
    shortHash: "ccccccc",
    subject: "a commit",
    author: "thawngho",
    date: "2026-09-14T10:00:00Z",
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    ...partial,
  };
}

const REFS = [
  ref({ name: "main", type: "branch", current: true }),
  ref({ name: "feature/x", type: "branch" }),
  ref({ name: "origin/main", type: "remote" }),
  ref({ name: "origin/feature/y", type: "remote" }),
  ref({ name: "v1.0", type: "tag", subject: "release" }),
];

describe("buildRows", () => {
  test("the three actions come first, then one header per non-empty group", () => {
    const rows = buildRows(REFS, "");
    expect(rows.slice(0, 3).map((r) => r.kind === "action" && r.label)).toEqual(
      PICKER_ACTIONS.map((a) => a.label),
    );
    expect(rows.filter((r) => r.kind === "separator").map((r) => r.kind === "separator" && r.label))
      .toEqual(["branches", "remote branches", "tags"]);
  });

  test("a group whose every ref was filtered out loses its header too", () => {
    // A "tags" heading over nothing reads as a list that failed to load.
    const rows = buildRows(REFS, "feature");
    expect(rows.filter((r) => r.kind === "separator").map((r) => r.kind === "separator" && r.label))
      .toEqual(["branches", "remote branches"]);
    expect(rows.filter((r) => r.kind === "ref").map((r) => r.kind === "ref" && r.ref.name))
      .toEqual(["feature/x", "origin/feature/y"]);
  });

  test("the filter reaches the commit subject, not only the ref name", () => {
    const rows = buildRows(REFS, "release");
    expect(rows.filter((r) => r.kind === "ref").map((r) => r.kind === "ref" && r.ref.name)).toEqual(["v1.0"]);
  });

  test("the second stage asks only which ref, so it offers no actions", () => {
    const rows = buildRows(REFS, "", { actions: false });
    expect(rows.some((r) => r.kind === "action")).toBe(false);
    expect(rows.filter((r) => r.kind === "ref")).toHaveLength(REFS.length);
  });
});

describe("keyboard movement", () => {
  const rows = buildRows(REFS, "");

  test("arrow keys never stop on a group header", () => {
    let idx = firstSelectable(rows);
    const visited: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      visited.push(rows[idx]!.kind);
      idx = moveSelection(rows, idx, 1);
    }
    expect(visited).not.toContain("separator");
  });

  test("movement wraps in both directions", () => {
    const last = rows.length - 1;
    expect(moveSelection(rows, last, 1)).toBe(firstSelectable(rows));
    expect(moveSelection(rows, firstSelectable(rows), -1)).toBe(last);
  });

  test("an empty list selects nothing rather than row zero", () => {
    expect(firstSelectable([])).toBe(-1);
    expect(moveSelection([], 0, 1)).toBe(-1);
  });
});

describe("checkoutTarget", () => {
  test("a local branch is checked out by name", () => {
    expect(checkoutTarget(ref({ name: "feature/x", type: "branch" }), REFS))
      .toEqual({ ref: "feature/x", mode: "checkout" });
  });

  test("a tag is checked out by name — detaching at a tag is what a tag is for", () => {
    expect(checkoutTarget(ref({ name: "v1.0", type: "tag" }), REFS))
      .toEqual({ ref: "v1.0", mode: "checkout" });
  });

  test("a remote ref with no local counterpart is TRACKED, never checked out", () => {
    // `git checkout origin/feature/y` would detach HEAD and look like it worked.
    expect(checkoutTarget(ref({ name: "origin/feature/y", type: "remote" }), REFS))
      .toEqual({ ref: "origin/feature/y", mode: "track" });
  });

  test("a remote ref whose local branch already exists checks that one out", () => {
    // `-t` fails outright when the local branch exists, and the local branch is
    // what the user meant anyway.
    expect(checkoutTarget(ref({ name: "origin/main", type: "remote" }), REFS))
      .toEqual({ ref: "main", mode: "checkout" });
  });
});

describe("localNameFor", () => {
  test("strips only the remote, so a slashed branch keeps its slashes", () => {
    expect(localNameFor("origin/feature/x")).toBe("feature/x");
    expect(localNameFor("upstream/main")).toBe("main");
  });
});

describe("refDetail", () => {
  test("author, short hash and subject, as VS Code's second line", () => {
    expect(refDetail(ref({ name: "main", type: "branch", subject: "fix: a thing" })))
      .toBe("thawngho · ccccccc · fix: a thing");
  });

  test("a commit with no subject leaves no dangling separator", () => {
    expect(refDetail(ref({ name: "main", type: "branch", subject: "" })))
      .toBe("thawngho · ccccccc");
  });
});
