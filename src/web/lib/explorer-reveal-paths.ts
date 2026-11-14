/**
 * The pure half of revealing a path in the project's file tree (`explorer-reveal.ts`): which
 * folders to open, and whether the tree lists the path once they are. Kept apart from the stores
 * so it can be tested without them.
 */

/** Every folder above `path`, outermost first: `a/b/c` → `["a", "a/b"]`. */
export function parentFolders(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** The folders a reveal opens, outermost first: the parents, and a folder itself so its contents show. */
export function foldersToOpen(path: string, kind: "file" | "folder"): string[] {
  return kind === "folder" && path ? [...parentFolders(path), path] : parentFolders(path);
}

interface TreeNodeLike {
  path: string;
  children?: TreeNodeLike[];
}

/**
 * Whether the loaded tree has a row for `path`, walking only down the folders on its way. The
 * project's folder (`""`) is always there. False for a path the tree never lists (`.git`, a
 * folder PPM skips), which the caller reports rather than claiming it was shown.
 */
export function treeHasPath(tree: TreeNodeLike[], path: string): boolean {
  if (!path) return true;
  let level: TreeNodeLike[] | undefined = tree;
  for (const step of [...parentFolders(path), path]) {
    const node: TreeNodeLike | undefined = level?.find((n) => n.path === step);
    if (!node) return false;
    level = node.children;
  }
  return true;
}
