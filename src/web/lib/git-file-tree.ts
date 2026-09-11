/**
 * The shape of the Source Control panel's file tree, as pure functions.
 *
 * Kept out of the panel so it can be tested directly: importing the component
 * pulls in the zustand stores, which read `localStorage` at module scope.
 */
import type { GitFileChange } from "../../types/git";

export interface TreeNode {
  name: string;
  fullPath: string;
  file?: GitFileChange;
  children: TreeNode[];
}

/** Build a tree structure from flat file paths */
export function buildTree(files: GitFileChange[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const f of files) {
    const parts = f.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const fullPath = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;

      let existing = current.find((n) => n.name === part);
      if (!existing) {
        existing = {
          name: part,
          fullPath,
          file: isFile ? f : undefined,
          children: [],
        };
        current.push(existing);
      }
      if (isFile) {
        existing.file = f;
      }
      current = existing.children;
    }
  }

  return root;
}

/**
 * Join a chain of single-child directories into one row, the way VS Code's
 * explorer does.
 *
 * A directory whose only child is another directory adds a row and a level of
 * indent to say nothing: `src` → `services` → `remote-desktop` cost three rows
 * and 36px of the width the filenames needed, to convey one path. Joined, they
 * are `src/services/remote-desktop` on one line.
 *
 * The merged node keeps the *deepest* `fullPath`, because that is what the
 * folder-level stage and discard actions are run against; only `name` is
 * rewritten, and only for display.
 */
export function compactTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    let current = node;
    // Stop at a directory that holds a file: `folder/ > file.ts` stays two rows,
    // because the file row owns its own status, icon and actions.
    while (!current.file && current.children.length === 1 && !current.children[0]!.file) {
      const only = current.children[0]!;
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    return { ...current, children: compactTree(current.children) };
  });
}

/** Collect all file paths under a tree node (recursively) */
export function collectFiles(node: TreeNode): GitFileChange[] {
  const result: GitFileChange[] = [];
  if (node.file) result.push(node.file);
  for (const child of node.children) {
    result.push(...collectFiles(child));
  }
  return result;
}
