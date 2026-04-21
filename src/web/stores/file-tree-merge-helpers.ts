/**
 * Pure helper functions for immutable lazy-tree merging.
 * Kept separate to stay under the 200-line file size guideline.
 */
import type { FileDirEntry } from "../../types/project";
import type { FileNode } from "./file-store";

/** Convert /files/list entries into sparse FileNode children (no grandchildren). */
export function entriesToNodes(entries: FileDirEntry[], parentPath: string): FileNode[] {
  return entries.map((e) => ({
    name: e.name,
    path: parentPath ? `${parentPath}/${e.name}` : e.name,
    type: e.type,
    ignored: e.isIgnored,
    // children intentionally undefined — loaded lazily on expand
  }));
}

/** Immutable deep-merge of newly loaded children into the sparse tree. */
export function mergeChildren(tree: FileNode[], folderPath: string, children: FileNode[]): FileNode[] {
  if (!folderPath) {
    // Root level: replace root entries, preserve already-loaded sub-children
    return children.map((newNode) => {
      const existing = tree.find((n) => n.path === newNode.path);
      return existing ? { ...newNode, children: existing.children } : newNode;
    });
  }
  return tree.map((node) => mergeNode(node, folderPath, children));
}

function mergeNode(node: FileNode, targetPath: string, children: FileNode[]): FileNode {
  if (node.path === targetPath) {
    // Merge: preserve already-loaded sub-children keyed by path
    const mergedChildren = children.map((newChild) => {
      const existing = node.children?.find((c) => c.path === newChild.path);
      return existing ? { ...newChild, children: existing.children } : newChild;
    });
    return { ...node, children: mergedChildren };
  }
  if (node.children && targetPath.startsWith(node.path + "/")) {
    return { ...node, children: node.children.map((child) => mergeNode(child, targetPath, children)) };
  }
  return node;
}
