/**
 * FileTree — the main file explorer container.
 * Renders toolbar, tree nodes via TreeNode, root-level drag/drop, and file actions.
 */
import { useEffect, useCallback, useState, useRef } from "react";
import {
  FilePlus,
  FolderPlus,
  RefreshCw,
  ChevronsDownUp,
  Crosshair,
  Loader2,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useCompareStore } from "@/stores/compare-store";
import { openCompareTab } from "@/lib/open-compare-tab";
import { toast } from "sonner";
import { cn, basename } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { FileActions } from "./file-actions";
import { TreeNode } from "./tree-node";
import { InlineTreeInput } from "./inline-tree-input";
import { downloadFile, downloadFolder } from "@/lib/file-download";
import { api, projectUrl } from "@/lib/api-client";
import { useFileUploadDrag } from "./use-file-upload-drag";
import { useTreeKeyboardNav } from "./use-tree-keyboard-nav";

/** Synthetic root node for creating files/folders at project root */
const ROOT_NODE: FileNode = { name: "", path: "", type: "directory" };

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

  /** Paste clipboard files into a target directory */
  const pasteFiles = useCallback(async (targetDir: string) => {
    if (!activeProject || !clipboard) return;
    const projectName = activeProject.name;
    const endpoint = clipboard.operation === "cut" ? "move" : "copy";
    for (const source of clipboard.paths) {
      const name = source.includes("/") ? source.slice(source.lastIndexOf("/") + 1) : source;
      const destination = targetDir ? `${targetDir}/${name}` : name;
      try {
        await api.post(`${projectUrl(projectName)}/files/${endpoint}`, { source, destination });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Failed to ${endpoint}`);
      }
    }
    if (clipboard.operation === "cut") setClipboard(null);
    reloadTree();
  }, [activeProject, clipboard, setClipboard, reloadTree]);

  const treeContainerRef = useRef<HTMLDivElement>(null);

  /** Ctrl+X / Ctrl+C / Ctrl+V — scoped to file tree container focus */
  const handleClipboardKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!activeProject) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    if (e.key === "x" && selectedFiles.length > 0) {
      e.preventDefault();
      setClipboard({ paths: [...selectedFiles], operation: "cut" });
    } else if (e.key === "c" && selectedFiles.length > 0) {
      e.preventDefault();
      setClipboard({ paths: [...selectedFiles], operation: "copy" });
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

  // On project switch: reset + load root + load index + auto-expand root
  useEffect(() => {
    if (!activeProject) return;
    reset();
    const name = activeProject.name;
    loadRoot(name).then(() => {
      useFileStore.getState().setExpanded("", true);
    });
    loadIndex(name);
  }, [activeProject?.name]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const {
    uploadFiles, isRootDragOver,
    handleRootDragEnter, handleRootDragLeave, handleRootDragOver, handleRootDrop,
  } = useFileUploadDrag({ projectName: activeProject?.name, setExpanded });

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
    if (action === "cut") {
      const paths = selectedFiles.length > 0 && selectedFiles.includes(node.path) ? [...selectedFiles] : [node.path];
      setClipboard({ paths, operation: "cut" });
      return;
    }
    if (action === "copy-file") {
      const paths = selectedFiles.length > 0 && selectedFiles.includes(node.path) ? [...selectedFiles] : [node.path];
      setClipboard({ paths, operation: "copy" });
      return;
    }
    if (action === "paste" && node.type === "directory") {
      pasteFiles(node.path);
      return;
    }
    if (action === "copy-path") {
      navigator.clipboard.writeText(node.path).catch(() => {});
      return;
    }
    if (action === "copy-full-path") {
      const root = activeProject?.path;
      navigator.clipboard.writeText(root ? `${root}/${node.path}` : node.path).catch(() => {});
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

  const sorted = [...tree].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const toolbarBtnClass = "p-1 rounded-sm text-text-secondary hover:text-foreground hover:bg-surface-elevated transition-colors";

  return (
    <div
      ref={treeContainerRef}
      className={cn("flex flex-col h-full outline-none", isRootDragOver && "bg-primary/5")}
      tabIndex={0}
      onKeyDown={(e) => { handleClipboardKeyDown(e); handleTreeKeyDown(e); }}
      onDragEnter={handleRootDragEnter}
      onDragLeave={handleRootDragLeave}
      onDragOver={handleRootDragOver}
      onDrop={handleRootDrop}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 h-8 border-b border-border shrink-0 sticky top-0 z-10 bg-surface">
        <button onClick={() => handleAction("new-file", ROOT_NODE)} title="New File" className={toolbarBtnClass}>
          <FilePlus className="size-3.5" />
        </button>
        <button onClick={() => handleAction("new-folder", ROOT_NODE)} title="New Folder" className={toolbarBtnClass}>
          <FolderPlus className="size-3.5" />
        </button>
        <div className="flex-1" />
        <button onClick={revealActiveFile} title="Reveal Active File" className={toolbarBtnClass}>
          <Crosshair className="size-3.5" />
        </button>
        <button onClick={collapseAll} title="Collapse All" className={toolbarBtnClass}>
          <ChevronsDownUp className="size-3.5" />
        </button>
        <button onClick={reloadTree} title="Refresh" className={toolbarBtnClass}>
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {/* File tree with blank-area context menu */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ScrollArea className="flex-1">
            <div className="py-1">
              {inlineAction && inlineAction.parentPath === "" && inlineAction.type !== "rename" && (
                <InlineTreeInput
                  defaultValue=""
                  placeholder={inlineAction.type === "new-file" ? "filename.ts" : "folder-name"}
                  depth={0}
                  icon={inlineAction.type === "new-file" ? "file" : "folder"}
                  onConfirm={async (name) => {
                    const type = inlineAction.type === "new-file" ? "file" : "directory";
                    await api.post(`${projectUrl(activeProject!.name)}/files/create`, { path: name, type });
                    clearInlineAction();
                    reloadTree();
                  }}
                  onCancel={clearInlineAction}
                />
              )}
              {sorted.map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  projectName={activeProject.name}
                  onAction={handleAction}
                  onFileDrop={uploadFiles}
                  onFileOpen={onFileOpen}
                />
              ))}
              {sorted.length === 0 && (
                <p className="p-3 text-xs text-text-subtle">Empty project.</p>
              )}
            </div>
          </ScrollArea>
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
          action="delete"
          node={actionState.node}
          projectName={activeProject.name}
          onClose={() => setActionState(null)}
          onRefresh={reloadTree}
        />
      )}
    </div>
  );
}
