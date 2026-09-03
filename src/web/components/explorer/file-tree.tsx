/**
 * FileTree — the main file explorer container.
 * Renders toolbar, tree nodes via TreeNode, root-level drag/drop, and file actions.
 */
import { useEffect, useCallback, useState, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  FilePlus,
  FolderPlus,
  FolderOpen,
  RefreshCw,
  ChevronsDownUp,
  Crosshair,
  Loader2,
} from "lucide-react";
import { SidebarHeader } from "@/components/ui/sidebar-header";
import { copyToClipboard } from "@/lib/clipboard";
import { useShallow } from "zustand/react/shallow";
import {
  useFileStore, loadPersistedExpanded, savePersistedExpanded,
  absoluteProjectPath, relativeProjectPath, type FileNode,
} from "@/stores/file-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useCompareStore } from "@/stores/compare-store";
import { openCompareTab } from "@/lib/open-compare-tab";
import { toast } from "sonner";
import { cn, basename } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { FileActions } from "./file-actions";
import { TreeRow } from "./tree-node";
import { InlineTreeInput } from "./inline-tree-input";
import { flattenVisibleTree, type InputRow } from "./flatten-visible-tree";
import { downloadFile, downloadFolder } from "@/lib/file-download";
import { api, projectUrl } from "@/lib/api-client";
import { openExplorer } from "@/components/os-explorer/open-explorer";
import { fsChanged, onFsChanged } from "@/components/os-explorer/explorer-store";
import { dirnameOf } from "@/components/os-explorer/format-file-meta";
import { useDragAutoScroll } from "@/components/os-explorer/dnd/use-drag-auto-scroll";
import { useDropTransfer } from "@/components/os-explorer/dnd/use-drop-transfer";
import { usePathDropTarget } from "@/components/os-explorer/dnd/use-path-drop-target";
import { useFileUploadDrag } from "./use-file-upload-drag";
import { useTreeKeyboardNav } from "./use-tree-keyboard-nav";

/** Synthetic root node for creating files/folders at project root */
const ROOT_NODE: FileNode = { name: "", path: "", type: "directory" };

/** Parent directory of a project-relative path; "" is the project root. */
function parentDirOfRelative(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

interface FileTreeProps {
  onFileOpen?: () => void;
}

export function FileTree({ onFileOpen }: FileTreeProps = {}) {
  const {
    tree, loading, error,
    loadRoot, loadIndex, loadChildren, invalidateIndex, invalidateFolder,
    reset, selectedFiles, clearSelection, setExpanded,
    fetchTree, inlineAction, setInlineAction, clearInlineAction,
    clipboard, setClipboard, collapseAll,
    focusedPath, setFocusedPath, expandedPaths, toggleExpand,
  } = useFileStore(
    useShallow((s) => ({
      tree: s.tree,
      loading: s.loading,
      error: s.error,
      loadRoot: s.loadRoot,
      loadIndex: s.loadIndex,
      loadChildren: s.loadChildren,
      invalidateIndex: s.invalidateIndex,
      invalidateFolder: s.invalidateFolder,
      reset: s.reset,
      selectedFiles: s.selectedFiles,
      clearSelection: s.clearSelection,
      setExpanded: s.setExpanded,
      fetchTree: s.fetchTree,
      inlineAction: s.inlineAction,
      setInlineAction: s.setInlineAction,
      clearInlineAction: s.clearInlineAction,
      clipboard: s.clipboard,
      setClipboard: s.setClipboard,
      collapseAll: s.collapseAll,
      focusedPath: s.focusedPath,
      setFocusedPath: s.setFocusedPath,
      expandedPaths: s.expandedPaths,
      toggleExpand: s.toggleExpand,
    })),
  );
  const activeProject = useProjectStore((s) => s.activeProject);
  const openTab = useTabStore((s) => s.openTab);
  const [actionState, setActionState] = useState<{
    action: string;
    node: FileNode;
  } | null>(null);

  const reloadTree = useCallback(() => {
    if (!activeProject) return;
    reset();
    loadRoot(activeProject.name);
    loadIndex(activeProject.name);
  }, [activeProject, reset, loadRoot, loadIndex]);

  /** Reveal (scroll to + highlight) the file that's open in the active tab */
  const revealActiveFile = useCallback(async () => {
    if (!activeProject) return;
    const { tabs, activeTabId } = useTabStore.getState();
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const filePath = activeTab?.metadata?.filePath as string | undefined;
    if (!filePath) return;

    // Expand all parent folders
    const parts = filePath.split("/");
    const projectName = activeProject.name;
    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join("/");
      setExpanded(parentPath, true);
      // Ensure children are loaded
      await loadChildren(projectName, parentPath);
    }
    setFocusedPath(filePath);
  }, [activeProject, setExpanded, loadChildren, setFocusedPath]);

  /**
   * Paste clipboard entries into a target directory.
   *
   * The clipboard holds absolute paths and may have been filled by an explorer window, so
   * the source decides the route: entries that live inside this project keep the
   * project-scoped endpoints (relative paths, gitignore-aware), anything else goes through
   * the host filesystem API with a fully-composed destination.
   */
  const pasteFiles = useCallback(async (targetDir: string) => {
    if (!activeProject || !clipboard) return;
    const projectName = activeProject.name;
    const root = activeProject.path;
    // Every source path is an absolute host path (the clipboard is shared with explorer
    // windows), so the host separator implied by the project root also splits them correctly.
    const sep = root.includes("\\") ? "\\" : "/";
    const endpoint = clipboard.operation === "cut" ? "move" : "copy";
    const touched = new Set<string>([absoluteProjectPath(root, targetDir)]);
    for (const source of clipboard.paths) {
      const name = source.split(/[/\\]/).filter(Boolean).pop() ?? source;
      const relativeSource = relativeProjectPath(root, source);
      touched.add(dirnameOf(source, sep));
      try {
        if (relativeSource != null) {
          const destination = targetDir ? `${targetDir}/${name}` : name;
          await api.post(`${projectUrl(projectName)}/files/${endpoint}`, { source: relativeSource, destination });
        } else {
          const destination = absoluteProjectPath(root, targetDir ? `${targetDir}/${name}` : name);
          await api.post(`/api/fs/${endpoint}`, { source, destination });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Failed to ${endpoint}`);
      }
    }
    if (clipboard.operation === "cut") setClipboard(null);
    // Any explorer window showing the source or destination directory must refresh too.
    fsChanged(...touched);
    reloadTree();
  }, [activeProject, clipboard, setClipboard, reloadTree]);

  const treeContainerRef = useRef<HTMLDivElement>(null);

  /** Absolutise before publishing: the clipboard is shared with the explorer windows. */
  const copyToTreeClipboard = useCallback((relativePaths: string[], operation: "cut" | "copy") => {
    if (!activeProject) return;
    const root = activeProject.path;
    setClipboard({
      paths: relativePaths.map((p) => absoluteProjectPath(root, p)),
      operation,
      origin: { projectName: activeProject.name, root },
    });
  }, [activeProject, setClipboard]);

  /** Ctrl+X / Ctrl+C / Ctrl+V — scoped to file tree container focus */
  const handleClipboardKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!activeProject) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    if ((e.key === "x" || e.key === "c") && selectedFiles.length > 0) {
      e.preventDefault();
      copyToTreeClipboard(selectedFiles, e.key === "x" ? "cut" : "copy");
    } else if (e.key === "v" && clipboard) {
      e.preventDefault();
      pasteFiles("");
    }
  }, [activeProject, selectedFiles, clipboard, setClipboard, pasteFiles]);

  const { handleTreeKeyDown } = useTreeKeyboardNav({
    tree,
    expandedPaths,
    focusedPath,
    setFocusedPath,
    setExpanded,
    toggleExpand,
    projectName: activeProject?.name,
    onAction: handleAction,
  });

  // On project switch: reset + restore expanded state + load all visible folders in ONE batch
  useEffect(() => {
    if (!activeProject) return;
    reset();
    const name = activeProject.name;
    const persisted = loadPersistedExpanded(name);
    useFileStore.setState({ expandedPaths: new Set(["", ...persisted]) });
    if (persisted.length > 0) {
      useFileStore.getState().loadPathsBatch(name, ["", ...persisted]);
    } else {
      loadRoot(name);
    }
    loadIndex(name);
  }, [activeProject?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist expanded state per project. Reads LIVE store state (not the captured
  // render value): on project switch the captured set still belongs to the previous
  // project, while live state was already reset+restored by the mount effect above.
  useEffect(() => {
    if (!activeProject) return;
    savePersistedExpanded(activeProject.name, useFileStore.getState().expandedPaths);
  }, [expandedPaths, activeProject?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle WS file:changed → invalidate folder + index
  useEffect(() => {
    if (!activeProject) return;
    const projectName = activeProject.name;
    let debounceTimer: ReturnType<typeof setTimeout>;

    const handleFileChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectName !== projectName) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const store = useFileStore.getState();
        const changedPath: string = detail.path ?? "";
        const parentPath = changedPath.includes("/")
          ? changedPath.slice(0, changedPath.lastIndexOf("/"))
          : "";
        store.invalidateIndex();
        store.loadIndex(projectName);
        store.invalidateFolder(projectName, parentPath);
      }, 300);
    };

    window.addEventListener("file:changed", handleFileChanged);
    return () => {
      clearTimeout(debounceTimer);
      window.removeEventListener("file:changed", handleFileChanged);
    };
  }, [activeProject]);

  // Symmetric with the fsChanged(...) calls this file emits after its own mutations: an
  // explorer window mutating a directory inside this project must invalidate the matching
  // tree node too.
  useEffect(() => {
    if (!activeProject) return;
    const projectName = activeProject.name;
    const root = activeProject.path;
    return onFsChanged((absoluteDir) => {
      const relative = relativeProjectPath(root, absoluteDir);
      if (relative == null) return; // outside this project — not the tree's concern
      const store = useFileStore.getState();
      store.invalidateIndex();
      store.loadIndex(projectName);
      store.invalidateFolder(projectName, relative);
    });
  }, [activeProject]);

  const {
    uploadFiles, isRootDragOver,
    handleRootDragEnter, handleRootDragLeave, handleRootDragOver, handleRootDrop,
  } = useFileUploadDrag({ projectName: activeProject?.name, setExpanded });

  // Cross-surface entry drops (from an explorer window, or another project's tree) onto the
  // tree's own empty background — the project root. Uses the same collision-prompt transfer
  // as a paste; separate from `useFileUploadDrag` above, which only ever reacts to OS files.
  const treeRootSep = activeProject?.path.includes("\\") ? "\\" : "/";
  const { run: transferRun, prompts: transferPrompts } = useDropTransfer(treeRootSep);
  const backgroundDrop = usePathDropTarget({
    targetDir: activeProject?.path ?? null,
    run: transferRun,
    disabled: !activeProject,
  });

  // Virtualized flat rows: only visible rows are mounted (large dirs stay cheap)
  const rows = useMemo(
    () => flattenVisibleTree(tree, expandedPaths, inlineAction),
    [tree, expandedPaths, inlineAction],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  useDragAutoScroll(scrollRef);
  const isMobile = useIsMobile();
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (isMobile ? 32 : 26),
    overscan: 10,
    paddingStart: 4,
    paddingEnd: 4,
  });

  // Keep focused row in view even when it's not mounted (offscreen)
  useEffect(() => {
    if (focusedPath == null) return;
    const idx = rows.findIndex(
      (r) => r.kind === "node" && (r.node.path === focusedPath || r.effectiveNode.path === focusedPath),
    );
    if (idx >= 0) rowVirtualizer.scrollToIndex(idx, { align: "auto" });
  }, [focusedPath]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Confirm inline create/rename input rows */
  const handleInlineConfirm = useCallback(async (row: InputRow, value: string) => {
    const projectName = activeProject!.name;
    const store = useFileStore.getState();
    if (row.inline.type === "rename") {
      const node = row.inline.existingNode!;
      if (value === node.name) { clearInlineAction(); return; }
      const parentPath = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
      const newPath = parentPath ? `${parentPath}/${value}` : value;
      await api.post(`${projectUrl(projectName)}/files/rename`, { oldPath: node.path, newPath });
      clearInlineAction();
      store.invalidateIndex();
      store.loadIndex(projectName);
      store.invalidateFolder(projectName, parentPath);
      fsChanged(absoluteProjectPath(activeProject!.path, parentPath));
    } else {
      const type = row.inline.type === "new-file" ? "file" : "directory";
      const fullPath = row.targetPath ? `${row.targetPath}/${value}` : value;
      await api.post(`${projectUrl(projectName)}/files/create`, { path: fullPath, type });
      clearInlineAction();
      store.invalidateIndex();
      store.loadIndex(projectName);
      store.invalidateFolder(projectName, row.targetPath);
      fsChanged(absoluteProjectPath(activeProject!.path, row.targetPath));
    }
  }, [activeProject, clearInlineAction]);

  async function handleAction(action: string, node: FileNode) {
    if (action === "toggle-expand" && node.type === "directory") {
      toggleExpand(activeProject!.name, node.path);
      return;
    }
    if (action === "open-file" && node.type === "file") {
      const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
      const isSqlite = ext === "db" || ext === "sqlite" || ext === "sqlite3";
      openTab({
        type: isSqlite ? "sqlite" : "editor",
        title: node.name,
        metadata: { filePath: node.path, projectName: activeProject!.name },
        projectId: activeProject!.name,
        closable: true,
      });
      onFileOpen?.();
      return;
    }
    if (action === "cut" || action === "copy-file") {
      const paths = selectedFiles.length > 0 && selectedFiles.includes(node.path) ? [...selectedFiles] : [node.path];
      copyToTreeClipboard(paths, action === "cut" ? "cut" : "copy");
      return;
    }
    if (action === "open-in-file-explorer") {
      const target = node.type === "directory" ? node.path : parentDirOfRelative(node.path);
      void openExplorer(absoluteProjectPath(activeProject!.path, target));
      return;
    }
    if (action === "paste" && node.type === "directory") {
      pasteFiles(node.path);
      return;
    }
    if (action === "copy-path") {
      void copyToClipboard(node.path);
      return;
    }
    if (action === "copy-full-path") {
      const root = activeProject?.path;
      void copyToClipboard(root ? `${root}/${node.path}` : node.path);
      return;
    }
    if (action === "select-for-compare") {
      useCompareStore.getState().setSelection({
        filePath: node.path,
        projectName: activeProject!.name,
        label: node.name,
      });
      return;
    }
    if (action === "compare-with-selected") {
      const sel = useCompareStore.getState().selection;
      if (!sel) return;
      try {
        await openCompareTab(
          { path: sel.filePath, dirtyContent: sel.dirtyContent },
          { path: node.path },
          activeProject!.name,
        );
        useCompareStore.getState().clearSelection();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Compare failed";
        toast.error(msg);
      }
      return;
    }
    if (action === "download") {
      if (node.type === "directory") {
        downloadFolder(activeProject!.name, node.path);
      } else {
        downloadFile(activeProject!.name, node.path);
      }
      return;
    }
    if (action === "compare-selected" && selectedFiles.length === 2) {
      const file1 = selectedFiles[0]!;
      const file2 = selectedFiles[1]!;
      const name1 = basename(file1);
      const name2 = basename(file2);
      openTab({
        type: "git-diff",
        title: `Compare ${name1} vs ${name2}`,
        closable: true,
        metadata: {
          projectName: activeProject!.name,
          file1,
          file2,
        },
        projectId: activeProject!.name,
      });
      clearSelection();
      return;
    }
    if (action === "new-file" || action === "new-folder") {
      const parentPath = node.type === "directory" ? node.path : "";
      if (parentPath) setExpanded(parentPath, true);
      setInlineAction({ type: action as "new-file" | "new-folder", parentPath });
      return;
    }
    if (action === "rename") {
      const parentPath = node.path.includes("/")
        ? node.path.slice(0, node.path.lastIndexOf("/"))
        : "";
      setInlineAction({ type: "rename", parentPath, existingNode: node });
      return;
    }
    setActionState({ action, node });
  }

  if (!activeProject) {
    return (
      <div className="p-3 text-xs text-text-subtle">
        Select a project to browse files.
      </div>
    );
  }

  if (loading && tree.length === 0) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-text-secondary">
        <Loader2 className="size-3 animate-spin" />
        Loading files...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 text-xs text-error">
        {error}
        <button onClick={reloadTree} className="block mt-1 text-primary underline">
          Retry
        </button>
      </div>
    );
  }

  const toolbarBtnClass = "flex size-6 items-center justify-center rounded text-text-subtle hover:bg-surface-elevated hover:text-foreground";

  return (
    <div
      ref={treeContainerRef}
      className={cn("flex flex-col h-full outline-none", (isRootDragOver || backgroundDrop.isOver) && "bg-primary/5")}
      tabIndex={0}
      onKeyDown={(e) => { handleClipboardKeyDown(e); handleTreeKeyDown(e); }}
      // Two independent drags share this background: OS files (handleRoot*, unchanged) and
      // a cross-surface entry drag (backgroundDrop, gated on its own MIME) — each ignores
      // the other's kind, so calling both in sequence is safe.
      onDragEnter={(e) => { handleRootDragEnter(e); backgroundDrop.handlers.onDragEnter(e); }}
      onDragLeave={(e) => { handleRootDragLeave(e); backgroundDrop.handlers.onDragLeave(e); }}
      onDragOver={(e) => { handleRootDragOver(e); backgroundDrop.handlers.onDragOver(e); }}
      onDrop={(e) => { handleRootDrop(e); backgroundDrop.handlers.onDrop(e); }}
    >
      <SidebarHeader icon={FolderOpen} title="Explorer">
        <button onClick={() => handleAction("new-file", ROOT_NODE)} title="New File" className={toolbarBtnClass}>
          <FilePlus className="size-3.5" />
        </button>
        <button onClick={() => handleAction("new-folder", ROOT_NODE)} title="New Folder" className={toolbarBtnClass}>
          <FolderPlus className="size-3.5" />
        </button>
        <button onClick={revealActiveFile} title="Reveal Active File" className={toolbarBtnClass}>
          <Crosshair className="size-3.5" />
        </button>
        <button onClick={collapseAll} title="Collapse All" className={toolbarBtnClass}>
          <ChevronsDownUp className="size-3.5" />
        </button>
        <button onClick={reloadTree} title="Refresh" className={toolbarBtnClass}>
          <RefreshCw className="size-3.5" />
        </button>
      </SidebarHeader>

      {/* File tree with blank-area context menu — virtualized flat rows */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const row = rows[vi.index]!;
                return (
                  <div
                    key={row.kind === "node" ? row.node.path : `input:${row.targetPath}:${row.inline.type}`}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${vi.start}px)` }}
                  >
                    {row.kind === "input" ? (
                      <InlineTreeInput
                        defaultValue={row.inline.type === "rename" ? row.inline.existingNode!.name : ""}
                        placeholder={
                          row.inline.type === "rename" ? row.inline.existingNode!.name
                          : row.inline.type === "new-file" ? "filename.ts" : "folder-name"
                        }
                        depth={row.depth}
                        icon={
                          row.inline.type === "rename"
                            ? (row.inline.existingNode!.type === "directory" ? "folder" : "file")
                            : (row.inline.type === "new-file" ? "file" : "folder")
                        }
                        onConfirm={(value) => handleInlineConfirm(row, value)}
                        onCancel={clearInlineAction}
                      />
                    ) : (
                      <TreeRow
                        row={row}
                        projectName={activeProject.name}
                        onAction={handleAction}
                        onFileDrop={uploadFiles}
                        onFileOpen={onFileOpen}
                        transferRun={transferRun}
                      />
                    )}
                  </div>
                );
              })}
              {rows.length === 0 && (
                <p className="p-3 text-xs text-text-subtle">Empty project.</p>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => handleAction("new-file", ROOT_NODE)}>
            <FilePlus className="size-3.5 mr-2" />
            New File
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleAction("new-folder", ROOT_NODE)}>
            <FolderPlus className="size-3.5 mr-2" />
            New Folder
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={reloadTree}>
            <RefreshCw className="size-3.5 mr-2" />
            Refresh
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {actionState?.action === "delete" && (
        <FileActions
          node={actionState.node}
          projectName={activeProject.name}
          onClose={() => setActionState(null)}
          onRefresh={() => {
            fsChanged(absoluteProjectPath(activeProject.path, parentDirOfRelative(actionState.node.path)));
            reloadTree();
          }}
        />
      )}
      {transferPrompts}
    </div>
  );
}
