/**
 * Where the Review changes tab puts each block's bar when it shows the whole
 * file side by side: blocks from the staged diff, the open diff and the tab's
 * discards, all placed in working-tree lines.
 */
import { describe, expect, it } from "bun:test";
import { blockAtLine, indexToWorktree, placeBlocks, sideBySideSupported } from "../../../src/web/lib/git-review-side-by-side";
import type { ReviewBlock } from "../../../src/web/lib/git-review-model";
import type { ChangeLine } from "../../../src/shared/git-changes";

const L = (spec: string): ChangeLine[] =>
  spec.split("|").map((s) => ({ kind: s[0] as ChangeLine["kind"], text: s.slice(1) }));

function block(p: {
  key: string;
  side: "staged" | "unstaged";
  state?: ReviewBlock["state"];
  oldStart: number;
  newStart: number;
  lines?: string;
  whole?: ReviewBlock["whole"];
}): ReviewBlock {
  const lines = p.lines ? L(p.lines) : [];
  const oldLines = lines.filter((l) => l.kind !== "+").length;
  const newLines = lines.filter((l) => l.kind !== "-").length;
  return {
    key: p.key,
    state: p.state ?? (p.side === "staged" ? "staged" : "open"),
    side: p.side,
    hunk: p.whole ? null : { id: p.key, index: 0, oldStart: p.oldStart, oldLines, newStart: p.newStart, newLines, added: 0, removed: 0 },
    whole: p.whole ?? null,
    parts: p.lines ? [{ oldStart: p.oldStart, newStart: p.newStart, lines }] : null,
    anchor: 0,
    first: 0,
    last: 0,
    added: 0,
    removed: 0,
  };
}

describe("indexToWorktree", () => {
  // Index lines 10-12 replaced by 4 lines (worktree 10-13), and 2 lines inserted after index line 30.
  const hunks = [
    { oldStart: 9, oldLines: 5, newStart: 9, newLines: 6, lines: L(" a|-b|-c|-d|+B|+C|+D|+E| e") },
    { oldStart: 30, oldLines: 0, newStart: 32, newLines: 2 },
  ];

  it("leaves lines before any change where they are", () => {
    expect(indexToWorktree(5, hunks)).toBe(5);
  });

  it("shifts lines after a change by what it added", () => {
    expect(indexToWorktree(20, hunks)).toBe(21);
    expect(indexToWorktree(30, hunks)).toBe(31);
    expect(indexToWorktree(31, hunks)).toBe(34);
  });

  it("maps a line inside a hunk exactly when its lines are known", () => {
    expect(indexToWorktree(9, hunks)).toBe(9);
    // A removed line maps to where it was: the next line of the working tree.
    expect(indexToWorktree(10, hunks)).toBe(10);
    expect(indexToWorktree(13, hunks)).toBe(14);
  });
});

describe("placeBlocks", () => {
  it("puts an open block's bar at its first changed line, in working-tree numbers", () => {
    const open = block({ key: "u:1", side: "unstaged", oldStart: 4, newStart: 4, lines: " a| b| c|-d|+D| e" });
    expect(placeBlocks([open])).toEqual([{ key: "u:1", line: 7, first: 4, last: 8 }]);
  });

  it("puts a removal-only block's bar on the line that now follows it", () => {
    const open = block({ key: "u:1", side: "unstaged", oldStart: 1, newStart: 1, lines: " a|-b|-c| d" });
    expect(placeBlocks([open])[0]!.line).toBe(2);
  });

  it("moves a staged block below an open one by the lines the open one added", () => {
    // Open: 2 lines added near the top of the working tree. Staged: changes index line 20.
    const open = block({ key: "u:1", side: "unstaged", oldStart: 2, newStart: 2, lines: " a|+x|+y| b" });
    const staged = block({ key: "s:1", side: "staged", oldStart: 18, newStart: 18, lines: " p| q|-r|+R| s" });
    const places = placeBlocks([open, staged]);
    expect(places[1]).toEqual({ key: "s:1", line: 22, first: 20, last: 23 });
  });

  it("places a discarded block by its index lines, the working tree having taken them back", () => {
    const open = block({ key: "u:1", side: "unstaged", oldStart: 2, newStart: 2, lines: " a|+x| b" });
    const gone = block({ key: "d:r:0", side: "unstaged", state: "discarded", oldStart: 40, newStart: 40, lines: " k|-l|+L| m" });
    expect(placeBlocks([open, gone])[1]).toEqual({ key: "d:r:0", line: 42, first: 41, last: 43 });
  });

  it("keeps an open block being staged in the working tree's numbers until git answers", () => {
    const moving = block({ key: "u:1", side: "unstaged", state: "staged", oldStart: 10, newStart: 12, lines: "-a|+A" });
    expect(placeBlocks([moving])[0]).toEqual({ key: "u:1", line: 12, first: 12, last: 12 });
  });

  it("puts a deleted file's one block at the top", () => {
    expect(placeBlocks([block({ key: "u:whole", side: "unstaged", oldStart: 0, newStart: 0, whole: "deleted" })])[0]!.line).toBe(1);
  });
});

describe("blockAtLine", () => {
  it("finds the block covering a line, preferring an open one where a staged one overlaps", () => {
    const staged = block({ key: "s:1", side: "staged", oldStart: 10, newStart: 10, lines: " a| b|-c|+C| d| e" });
    const open = block({ key: "u:1", side: "unstaged", oldStart: 12, newStart: 12, lines: " C|-d|+D| e" });
    const blocks = [staged, open];
    const places = placeBlocks(blocks);
    expect(blockAtLine(blocks, places, 13)).toBe("u:1");
    expect(blockAtLine(blocks, places, 10)).toBe("s:1");
    expect(blockAtLine(blocks, places, 40)).toBeNull();
  });
});

describe("sideBySideSupported", () => {
  it("takes line blocks and a deleted file, and leaves binary, renames and the like to the block list", () => {
    expect(sideBySideSupported([block({ key: "u:1", side: "unstaged", oldStart: 1, newStart: 1, lines: "-a|+b" })])).toBe(true);
    expect(sideBySideSupported([block({ key: "u:whole", side: "unstaged", oldStart: 0, newStart: 0, whole: "deleted" })])).toBe(true);
    for (const whole of ["binary", "rename", "large", "submodule", "mode", "empty"] as const) {
      expect(sideBySideSupported([block({ key: "s:whole", side: "staged", oldStart: 0, newStart: 0, whole })])).toBe(false);
    }
    expect(sideBySideSupported([])).toBe(false);
  });
});
