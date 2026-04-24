/**
 * Hook for file tree keyboard navigation.
 * Arrow keys, Enter, F2, Delete on focused tree items.
 */
import { useMemo, type KeyboardEvent } from "react";
import { useFileStore, type FileNode } from "@/stores/file-store";

interface UseTreeKeyboardNavOptions {
  tree: FileNode[];
  expandedPaths: Set<string>;
  focusedPath: string | null;
  setFocusedPath: (path: string | null) => void;
  setExpanded: (path: string, expanded: boolean) => void;
  toggleExpand: (projectName: string, path: string) => void;
  projectName: string | undefined;
  onAction: (action: string, node: FileNode) => void;
}

export function useTreeKeyboardNav({
  tree,
  expandedPaths,
  focusedPath,
  setFocusedPath,
  setExpanded,
  toggleExpand,
  projectName,
  onAction,
}: UseTreeKeyboardNavOptions) {
  /** Flat list of visible nodes (respects expand state and compact folders) */
  const visibleNodes = useMemo(() => {
    const result: FileNode[] = [];
    function walk(nodes: FileNode[]) {
      const sorted = [...nodes].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const n of sorted) {
        // Skip compacted intermediate dirs (single-child chains rendered as one row)
        let effective = n;
        if (n.type === "directory" && expandedPaths.has(n.path) && n.children) {
          while (
            effective.children &&
            effective.children.length === 1 &&
            effective.children[0]!.type === "directory" &&
            expandedPaths.has(effective.children[0]!.path)
          ) {
            effective = effective.children[0]!;
          }
        }
        result.push(effective);
        if (effective.type === "directory" && expandedPaths.has(effective.path) && effective.children) {
          walk(effective.children);
        }
      }
    }
    walk(tree);
    return result;
  }, [tree, expandedPaths]);

  const focusedNode = useMemo(
    () => visibleNodes.find((n) => n.path === focusedPath) ?? null,
    [visibleNodes, focusedPath],
  );

  function handleTreeKeyDown(e: KeyboardEvent) {
    if (!projectName) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

    const idx = focusedPath != null ? visibleNodes.findIndex((n) => n.path === focusedPath) : -1;

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = idx < visibleNodes.length - 1 ? idx + 1 : 0;
        setFocusedPath(visibleNodes[next]!.path);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = idx > 0 ? idx - 1 : visibleNodes.length - 1;
        setFocusedPath(visibleNodes[prev]!.path);
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        if (focusedNode?.type === "directory" && !expandedPaths.has(focusedNode.path)) {
          toggleExpand(projectName, focusedNode.path);
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (focusedNode?.type === "directory" && expandedPaths.has(focusedNode.path)) {
          setExpanded(focusedNode.path, false);
        } else if (focusedNode) {
          const parentPath = focusedNode.path.includes("/")
            ? focusedNode.path.slice(0, focusedNode.path.lastIndexOf("/"))
            : "";
          if (parentPath || parentPath === "") {
            const parent = visibleNodes.find((n) => n.path === parentPath);
            if (parent) setFocusedPath(parent.path);
          }
        }
        break;
      }
      case "Enter": {
        e.preventDefault();
        if (focusedNode) onAction(focusedNode.type === "directory" ? "toggle-expand" : "open-file", focusedNode);
        break;
      }
      case "F2": {
        e.preventDefault();
        if (focusedNode) onAction("rename", focusedNode);
        break;
      }
      case "Delete": {
        e.preventDefault();
        if (focusedNode) onAction("delete", focusedNode);
        break;
      }
    }
  }

  return { visibleNodes, focusedNode, handleTreeKeyDown };
}
