/**
 * TreeRow component — renders a single file/folder row in the virtualized explorer tree.
 * Rows are flat siblings (no recursion); visible order comes from flatten-visible-tree.ts.
 * Handles click, drag/drop, context menu for individual tree items.
 */
import { useRef, useEffect, memo } from "react";
import {
  ChevronRight,
  ChevronDown,
  Loader2,
} from "@/lib/icons";
import { useShallow } from "zustand/react/shallow";
import { useFileStore, getVisiblePaths, absoluteProjectPath, type FileNode } from "@/stores/file-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useGitStatusStore, GIT_STATUS_COLORS, type GitFileStatus } from "@/stores/git-status-store";
import { cn } from "@/lib/utils";
import { DROP_TARGET_CLASS } from "@/components/os-explorer/dnd/drop-target-style";
import type { DropRunner } from "@/components/os-explorer/dnd/entry-drop-executor";
import { FileIcon } from "@/lib/file-icons";
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
  const { node, depth } = row;
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
  const isFocused = focusedPath === node.path;
  const isLoadingChildren = isDir && isExpanded && !loadedPaths.has(node.path) && inflight.has(node.path);
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

  const dnd = useTreeRowDnd({
    path: node.path,
    name: node.name,
    isDir,
    isSelected,
    selectedFiles,
    isExpanded,
    projectName,
    projectRoot,
    toggleExpand,
    onFileDrop,
    transferRun,
  });

  return (
    <div {...dnd.containerHandlers}>
      <button
        ref={rowRef}
        {...dnd.entrySource}
        onClick={handleClick}
        className={cn(
          // `leading-[18px]` is what makes the row exactly as tall as the
          // virtualizer's `estimateSize` says it is. Without it the 13px text
          // inherits line-height 1.5 — a 19.5px line box, so the row measured
          // 27.5px against an estimate of 26, and every row scrolling into
          // view corrected the total size underneath the scrollbar.
          "flex items-center w-full gap-1.5 px-2 py-1 rounded-[var(--rad-sm)] text-[13px] leading-[18px]",
          "min-h-[32px] md:min-h-[26px] hover:bg-surface-elevated transition-colors text-left",
          "select-none",
          // A gitignored row is dimmed by `text-text-dim` on its label, not by
          // fading the whole row: an alpha blend is not symmetric between light
          // and dark, and at 40% a gitignored name measured 1.72–1.89:1 against
          // the panel on the three light themes (2.07–2.23:1 on the dark ones) —
          // under a 3:1 floor either way, and on light past the point where it
          // can be read at all. The icon keeps its colours for the same reason:
          // it is full-colour artwork with no `currentColor`, so an opacity on it
          // is that same fade to the background. `cut` is a momentary state and
          // stays a fade.
          isCut && "opacity-40",
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
          name={node.name}
          kind={isDir ? "directory" : "file"}
          open={isExpanded}
        />
        <span
          className={cn(
            "truncate",
            gitColor ??
              (isSelected
                ? "text-text"
                : isIgnored
                  ? "text-text-dim"
                  : isDir && isExpanded
                    ? "text-text font-medium"
                    : "text-text-2"),
          )}
        >
          {node.name}
        </span>
        {gitStatus && !isDir && (
          <span className={cn("text-[10px] ml-auto shrink-0 font-mono", gitColor)}>
            {gitStatus}
          </span>
        )}
  </button>
    </div>
  );
});
