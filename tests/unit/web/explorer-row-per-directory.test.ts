/**
 * Every directory in the explorer gets its own row.
 *
 * The tree used to join a single-child chain into one `a/b/c` row — VS Code's
 * compact folders — but the join required *both* paths to already be in
 * `expandedPaths`, so it fired one gesture too late: expanding a folder made
 * the row the user had just clicked disappear upward into its parent, and every
 * row below it shifted a level left. VS Code compacts on the way *in* (you
 * never see the intermediate row at all), which is a coherent design; half of
 * it is just a row that vanishes when you touch it.
 *
 * `depth` is the load-bearing part, because it is what the renderer turns into
 * `paddingLeft` — a compacted chain indented its children by the number of rows
 * above them rather than by their real place in the hierarchy, so indentation
 * stopped being readable as nesting.
 */
import { describe, it, expect } from "bun:test";
import {
  flattenVisibleTree,
  rowKey,
  visibleNodesOf,
  type NodeRow,
} from "../../../src/web/components/explorer/flatten-visible-tree.ts";
import type { FileNode } from "../../../src/web/stores/file-store.ts";

/** `.claude/agent-memory/tester/notes.md` — one child all the way down. */
const chain: FileNode[] = [
  {
    name: ".claude",
    path: ".claude",
    type: "directory",
    children: [
      {
        name: "agent-memory",
        path: ".claude/agent-memory",
        type: "directory",
        children: [
          {
            name: "tester",
            path: ".claude/agent-memory/tester",
            type: "directory",
            children: [
              { name: "notes.md", path: ".claude/agent-memory/tester/notes.md", type: "file" },
            ],
          },
        ],
      },
    ],
  },
];

const allExpanded = new Set([".claude", ".claude/agent-memory", ".claude/agent-memory/tester"]);

const nodeRows = (rows: ReturnType<typeof flattenVisibleTree>) =>
  rows.filter((r): r is NodeRow => r.kind === "node");

describe("a single-child chain, fully expanded", () => {
  it("is four rows, not one joined row plus its leaf", () => {
    const rows = nodeRows(flattenVisibleTree(chain, allExpanded));
    expect(rows.map((r) => r.node.name)).toEqual([
      ".claude",
      "agent-memory",
      "tester",
      "notes.md",
    ]);
  });

  it("indents each row by its real depth", () => {
    const rows = nodeRows(flattenVisibleTree(chain, allExpanded));
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3]);
  });

  it("labels a row with its own name, never a joined path", () => {
    for (const r of nodeRows(flattenVisibleTree(chain, allExpanded))) {
      expect(r.node.name, "a row's label is a path segment").not.toContain("/");
    }
  });

  it("adds exactly one row per expand, so the row clicked stays put", () => {
    // The reported symptom, as a sequence: each click reveals a child and
    // leaves everything already on screen where it was.
    let expanded = new Set<string>();
    const names = () => nodeRows(flattenVisibleTree(chain, expanded)).map((r) => r.node.name);
    expect(names()).toEqual([".claude"]);
    expanded = new Set([".claude"]);
    expect(names()).toEqual([".claude", "agent-memory"]);
    expanded = new Set([".claude", ".claude/agent-memory"]);
    expect(names()).toEqual([".claude", "agent-memory", "tester"]);
  });
});

describe("what the rest of the explorer reads off those rows", () => {
  it("keys a row by its own path", () => {
    // React's `key` and the virtualizer's `getItemKey` are the same string, and
    // a stale key is what drew rows on top of each other.
    const rows = nodeRows(flattenVisibleTree(chain, allExpanded));
    expect(rows.map(rowKey)).toEqual([
      ".claude",
      ".claude/agent-memory",
      ".claude/agent-memory/tester",
      ".claude/agent-memory/tester/notes.md",
    ]);
  });

  it("gives keyboard nav and range selection every directory to stop on", () => {
    expect(visibleNodesOf(chain, allExpanded).map((n) => n.path)).toEqual([
      ".claude",
      ".claude/agent-memory",
      ".claude/agent-memory/tester",
      ".claude/agent-memory/tester/notes.md",
    ]);
  });

  it("puts a create input under the directory it was opened on", () => {
    // The compacted version targeted the chain's *terminal* node — right for a
    // row labelled `a/b/c`, and wrong now that each directory has its own row.
    const rows = flattenVisibleTree(chain, allExpanded, {
      type: "file",
      parentPath: ".claude/agent-memory",
    });
    const input = rows.find((r) => r.kind === "input");
    expect(input).toBeDefined();
    expect(input!.kind === "input" && input!.targetPath).toBe(".claude/agent-memory");
    // Directly beneath its own row, one level in.
    expect(rows.indexOf(input!)).toBe(2);
    expect(input!.depth).toBe(2);
  });
});
