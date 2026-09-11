/**
 * The Source Control tree, after the pass that made it legible.
 *
 * Three things were wrong at once and they compounded. The tree never joined a
 * chain of single-child directories, so `src` → `services` → `remote-desktop`
 * spent three rows and 36px of indent to convey one path. The rails were drawn
 * as a hand-positioned elbow per row — a file's branch at `top: 50%`, a
 * folder's at a fixed `top: 13`, against rows of two different heights — so the
 * pieces never met. And the filenames were right-truncated, which for
 * `remote-desktop-capture-input.ts`, `remote-desktop-capture.ts` and eleven
 * siblings meant a column of rows that all read the same: the panel could not
 * tell you which file it was showing.
 *
 * `compactTree` is tested as a function because its invariant is not visual:
 * the joined row must keep the *deepest* `fullPath`, since that is what the
 * folder-level stage and discard run against. Getting that wrong would stage
 * the wrong subtree while looking perfectly right.
 *
 * The tree helpers live in `src/web/lib/git-file-tree.ts` rather than in the
 * panel so this file can call them: importing the component reaches the zustand
 * stores, which read `localStorage` at module scope and throw under bun:test.
 *
 * The rest is checked on the source, because the interesting part is which
 * technique is used and a wrong one renders without error. Verified in a
 * browser against the repository's real 38 changed paths at 300px and 240px:
 * every row distinguishable, no gap before any ellipsis, rails continuous.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildTree, compactTree, type TreeNode } from "../../../src/web/lib/git-file-tree";
import type { GitFileChange } from "../../../src/types/git";

const src = readFileSync(
  resolve(import.meta.dir, "../../../src/web/components/git/git-status-panel.tsx"),
  "utf8",
);

const change = (path: string): GitFileChange =>
  ({ path, status: "M" }) as unknown as GitFileChange;

/** The tree the panel actually renders, from a list of paths. */
const treeOf = (paths: string[]) => compactTree(buildTree(paths.map(change)));

/**
 * The source of one component, so an assertion cannot be satisfied by a
 * different row that happens to use the same technique.
 */
function region(from: string, to?: string): string {
  const i = src.indexOf(from);
  if (i < 0) throw new Error(`no ${from} in the panel`);
  if (to === undefined) return src.slice(i); // last declaration in the file
  const j = src.indexOf(to, i + 1);
  if (j <= i) throw new Error(`no ${to} after ${from}`);
  return src.slice(i, j);
}

/** Every row a tree renders, as `name` at its depth. */
function rows(nodes: TreeNode[], depth = 0): { name: string; depth: number }[] {
  return nodes.flatMap((n) => [{ name: n.name, depth }, ...rows(n.children, depth + 1)]);
}

describe("a chain of single-child directories is one row", () => {
  it("joins the names and keeps the deepest path for the folder actions", () => {
    const [node] = treeOf(["src/services/remote-desktop/x11.ts"]);
    expect(node!.name).toBe("src/services/remote-desktop");
    // Not `src`. Staging this row must stage the remote-desktop directory.
    expect(node!.fullPath).toBe("src/services/remote-desktop");
  });

  it("stops at the directory that holds the file, so the file keeps its own row", () => {
    const [node] = treeOf(["src/services/remote-desktop/x11.ts"]);
    expect(node!.children).toHaveLength(1);
    expect(node!.children[0]!.name).toBe("x11.ts");
    expect(node!.children[0]!.file).toBeDefined();
  });

  it("leaves a directory that branches alone", () => {
    // `src` has two children here, so joining it would be wrong: there is no
    // single path to fold into its name.
    const tree = treeOf(["src/a/one.ts", "src/b/two.ts"]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe("src");
    expect(rows(tree).map((r) => r.name)).toEqual(["src", "a", "one.ts", "b", "two.ts"]);
  });

  it("joins deeper down as well, not only at the root", () => {
    const tree = treeOf(["src/a/one.ts", "src/b/c/d/two.ts"]);
    expect(rows(tree).map((r) => `${"  ".repeat(r.depth)}${r.name}`)).toEqual([
      "src",
      "  a",
      "    one.ts",
      "  b/c/d",
      "    two.ts",
    ]);
  });

  it("saves rows and indent on the case that prompted it", () => {
    const paths = [
      "src/services/remote-desktop/capture.ts",
      "src/services/remote-desktop/x11.ts",
    ];
    const before = rows(buildTree(paths.map(change)));
    const after = rows(treeOf(paths));
    expect(before).toHaveLength(5); // src, services, remote-desktop, + 2 files
    expect(after).toHaveLength(3); // src/services/remote-desktop, + 2 files
    // And the files sit one level in rather than three.
    expect(Math.max(...before.map((r) => r.depth))).toBe(3);
    expect(Math.max(...after.map((r) => r.depth))).toBe(1);
  });

  it("does not fold a file into a directory name", () => {
    // A directory with one *file* child stays two rows: the file row carries the
    // status letter, the icon and the stage/discard actions.
    const tree = treeOf(["src/only.ts"]);
    expect(tree[0]!.name).toBe("src");
    expect(tree[0]!.file).toBeUndefined();
  });
});

describe("names ellipsize from the start", () => {
  // Both rows, checked separately: the two are written out independently, so a
  // file-wide match is satisfied by whichever one still has it.
  for (const [label, body] of [
    ["the filename", region("function StartEllipsis", "export function GitStatusPanel")],
    ["the folder path", region("function TreeNodeView")],
  ] as const) {
    it(`${label} uses a right-to-left box with an isolate, not a plain truncate`, () => {
      // `dir="rtl"` puts the ellipsis on the left; `<bdi>` keeps the name reading
      // left to right, which is what stops `.gitignore` rendering as `gitignore.`.
      expect(body).toMatch(/dir="rtl"/);
      expect(body).toContain("<bdi>");
      expect(body).toMatch(/truncate/);
    });
  }

  it("does not reintroduce a split name pinned beside an ellipsized head", () => {
    // That was the first attempt: flex gives the head a fractional width while
    // the ellipsis lands on a whole character, so a ragged gap opened in the
    // middle of every truncated name.
    expect(src).not.toMatch(/splitFileName/);
  });

  it("renders the filename at body size rather than as metadata", () => {
    // design-guidelines.md rule 6: text-xs is for labels, not for the thing the
    // row is about. The status letter stays small and monospaced on purpose.
    const fileRow = src.slice(src.indexOf("function FileRow"), src.indexOf("function TreeView"));
    expect(fileRow).toMatch(/text-sm/);
    expect(fileRow).not.toMatch(/text-xs font-mono truncate/);
  });
});

describe("the rails are drawn by the container, not per row", () => {
  it("has no hand-positioned elbows left", () => {
    // A horizontal branch per row is what could not line up: two row heights,
    // two hardcoded offsets.
    expect(src).not.toMatch(/border-dashed/);
    expect(src).not.toMatch(/railX/);
    expect(src).not.toMatch(/connectorCls/);
  });

  it("draws one continuous guide per level, positioned from the shared constants", () => {
    expect(src).toMatch(/const TREE_INDENT = \d+/);
    expect(src).toMatch(/const TREE_GUIDE_X = \d+/);
    // Spans the whole children container, so it cannot drift from the rows.
    expect(src).toMatch(/absolute top-0 bottom-0 w-px/);
    expect(src).toMatch(/left: depth \* TREE_INDENT \+ TREE_GUIDE_X/);
  });

  it("indents every row from the same constant", () => {
    // Two different multipliers is how the guide and the rows disagreed before.
    expect(src).not.toMatch(/depth \* 12/);
    expect(src.match(/depth \* TREE_INDENT/g) ?? []).not.toHaveLength(0);
  });
});

describe("a row is thumb-sized on a touch screen", () => {
  it("is 44px tall below md and compact where there is a pointer", () => {
    // design-guidelines.md rule 3. `py-px` — what the file row had — is 18px.
    const matches = src.match(/py-2\.5 md:py-1\b/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // the file row and the folder row
    expect(src).not.toMatch(/rounded pl-1 py-px/);
  });
});
