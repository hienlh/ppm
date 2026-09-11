/**
 * Single source of truth for the explorer's visible-row computation.
 * Flattens the lazy tree into ordered rows respecting expand state,
 * dir-first sorting, and inline create/rename input rows. Consumed by the
 * virtualized renderer, keyboard navigation, and range selection.
 *
 * Every directory gets its own row. Single-child chains used to be joined into
 * one `a/b/c` row (VS Code's compact folders) — but only *after* the child was
 * expanded, because the join required both paths to be in `expandedPaths`. So
 * the gesture that should have revealed a folder instead made the row you just
 * clicked vanish into its parent, and depth stopped matching the hierarchy.
 * Expanding is expanding: one row per directory, always.
 */
import type { FileNode, InlineAction } from "@/stores/file-store";

export interface NodeRow {
  kind: "node";
  /** Row identity, drag source, context menu target */
  node: FileNode;
  depth: number;
}

export interface InputRow {
  kind: "input";
  inline: InlineAction;
  depth: number;
  /** Directory the created entry lands in */
  targetPath: string;
}

export type FlatRow = NodeRow | InputRow;

/**
 * A row's identity, independent of where it currently sits in the list.
 *
 * This is React's `key` *and* the virtualizer's `getItemKey`, and the two have
 * to be the same string. The virtualizer caches the DOM node it positions under
 * its own key, and it only learns of a node through the `measureElement` ref —
 * which React does not call again when a row merely changes index. So with the
 * default key (the index), expanding a folder left every row below it registered
 * under the index it used to have: the inserted rows overwrote those entries and
 * the shifted ones were positioned by nothing at all, landing on top of each
 * other at their old offsets.
 */
export function rowKey(row: FlatRow): string {
  return row.kind === "node" ? row.node.path : `input:${row.targetPath}:${row.inline.type}`;
}

function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function flattenVisibleTree(
  tree: FileNode[],
  expandedPaths: Set<string>,
  inlineAction: InlineAction | null = null,
): FlatRow[] {
  const rows: FlatRow[] = [];
  const isCreate = inlineAction != null && inlineAction.type !== "rename";
  const renamePath = inlineAction?.type === "rename" ? inlineAction.existingNode?.path : undefined;

  // Root-level create input appears before all rows
  if (isCreate && inlineAction!.parentPath === "") {
    rows.push({ kind: "input", inline: inlineAction!, depth: 0, targetPath: "" });
  }

  function walk(nodes: FileNode[], depth: number) {
    for (const n of sortNodes(nodes)) {
      if (renamePath != null && renamePath === n.path) {
        rows.push({ kind: "input", inline: inlineAction!, depth, targetPath: n.path });
      } else {
        rows.push({ kind: "node", node: n, depth });
      }

      const expanded = n.type === "directory" && expandedPaths.has(n.path);
      // Create input pinned under its parent dir, before children
      if (isCreate && expanded && inlineAction!.parentPath === n.path) {
        rows.push({ kind: "input", inline: inlineAction!, depth: depth + 1, targetPath: n.path });
      }
      if (expanded && n.children) {
        walk(n.children, depth + 1);
      }
    }
  }
  walk(tree, 0);
  return rows;
}

/** Flat visible node list (keyboard nav, range selection) */
export function visibleNodesOf(tree: FileNode[], expandedPaths: Set<string>): FileNode[] {
  return flattenVisibleTree(tree, expandedPaths)
    .filter((r): r is NodeRow => r.kind === "node")
    .map((r) => r.node);
}
