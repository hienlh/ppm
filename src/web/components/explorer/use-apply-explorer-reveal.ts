import { useEffect } from "react";
import { useFileStore } from "@/stores/file-store";
import { foldersToOpen, treeHasPath } from "@/lib/explorer-reveal-paths";
import { useExplorerReveal } from "./explorer-reveal";

/**
 * The file tree's half of a reveal (`explorer-reveal.ts`): once the tree shows the project the
 * reveal names and its root has loaded, open the folders on the way, then focus and select the
 * row, which scrolls it into view. Called after the tree's own project-switch effect, whose reset
 * would otherwise wipe what this opens.
 */
export function useApplyExplorerReveal(projectName: string | undefined): void {
  const pending = useExplorerReveal((s) => s.pending);
  const rootLoaded = useFileStore((s) => s.loadedPaths.has(""));
  useEffect(() => {
    // Read live, not from the render: on a project switch this render still carries the previous
    // project's loaded root, and the tree's own effect has just reset it.
    if (!pending || !projectName || pending.projectName !== projectName || !rootLoaded) return;
    if (!useFileStore.getState().loadedPaths.has("")) return;
    let cancelled = false;
    const { id, path, kind } = pending;
    void (async () => {
      try {
        for (const folder of foldersToOpen(path, kind)) {
          useFileStore.getState().setExpanded(folder, true);
          await useFileStore.getState().loadChildren(projectName, folder);
          if (cancelled) return;
        }
        const store = useFileStore.getState();
        if (!treeHasPath(store.tree, path)) {
          useExplorerReveal.getState().finish({ id, ok: false, error: `The Explorer does not list ${path}: PPM's file tree leaves it out.` });
          return;
        }
        // Focusing the row that already has focus changes nothing, so nothing would scroll to it:
        // clear it for one render first (two sets in one task would be batched into none).
        if (path && store.focusedPath === path) {
          store.setFocusedPath(null);
          await new Promise((r) => setTimeout(r, 0));
          if (cancelled) {
            // Give the row its focus back unless something else took focus meanwhile.
            if (useFileStore.getState().focusedPath == null) useFileStore.getState().setFocusedPath(path);
            return;
          }
        }
        useFileStore.getState().setFocusedPath(path || null);
        useFileStore.getState().setSelectedFiles(path ? [path] : []);
        useExplorerReveal.getState().finish({ id, ok: true });
      } catch (e) {
        if (!cancelled) useExplorerReveal.getState().finish({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [pending, projectName, rootLoaded]);
}
