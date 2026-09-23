import { useCallback } from "react";
import { useTabStore } from "@/stores/tab-store";
import { useFileStore, absoluteProjectPath, relativeProjectPath, type FileNode } from "@/stores/file-store";
import { useProjectStore } from "@/stores/project-store";
import { useBackgroundOutputStore } from "@/stores/background-output-store";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { formatSourceLocation, type SourceLine } from "@/lib/source-location";
import { openExplorer } from "@/components/os-explorer/open-explorer";
import { fsApi } from "@/lib/fs-api";
import { basename } from "@/lib/utils";

function findInTree(nodes: FileNode[], name: string): string[] {
  return nodes.flatMap((node) => [
    ...(node.name === name ? [node.path] : []),
    ...findInTree(node.children ?? [], name),
  ]);
}

/** Resolve against the host/project, never against the browser's OS or URL. */
export function useMarkdownFileNavigation(projectName?: string) {
  const openTab = useTabStore((s) => s.openTab);
  const updateTab = useTabStore((s) => s.updateTab);
  return useCallback(async (filePath: string, line?: SourceLine) => {
    if (!filePath) return;
    // Hand the line to the palette too, so picking a candidate there still lands on it.
    const search = () => openCommandPalette(formatSourceLocation(filePath, line));
    if (/\.output$/.test(filePath)) {
      const store = useBackgroundOutputStore.getState();
      const shell = store.findByOutput(filePath);
      if (shell) { store.openPanel(shell.shellId); return; }
    }

    const root = useProjectStore.getState().projects.find((p) => p.name === projectName)?.path;
    const absolute = /^(\/|[a-z]:[/\\]|~(?:[/\\]|$))/i.test(filePath);
    const candidate = absolute ? filePath : root ? absoluteProjectPath(root, filePath) : null;
    if (!candidate) { search(); return; }

    const openPath = async (path: string) => {
      let entry = await fsApi.stat(path);
      // Follow links through the guarded API, with a bound for cycles/broken links.
      for (let depth = 0; entry.kind === "symlink" && entry.target && depth < 8; depth++) {
        const target = entry.target;
        const parent = entry.path.slice(0, entry.path.length - entry.name.length);
        entry = await fsApi.stat(/^(\/|[a-z]:[/\\])/i.test(target) ? target : absoluteProjectPath(parent, target));
      }
      if (entry.kind === "directory") { await openExplorer(entry.path); return; }
      if (entry.kind !== "file") { search(); return; }
      // Keep project-relative identity so Explorer tabs dedupe and editor LSP stays enabled.
      const relative = root ? relativeProjectPath(root, entry.path) : null;
      const metadata: Record<string, unknown> = { filePath: relative ?? entry.path };
      if (projectName) metadata.projectName = projectName;
      if (line) Object.assign(metadata, { lineNumber: line.start, endLine: line.end, revealAt: Date.now() });
      const id = openTab({ type: "editor", title: entry.name, metadata, projectId: relative !== null ? projectName ?? null : null, closable: true });
      if (line && id) updateTab(id, { metadata });
    };

    try {
      await openPath(candidate);
    } catch {
      // Only bare names may use basename search. An explicit missing path must not
      // silently open an unrelated same-named file elsewhere in the project.
      if (!absolute && !/[/\\]/.test(filePath) && root) {
        const matches = findInTree(useFileStore.getState().tree, basename(filePath));
        if (matches.length === 1) {
          try { await openPath(absoluteProjectPath(root, matches[0]!)); return; } catch { /* search below */ }
        }
      }
      search();
    }
  }, [projectName, openTab, updateTab]);
}
