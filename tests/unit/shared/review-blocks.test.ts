/**
 * The blocks the session review is answered in: unified-diff hunks whose keys survive edits
 * elsewhere in the file, and a revert that puts back the base's exact bytes for the chosen
 * blocks only.
 */
import { describe, expect, it } from "bun:test";
import { computeBlocks, reapply, revertBlocks, splitLines } from "../../../src/shared/review-blocks.ts";

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");

function edit(text: string, at: number, replacement: string[]): string {
  const all = splitLines(text);
  all.splice(at, 1, ...replacement.map((l) => `${l}\n`));
  return all.join("");
}

describe("splitLines", () => {
  it("keeps terminators, CRLF and a last line without one", () => {
    expect(splitLines("a\r\nb\nc")).toEqual(["a\r\n", "b\n", "c"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n\n")).toEqual(["\n", "\n"]);
  });
});

describe("computeBlocks", () => {
  it("cuts separate changes into blocks with three lines of context and numbered rows", () => {
    const base = lines(30);
    const now = edit(edit(base, 24, ["changed 25"]), 4, ["changed 5", "added"]);
    const diff = computeBlocks(base, now)!;
    expect(diff.blocks).toHaveLength(2);
    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(2);
    const [first, second] = diff.blocks;
    expect(first!.rows.map((r) => r.k).join("")).toBe("   -++   ");
    expect(first!.rows[0]).toEqual({ k: " ", text: "line 2", o: 2, n: 2 });
    expect(first!.rows[3]).toEqual({ k: "-", text: "line 5", o: 5, n: null });
    expect(first!.rows[5]).toEqual({ k: "+", text: "added", o: null, n: 6 });
    expect([first!.oldFrom, first!.oldTo, first!.newFrom, first!.newTo]).toEqual([1, 8, 1, 9]);
    // The second block sits one line lower in the file now than in the base.
    expect(second!.rows.find((r) => r.k === "+")).toEqual({ k: "+", text: "changed 25", o: null, n: 26 });
  });

  it("merges changes six or fewer unchanged lines apart into one block, as git does", () => {
    const base = lines(30);
    expect(computeBlocks(base, edit(edit(base, 17, ["x"]), 10, ["y"]))!.blocks).toHaveLength(1);
    expect(computeBlocks(base, edit(edit(base, 18, ["x"]), 10, ["y"]))!.blocks).toHaveLength(2);
  });

  it("keeps a block's key when the file changes elsewhere, and changes it when the block does", () => {
    const base = lines(40);
    const once = edit(base, 30, ["agent 31"]);
    const key = computeBlocks(base, once)!.blocks[0]!.key;
    // A line added near the top moves the block in the file now, not in the base.
    const later = edit(once, 2, ["line 3", "inserted"]);
    const moved = computeBlocks(base, later)!.blocks;
    expect(moved).toHaveLength(2);
    expect(moved[1]!.key).toBe(key);
    // The agent touches the block again: same place, different lines, new key.
    expect(computeBlocks(base, edit(once, 30, ["agent 31 again"]))!.blocks[0]!.key).not.toBe(key);
  });

  it("tells identical changes apart by their place in the base", () => {
    const base = lines(40, "same");
    const now = edit(edit(base, 30, ["x"]), 5, ["x"]);
    const [a, b] = computeBlocks(base, now)!.blocks;
    expect(a!.key).not.toBe(b!.key);
  });

  it("answers a created or deleted file as one block", () => {
    expect(computeBlocks("", "a\nb\n")!.blocks).toHaveLength(1);
    const gone = computeBlocks("a\nb\n", "")!;
    expect(gone.blocks).toHaveLength(1);
    expect(gone.blocks[0]!.rows.every((r) => r.k === "-")).toBe(true);
  });

  it("has no blocks when nothing changed", () => {
    expect(computeBlocks("same\n", "same\n")!.blocks).toEqual([]);
  });
});

describe("revertBlocks", () => {
  it("puts back only the chosen blocks, byte for byte", () => {
    const base = "keep\r\n".repeat(3) + "old 4\r\n" + "keep\r\n".repeat(10) + "old 15\r\nlast";
    const now = base.replace("old 4\r\n", "new 4\r\nmore\r\n").replace("old 15\r\nlast", "new 15\r\nlast!");
    const [first, second] = computeBlocks(base, now)!.blocks;
    const one = revertBlocks(base, now, [second!]);
    expect(one).toBe(base.replace("old 4\r\n", "new 4\r\nmore\r\n"));
    expect(revertBlocks(base, now, [first!, second!])).toBe(base);
    // What is left is exactly the other block.
    expect(computeBlocks(base, one)!.blocks.map((b) => b.key)).toEqual([first!.key]);
  });
});

describe("reapply", () => {
  it("makes a change again in a file that moved on elsewhere", () => {
    const from = lines(40);
    const to = edit(from, 20, ["agent 21", "and more"]);
    // Something else changed the file since, well away from the change.
    const current = edit(edit(from, 35, ["later 36"]), 2, ["later 3", "inserted"]);
    expect(reapply(from, to, current)).toBe(edit(edit(to, 36, ["later 36"]), 2, ["later 3", "inserted"]));
    expect(reapply(from, to, from)).toBe(to);
  });

  it("refuses when a line the change touches, or its context, is no longer as it was", () => {
    const from = lines(40);
    const to = edit(from, 20, ["agent 21"]);
    expect(reapply(from, to, edit(from, 20, ["someone else"]))).toBeNull();
    // Line 19 is context: the change was read against it.
    expect(reapply(from, to, edit(from, 18, ["moved on"]))).toBeNull();
    // A line slipped between two context lines is a change there too.
    expect(reapply(from, to, edit(from, 21, ["line 22", "slipped in"]))).toBeNull();
  });

  it("fills an empty file only while it is still empty", () => {
    expect(reapply("", "a\nb\n", "")).toBe("a\nb\n");
    expect(reapply("", "a\nb\n", "other\n")).toBeNull();
  });
});
