/**
 * Single source of truth for the explorer's visible-row computation.
 * Flattens the lazy tree into ordered rows respecting expand state,
 * dir-first sorting, compact single-child folder chains, and inline
 * create/rename input rows. Consumed by the virtualized renderer,
 * keyboard navigation, and range selection.
 */
import type { FileNode, InlineAction } from "@/stores/file-store";

export interface NodeRow {
  kind: "node";
  /** Original node (row identity, drag source, context menu target) */
  node: FileNode;
  /** Terminal node of a compacted single-child dir chain (equals node when not compacted) */
  effectiveNode: FileNode;
  /** Display label, e.g. "a/b/c" for compacted chains */
  displayName: string;
  depth: number;
}

export interface InputRow {
  kind: "input";
  inline: InlineAction;
  depth: number;
  /** Directory the created entry lands in (effective path for compacted chains) */
  targetPath: string;
}

export type FlatRow = NodeRow | InputRow;

function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Follow expanded single-child dir chains; returns terminal node + joined label */
function compactChain(node: FileNode, expandedPaths: Set<string>): { effective: FileNode; displayName: string } {
  let effective = node;
  let displayName = node.name;
  if (node.type === "directory" && expandedPaths.has(node.path) && node.children) {
    while (
      effective.children &&
      effective.children.length === 1 &&
      effective.children[0]!.type === "directory" &&
      expandedPaths.has(effective.children[0]!.path)
    ) {
      effective = effective.children[0]!;
      displayName += `/${effective.name}`;
    }
  }
  return { effective, displayName };
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
      const { effective, displayName } = compactChain(n, expandedPaths);

      if (renamePath != null && renamePath === n.path) {
        rows.push({ kind: "input", inline: inlineAction!, depth, targetPath: n.path });
      } else {
        rows.push({ kind: "node", node: n, effectiveNode: effective, displayName, depth });
      }

      const expanded = effective.type === "directory" && expandedPaths.has(effective.path);
      // Create input pinned under its parent dir, before children
      if (
        isCreate && expanded &&
        (inlineAction!.parentPath === n.path || inlineAction!.parentPath === effective.path)
      ) {
        rows.push({ kind: "input", inline: inlineAction!, depth: depth + 1, targetPath: effective.path });
      }
      if (expanded && effective.children) {
        walk(effective.children, depth + 1);
      }
    }
  }
  walk(tree, 0);
  return rows;
}

/** Flat visible effective-node list (keyboard nav, range selection) */
export function visibleNodesOf(tree: FileNode[], expandedPaths: Set<string>): FileNode[] {
  return flattenVisibleTree(tree, expandedPaths)
    .filter((r): r is NodeRow => r.kind === "node")
    .map((r) => r.effectiveNode);
}
