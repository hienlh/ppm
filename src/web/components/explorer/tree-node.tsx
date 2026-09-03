/**
 * TreeRow component — renders a single file/folder row in the virtualized explorer tree.
 * Rows are flat siblings (no recursion); visible order comes from flatten-visible-tree.ts.
 * Handles click, drag/drop, context menu for individual tree items.
 */
import { useRef, useEffect, memo } from "react";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useFileStore, getVisiblePaths, absoluteProjectPath, type FileNode } from "@/stores/file-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useCompareStore } from "@/stores/compare-store";
import { useGitStatusStore, GIT_STATUS_COLORS, type GitFileStatus } from "@/stores/git-status-store";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { DROP_TARGET_CLASS } from "@/components/os-explorer/dnd/drop-target-style";
import type { DropRunner } from "@/components/os-explorer/dnd/entry-drop-executor";
import { getFileIcon } from "./file-icon-map";
import { TreeNodeContextMenu } from "./tree-node-context-menu";
import { useTreeRowDnd } from "./use-tree-row-dnd";
import type { NodeRow } from "./flatten-visible-tree";

export interface TreeRowProps {
  row: NodeRow;
  projectName: string;
  onAction: (action: string, node: FileNode) => void;
  onFileDrop: (targetDir: string, files: FileList) => void;
  onFileOpen?: () => void;
  /** Runs a cross-surface entry drop (from an explorer window, another project's tree, or
   *  this same tree) through the shared collision-prompt transfer — see `use-drop-transfer`. */
  transferRun: DropRunner;
}

export const TreeRow = memo(function TreeRow({ row, projectName, onAction, onFileDrop, onFileOpen, transferRun }: TreeRowProps) {
  const { node, effectiveNode, displayName, depth } = row;
  const { expandedPaths, loadedPaths, inflight, toggleExpand, selectedFiles, toggleFileSelect, clipboard, focusedPath, setFocusedPath } = useFileStore(
    useShallow((s) => ({
      expandedPaths: s.expandedPaths,
      loadedPaths: s.loadedPaths,
      inflight: s.inflight,
      toggleExpand: s.toggleExpand,
      selectedFiles: s.selectedFiles,
      toggleFileSelect: s.toggleFileSelect,
      clipboard: s.clipboard,
      focusedPath: s.focusedPath,
      setFocusedPath: s.setFocusedPath,
    })),
  );
  const openTab = useTabStore((s) => s.openTab);
  const projectRoot = useProjectStore((s) => s.activeProject?.path);
  const compareSelection = useCompareStore((s) => s.selection);
  const isDir = node.type === "directory";
  // Git decoration: per-file and per-folder status
  const gitStatus: GitFileStatus | undefined = useGitStatusStore((s) => {
    const map = isDir ? s.folderStatuses.get(projectName) : s.fileStatuses.get(projectName);
    return map?.get(node.path) as GitFileStatus | undefined;
  });
  const gitColor = gitStatus ? GIT_STATUS_COLORS[gitStatus] : undefined;
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedFiles.includes(node.path);
  const isIgnored = node.ignored === true;
  // The clipboard is shared with the explorer windows and therefore absolute; compare in
  // that space so a tree cut still greys its own row out.
  const isCut =
    clipboard?.operation === "cut" &&
    projectRoot != null &&
    clipboard.paths.includes(absoluteProjectPath(projectRoot, node.path));
  const isFocused = focusedPath === node.path || focusedPath === effectiveNode.path;
  const isLoadingChildren = isDir && isExpanded && !loadedPaths.has(effectiveNode.path) && inflight.has(effectiveNode.path);
  const rowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isFocused && rowRef.current) {
      rowRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [isFocused]);

  function handleClick(e: React.MouseEvent) {
    // Ctrl+Click: toggle selection
    if (e.metaKey || e.ctrlKey) {
      setFocusedPath(node.path);
      toggleFileSelect(node.path);
      return;
    }
    // Shift+Click: range selection
    if (e.shiftKey && focusedPath != null) {
      const paths = getVisiblePaths();
      const fromIdx = paths.indexOf(focusedPath);
      const toIdx = paths.indexOf(effectiveNode.path);
      if (fromIdx >= 0 && toIdx >= 0) {
        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        useFileStore.getState().setSelectedFiles(paths.slice(start, end + 1));
      }
      return;
    }
    // Normal click
    setFocusedPath(node.path);
    useFileStore.getState().clearSelection();
    if (isDir) {
      toggleExpand(projectName, node.path);
      return;
    }
    const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
    const isSqlite = ext === "db" || ext === "sqlite" || ext === "sqlite3";
    openTab({
      type: isSqlite ? "sqlite" : "editor",
      title: node.name,
      metadata: { filePath: node.path, projectName },
      projectId: projectName,
      closable: true,
    });
    onFileOpen?.();
  }

  const dnd = useTreeRowDnd({
    path: node.path,
    name: node.name,
    isDir,
    effectivePath: effectiveNode.path,
    isSelected,
    selectedFiles,
    isExpanded,
    projectName,
    projectRoot,
    toggleExpand,
    onFileDrop,
    transferRun,
  });

  const { icon: FileIcon, color: fileIconColor } = isDir
    ? { icon: isExpanded ? FolderOpen : Folder, color: isExpanded ? "text-primary" : "text-text-3" }
    : getFileIcon(node.name);

  return (
    <div {...dnd.containerHandlers}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            ref={rowRef}
            {...dnd.entrySource}
            onClick={handleClick}
            className={cn(
              "flex items-center w-full gap-1.5 px-2 py-1 rounded-[var(--rad-sm)] text-[13px]",
              "min-h-[32px] md:min-h-[26px] hover:bg-surface-elevated transition-colors text-left",
              "select-none",
              (isIgnored || isCut) && "opacity-40",
              isFocused && "bg-surface-elevated",
              isSelected && "bg-accent-wash",
              dnd.isDragOver && DROP_TARGET_CLASS,
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {isDir ? (
              isLoadingChildren ? (
                <Loader2 className="size-3.5 shrink-0 text-text-subtle animate-spin" />
              ) : isExpanded ? (
                <ChevronDown className="size-3.5 shrink-0 text-text-subtle" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-text-subtle" />
              )
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <FileIcon
              className={cn(
                "size-4 shrink-0",
                fileIconColor ?? "text-text-secondary",
              )}
            />
            <span
              className={cn(
                "truncate",
                gitColor ?? (isSelected ? "text-text" : isDir && isExpanded ? "text-text font-medium" : "text-text-2"),
              )}
            >
              {displayName}
            </span>
            {gitStatus && !isDir && (
              <span className={cn("text-[10px] ml-auto shrink-0 font-mono", gitColor)}>
                {gitStatus}
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <TreeNodeContextMenu
          node={node}
          isDir={isDir}
          projectName={projectName}
          selectedFiles={selectedFiles}
          compareSelection={compareSelection}
          clipboard={clipboard}
          onAction={onAction}
        />
      </ContextMenu>
    </div>
  );
});
