/**
 * The reflog panel is the undo surface for the destructive things the other
 * panels do, so the one destructive thing *it* offers is the one that has to be
 * hardest to fire by accident.
 */
import { describe, it, expect } from "bun:test";
import { resetHardRefusal } from "../../../packages/ext-git-graph/src/reflog-view.ts";

describe("resetHardRefusal", () => {
  it("allows a clean worktree", () => {
    expect(resetHardRefusal({ exitCode: 0, stdout: "" })).toBeNull();
    expect(resetHardRefusal({ exitCode: 0, stdout: "\n" })).toBeNull();
  });

  it("refuses a dirty one", () => {
    expect(resetHardRefusal({ exitCode: 0, stdout: " M src/app.ts\n" }))
      .toMatch(/discard uncommitted changes/);
    expect(resetHardRefusal({ exitCode: 0, stdout: "?? notes.txt\n" }))
      .toMatch(/discard uncommitted changes/);
  });

  it("refuses when git could not answer at all", () => {
    // The failure mode this exists for: a `git status` that exits non-zero
    // writes nothing to stdout, so a check that reads only stdout sees "clean"
    // and lets `reset --hard` run on the strength of an answer it never got.
    expect(resetHardRefusal({ exitCode: 128, stdout: "" }))
      .toMatch(/Could not check whether the working tree is clean/);
    expect(resetHardRefusal({ exitCode: 1, stdout: " M src/app.ts\n" }))
      .toMatch(/Could not check whether the working tree is clean/);
  });
});
