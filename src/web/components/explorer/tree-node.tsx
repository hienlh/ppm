/**
 * TreeNode component — renders a single file/folder row in the explorer tree.
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
import { useFileStore, getVisiblePaths, type FileNode, type InlineAction } from "@/stores/file-store";
import { useTabStore } from "@/stores/tab-store";
import { useCompareStore } from "@/stores/compare-store";
import { useGitStatusStore, GIT_STATUS_COLORS, type GitFileStatus } from "@/stores/git-status-store";
import { api, projectUrl } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { InlineTreeInput } from "./inline-tree-input";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { getFileIcon } from "./file-icon-map";
import { TreeNodeContextMenu } from "./tree-node-context-menu";

/** Check if drag event is from OS files (not internal PPM drag) */
export function isExternalFileDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes("application/x-ppm-path");
}

export interface TreeNodeProps {
  node: FileNode;
  depth: number;
  projectName: string;
  onAction: (action: string, node: FileNode) => void;
  onFileDrop: (targetDir: string, files: FileList) => void;
  onFileOpen?: () => void;
}

export const TreeNode = memo(function TreeNode({ node, depth, projectName, onAction, onFileDrop, onFileOpen }: TreeNodeProps) {
  const { expandedPaths, loadedPaths, inflight, toggleExpand, selectedFiles, toggleFileSelect, inlineAction, clearInlineAction, clipboard, focusedPath, setFocusedPath } = useFileStore(
    useShallow((s) => ({
      expandedPaths: s.expandedPaths,
      loadedPaths: s.loadedPaths,
      inflight: s.inflight,
      toggleExpand: s.toggleExpand,
      selectedFiles: s.selectedFiles,
      toggleFileSelect: s.toggleFileSelect,
      inlineAction: s.inlineAction,
      clearInlineAction: s.clearInlineAction,
      clipboard: s.clipboard,
      focusedPath: s.focusedPath,
      setFocusedPath: s.setFocusedPath,
    })),
  );
  const openTab = useTabStore((s) => s.openTab);
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
  const isCut = clipboard?.operation === "cut" && clipboard.paths.includes(node.path);
  const isFocused = focusedPath === node.path;
  const isLoadingChildren = isDir && isExpanded && !loadedPaths.has(node.path) && inflight.has(node.path);
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
      const toIdx = paths.indexOf(node.path);
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

  /** Accept both external file drops and internal tree moves on directories */
  function canAcceptDrop(e: React.DragEvent): boolean {
    if (!isDir) return false;
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
    if (!isDir) return;
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
    if (!isDir) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);

    // External file upload
    if (isExternalFileDrag(e)) {
      if (e.dataTransfer.files.length > 0) onFileDrop(node.path, e.dataTransfer.files);
      return;
    }

    // Internal tree move
    const sourcePath = e.dataTransfer.getData("application/x-ppm-path").replace(/\/$/, "");
    if (!sourcePath) return;
    // Prevent dropping into self or descendant
    if (sourcePath === node.path || node.path.startsWith(`${sourcePath}/`)) return;
    // Prevent no-op (already in this folder)
    const sourceParent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    if (sourceParent === node.path) return;

    const sourceName = sourcePath.includes("/") ? sourcePath.slice(sourcePath.lastIndexOf("/") + 1) : sourcePath;
    const destination = node.path ? `${node.path}/${sourceName}` : sourceName;
    api.post(`${projectUrl(projectName)}/files/move`, { source: sourcePath, destination })
      .then(() => {
        const store = useFileStore.getState();
        store.invalidateIndex();
        store.loadIndex(projectName);
        store.invalidateFolder(projectName, sourceParent);
        store.invalidateFolder(projectName, node.path);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Move failed");
      });
  }

  const { icon: FileIcon, color: fileIconColor } = isDir
    ? { icon: isExpanded ? FolderOpen : Folder, color: "text-primary" }
    : getFileIcon(node.name);

  // Compact folders: collapse single-child dir chains into "a/b/c" display
  let displayName = node.name;
  let effectiveNode = node;
  if (isDir && isExpanded && node.children) {
    let current = node;
    while (
      current.children &&
      current.children.length === 1 &&
      current.children[0]!.type === "directory" &&
      expandedPaths.has(current.children[0]!.path)
    ) {
      current = current.children[0]!;
      displayName += `/${current.name}`;
    }
    if (current !== node) effectiveNode = current;
  }

  const sortedChildren = effectiveNode.children
    ? [...effectiveNode.children].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
    : [];

  const isRenaming = inlineAction?.type === "rename" && inlineAction.existingNode?.path === node.path;
  const isCreatingHere = isDir && inlineAction != null && (inlineAction.parentPath === node.path || inlineAction.parentPath === effectiveNode.path) && inlineAction.type !== "rename";

  return (
    <div
      onDragEnter={isDir ? handleNodeDragEnter : undefined}
      onDragLeave={isDir ? handleNodeDragLeave : undefined}
      onDragOver={isDir ? handleNodeDragOver : undefined}
      onDrop={isDir ? handleNodeDrop : undefined}
    >
      {isRenaming ? (
        <InlineTreeInput
          defaultValue={node.name}
          placeholder={node.name}
          depth={depth}
          icon={isDir ? "folder" : "file"}
          onConfirm={async (newName) => {
            if (newName === node.name) { clearInlineAction(); return; }
            const parentPath = node.path.includes("/")
              ? node.path.slice(0, node.path.lastIndexOf("/"))
              : "";
            const newPath = parentPath ? `${parentPath}/${newName}` : newName;
            await api.post(`${projectUrl(projectName)}/files/rename`, {
              oldPath: node.path,
              newPath,
            });
            clearInlineAction();
            const store = useFileStore.getState();
            store.invalidateIndex();
            store.loadIndex(projectName);
            store.invalidateFolder(projectName, parentPath);
          }}
          onCancel={clearInlineAction}
        />
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              ref={rowRef}
              draggable
              onDragStart={handleDragStart}
              onClick={handleClick}
              className={cn(
                "flex items-center w-full gap-1.5 px-2 py-1 rounded-sm text-sm",
                "min-h-[32px] hover:bg-surface-elevated transition-colors text-left",
                "select-none",
                (isIgnored || isCut) && "opacity-40",
                isFocused && "bg-surface-elevated",
              isSelected && "bg-primary/15 ring-1 ring-primary/40",
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
              <span className={cn("truncate", gitColor)}>{displayName}</span>
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
      )}

      {isDir && isExpanded && isCreatingHere && (
        <InlineTreeInput
          defaultValue=""
          placeholder={inlineAction!.type === "new-file" ? "filename.ts" : "folder-name"}
          depth={depth + 1}
          icon={inlineAction!.type === "new-file" ? "file" : "folder"}
          onConfirm={async (name) => {
            const type = inlineAction!.type === "new-file" ? "file" : "directory";
            const targetPath = effectiveNode.path || node.path;
            const fullPath = targetPath ? `${targetPath}/${name}` : name;
            await api.post(`${projectUrl(projectName)}/files/create`, { path: fullPath, type });
            clearInlineAction();
            const store = useFileStore.getState();
            store.invalidateIndex();
            store.loadIndex(projectName);
            store.invalidateFolder(projectName, targetPath);
          }}
          onCancel={clearInlineAction}
        />
      )}

      {isDir && isExpanded && sortedChildren.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          projectName={projectName}
          onAction={onAction}
          onFileDrop={onFileDrop}
          onFileOpen={onFileOpen}
        />
      ))}
    </div>
  );
});
