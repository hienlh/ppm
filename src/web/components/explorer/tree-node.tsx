/**
 * TreeRow component — renders a single file/folder row in the virtualized explorer tree.
 * Rows are flat siblings (no recursion); visible order comes from flatten-visible-tree.ts.
 * Handles click, drag/drop, context menu for individual tree items.
 */
import { useState, useRef, useEffect, memo } from "react";
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
import { api, projectUrl } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { getFileIcon } from "./file-icon-map";
import { TreeNodeContextMenu } from "./tree-node-context-menu";
import type { NodeRow } from "./flatten-visible-tree";

/** Check if drag event is from OS files (not internal PPM drag) */
export function isExternalFileDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes("application/x-ppm-path");
}

function parentDirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export interface TreeRowProps {
  row: NodeRow;
  projectName: string;
  onAction: (action: string, node: FileNode) => void;
  onFileDrop: (targetDir: string, files: FileList) => void;
  onFileOpen?: () => void;
}

export const TreeRow = memo(function TreeRow({ row, projectName, onAction, onFileDrop, onFileOpen }: TreeRowProps) {
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
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);
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

  function handleDragStart(e: React.DragEvent) {
    const pathValue = isDir ? `${node.path}/` : node.path;
    e.dataTransfer.setData("application/x-ppm-path", pathValue);
    e.dataTransfer.setData("text/plain", node.name);
    e.dataTransfer.effectAllowed = "copyMove";
  }

  // Flat rows: dropping on a file targets its parent directory
  const dropTargetDir = isDir ? effectiveNode.path : parentDirOf(node.path);

  function canAcceptDrop(e: React.DragEvent): boolean {
    return isExternalFileDrag(e) || e.dataTransfer.types.includes("application/x-ppm-path");
  }

  function handleNodeDragEnter(e: React.DragEvent) {
    if (!canAcceptDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (dragCounter.current === 1) setIsDragOver(true);
  }
  function handleNodeDragLeave(e: React.DragEvent) {
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  }
  function handleNodeDragOver(e: React.DragEvent) {
    if (!canAcceptDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isExternalFileDrag(e) ? "copy" : "move";
  }
  function handleNodeDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);

    // External file upload
    if (isExternalFileDrag(e)) {
      if (e.dataTransfer.files.length > 0) onFileDrop(dropTargetDir, e.dataTransfer.files);
      return;
    }

    // Internal tree move
    const sourcePath = e.dataTransfer.getData("application/x-ppm-path").replace(/\/$/, "");
    if (!sourcePath) return;
    // Prevent dropping into self or descendant
    if (sourcePath === dropTargetDir || dropTargetDir.startsWith(`${sourcePath}/`)) return;
    // Prevent no-op (already in this folder)
    const sourceParent = parentDirOf(sourcePath);
    if (sourceParent === dropTargetDir) return;

    const sourceName = sourcePath.includes("/") ? sourcePath.slice(sourcePath.lastIndexOf("/") + 1) : sourcePath;
    const destination = dropTargetDir ? `${dropTargetDir}/${sourceName}` : sourceName;
    api.post(`${projectUrl(projectName)}/files/move`, { source: sourcePath, destination })
      .then(() => {
        const store = useFileStore.getState();
        store.invalidateIndex();
        store.loadIndex(projectName);
        store.invalidateFolder(projectName, sourceParent);
        store.invalidateFolder(projectName, dropTargetDir);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Move failed");
      });
  }

  const { icon: FileIcon, color: fileIconColor } = isDir
    ? { icon: isExpanded ? FolderOpen : Folder, color: isExpanded ? "text-primary" : "text-text-3" }
    : getFileIcon(node.name);

  return (
    <div
      onDragEnter={handleNodeDragEnter}
      onDragLeave={handleNodeDragLeave}
      onDragOver={handleNodeDragOver}
      onDrop={handleNodeDrop}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            ref={rowRef}
            draggable
            onDragStart={handleDragStart}
            onClick={handleClick}
            className={cn(
              "flex items-center w-full gap-1.5 px-2 py-1 rounded-[var(--rad-sm)] text-[13px]",
              "min-h-[32px] md:min-h-[26px] hover:bg-surface-elevated transition-colors text-left",
              "select-none",
              (isIgnored || isCut) && "opacity-40",
              isFocused && "bg-surface-elevated",
              isSelected && "bg-accent-wash",
              isDragOver && "ring-1 ring-dashed ring-primary bg-primary/10",
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
