import { useEffect, useCallback, useState, useRef, memo } from "react";
import {
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileJson,
  FileText,
  FileType,
  FileImage,
  FileVideo,
  FileAudio,
  FileSpreadsheet,
  FileArchive,
  Database,
  ChevronRight,
  ChevronDown,
  Download,
  Loader2,
  FilePlus,
  FolderPlus,
  RefreshCw,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { cn, basename } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FileActions } from "./file-actions";
import { downloadFile, downloadFolder } from "@/lib/file-download";
import { getAuthToken, projectUrl } from "@/lib/api-client";

/** Check if drag event is from OS files (not internal PPM drag) */
function isExternalFileDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes("application/x-ppm-path");
}

/** Synthetic root node for creating files/folders at project root */
const ROOT_NODE: FileNode = { name: "", path: "", type: "directory" };

type FileIconInfo = { icon: React.ComponentType<{ className?: string }>; color?: string };

const FILE_ICON_MAP: Record<string, FileIconInfo> = {
  // Code
  ts: { icon: FileCode, color: "text-blue-400" }, tsx: { icon: FileCode, color: "text-blue-400" },
  js: { icon: FileCode, color: "text-yellow-400" }, jsx: { icon: FileCode, color: "text-yellow-400" },
  py: { icon: FileCode, color: "text-green-400" }, rs: { icon: FileCode, color: "text-orange-400" },
  go: { icon: FileCode, color: "text-cyan-400" }, c: { icon: FileCode, color: "text-blue-300" },
  cpp: { icon: FileCode, color: "text-blue-300" }, java: { icon: FileCode, color: "text-red-400" },
  rb: { icon: FileCode, color: "text-red-400" }, php: { icon: FileCode, color: "text-purple-400" },
  swift: { icon: FileCode, color: "text-orange-400" }, kt: { icon: FileCode, color: "text-purple-400" },
  dart: { icon: FileCode, color: "text-cyan-400" }, sh: { icon: FileCode, color: "text-green-300" },
  html: { icon: FileCode, color: "text-orange-400" }, css: { icon: FileCode, color: "text-blue-400" },
  scss: { icon: FileCode, color: "text-pink-400" },
  // Data
  json: { icon: FileJson, color: "text-yellow-400" },
  yaml: { icon: FileType, color: "text-orange-300" }, yml: { icon: FileType, color: "text-orange-300" },
  toml: { icon: FileType, color: "text-orange-300" }, ini: { icon: FileType, color: "text-orange-300" },
  env: { icon: FileType, color: "text-yellow-300" },
  csv: { icon: FileSpreadsheet, color: "text-green-400" },
  xls: { icon: FileSpreadsheet, color: "text-green-400" }, xlsx: { icon: FileSpreadsheet, color: "text-green-400" },
  // Text/Docs
  md: { icon: FileText, color: "text-text-secondary" }, txt: { icon: FileText, color: "text-text-secondary" },
  log: { icon: FileText, color: "text-text-subtle" }, pdf: { icon: FileText, color: "text-red-400" },
  // Images
  png: { icon: FileImage, color: "text-green-400" }, jpg: { icon: FileImage, color: "text-green-400" },
  jpeg: { icon: FileImage, color: "text-green-400" }, gif: { icon: FileImage, color: "text-green-400" },
  svg: { icon: FileImage, color: "text-yellow-400" }, webp: { icon: FileImage, color: "text-green-400" },
  ico: { icon: FileImage, color: "text-green-400" }, bmp: { icon: FileImage, color: "text-green-400" },
  // Video
  mp4: { icon: FileVideo, color: "text-purple-400" }, webm: { icon: FileVideo, color: "text-purple-400" },
  mov: { icon: FileVideo, color: "text-purple-400" }, avi: { icon: FileVideo, color: "text-purple-400" },
  mkv: { icon: FileVideo, color: "text-purple-400" },
  // Audio
  mp3: { icon: FileAudio, color: "text-pink-400" }, wav: { icon: FileAudio, color: "text-pink-400" },
  ogg: { icon: FileAudio, color: "text-pink-400" }, flac: { icon: FileAudio, color: "text-pink-400" },
  // Database
  db: { icon: Database, color: "text-amber-400" }, sqlite: { icon: Database, color: "text-amber-400" },
  sqlite3: { icon: Database, color: "text-amber-400" }, sql: { icon: Database, color: "text-amber-400" },
  // Archives
  zip: { icon: FileArchive, color: "text-amber-300" }, tar: { icon: FileArchive, color: "text-amber-300" },
  gz: { icon: FileArchive, color: "text-amber-300" }, rar: { icon: FileArchive, color: "text-amber-300" },
  "7z": { icon: FileArchive, color: "text-amber-300" },
};

const DEFAULT_FILE_ICON: FileIconInfo = { icon: File };

function getFileIcon(name: string): FileIconInfo {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return FILE_ICON_MAP[ext] ?? DEFAULT_FILE_ICON;
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  projectName: string;
  onAction: (action: string, node: FileNode) => void;
  onFileDrop: (targetDir: string, files: FileList) => void;
  onFileOpen?: () => void;
}

const TreeNode = memo(function TreeNode({ node, depth, projectName, onAction, onFileDrop, onFileOpen }: TreeNodeProps) {
  const { expandedPaths, toggleExpand, selectedFiles, toggleFileSelect } = useFileStore(useShallow((s) => ({ expandedPaths: s.expandedPaths, toggleExpand: s.toggleExpand, selectedFiles: s.selectedFiles, toggleFileSelect: s.toggleFileSelect })));
  const openTab = useTabStore((s) => s.openTab);
  const isExpanded = expandedPaths.has(node.path);
  const isDir = node.type === "directory";
  const isSelected = selectedFiles.includes(node.path);
  const isIgnored = node.ignored === true;
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  function handleClick(e: React.MouseEvent) {
    if (isDir) {
      toggleExpand(node.path);
      return;
    }
    // Ctrl/Cmd+Click: toggle file selection for compare
    if (e.metaKey || e.ctrlKey) {
      toggleFileSelect(node.path);
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
    e.dataTransfer.effectAllowed = "copy";
  }

  function handleNodeDragEnter(e: React.DragEvent) {
    if (!isDir || !isExternalFileDrag(e)) return;
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
    if (!isDir || !isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }
  function handleNodeDrop(e: React.DragEvent) {
    if (!isDir || !isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      onFileDrop(node.path, e.dataTransfer.files);
    }
  }

  const { icon: FileIcon, color: fileIconColor } = isDir
    ? { icon: isExpanded ? FolderOpen : Folder, color: "text-primary" }
    : getFileIcon(node.name);

  const sortedChildren = node.children
    ? [...node.children].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
    : [];

  return (
    <div
      onDragEnter={isDir ? handleNodeDragEnter : undefined}
      onDragLeave={isDir ? handleNodeDragLeave : undefined}
      onDragOver={isDir ? handleNodeDragOver : undefined}
      onDrop={isDir ? handleNodeDrop : undefined}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            draggable
            onDragStart={handleDragStart}
            onClick={handleClick}
            className={cn(
              "flex items-center w-full gap-1.5 px-2 py-1 rounded-sm text-sm",
              "min-h-[32px] hover:bg-surface-elevated transition-colors text-left",
              "select-none",
              isIgnored && "opacity-40",
              isSelected && "bg-primary/15 ring-1 ring-primary/40",
              isDragOver && "ring-1 ring-dashed ring-primary bg-primary/10",
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {isDir ? (
              isExpanded ? (
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
            <span className="truncate">{node.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isDir && (
            <>
              <ContextMenuItem onClick={() => onAction("new-file", node)}>
                New File
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onAction("new-folder", node)}>
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={() => onAction("rename", node)}>
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => onAction("delete", node)}
          >
            Delete
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onAction("copy-path", node)}>
            Copy Path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onAction("download", node)}>
            <Download className="size-3.5 mr-2" />
            Download{isDir ? " as Zip" : ""}
          </ContextMenuItem>
          {!isDir && selectedFiles.length === 2 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onAction("compare-selected", node)}>
                Compare Selected
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

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

interface FileTreeProps {
  onFileOpen?: () => void;
}

export function FileTree({ onFileOpen }: FileTreeProps = {}) {
  const { tree, loading, error, fetchTree, reset, selectedFiles, clearSelection, setExpanded } = useFileStore(useShallow((s) => ({ tree: s.tree, loading: s.loading, error: s.error, fetchTree: s.fetchTree, reset: s.reset, selectedFiles: s.selectedFiles, clearSelection: s.clearSelection, setExpanded: s.setExpanded })));
  const activeProject = useProjectStore((s) => s.activeProject);
  const openTab = useTabStore((s) => s.openTab);
  const [actionState, setActionState] = useState<{
    action: string;
    node: FileNode;
  } | null>(null);

  const loadTree = useCallback(() => {
    if (activeProject) {
      fetchTree(activeProject.name);
    }
  }, [activeProject, fetchTree]);

  useEffect(() => {
    if (activeProject) {
      reset();
      loadTree();
    }
  }, [activeProject?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh file tree on window focus and real-time file changes via WebSocket
  useEffect(() => {
    if (!activeProject) return;
    const refresh = () => fetchTree(activeProject.name);
    let debounceTimer: ReturnType<typeof setTimeout>;
    const debouncedRefresh = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(refresh, 300); };
    const handleFileChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectName === activeProject.name) debouncedRefresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("file:changed", handleFileChanged);
    return () => {
      clearTimeout(debounceTimer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("file:changed", handleFileChanged);
    };
  }, [activeProject, fetchTree]);

  const uploadFiles = useCallback(async (targetDir: string, files: FileList) => {
    if (!activeProject) return;
    const form = new FormData();
    form.append("targetDir", targetDir);
    for (const file of files) form.append("files", file);
    const headers: HeadersInit = {};
    const token = getAuthToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      const res = await fetch(`${projectUrl(activeProject.name)}/files/upload`, {
        method: "POST",
        headers,
        body: form,
      });
      if (!res.ok) {
        const json = await res.json();
        console.error("Upload failed:", json.error);
      }
      loadTree();
      if (targetDir) setExpanded(targetDir, true);
    } catch (e) {
      console.error("Upload error:", e);
    }
  }, [activeProject, loadTree, setExpanded]);

  const [isRootDragOver, setIsRootDragOver] = useState(false);
  const rootDragCounter = useRef(0);

  function handleRootDragEnter(e: React.DragEvent) {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    rootDragCounter.current++;
    if (rootDragCounter.current === 1) setIsRootDragOver(true);
  }
  function handleRootDragLeave() {
    rootDragCounter.current--;
    if (rootDragCounter.current === 0) setIsRootDragOver(false);
  }
  function handleRootDragOver(e: React.DragEvent) {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function handleRootDrop(e: React.DragEvent) {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    rootDragCounter.current = 0;
    setIsRootDragOver(false);
    if (e.dataTransfer.files.length > 0) uploadFiles("", e.dataTransfer.files);
  }

  function handleAction(action: string, node: FileNode) {
    if (action === "copy-path") {
      navigator.clipboard.writeText(node.path).catch(() => {});
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
        <button onClick={loadTree} className="block mt-1 text-primary underline">
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
      className={cn("flex flex-col h-full", isRootDragOver && "bg-primary/5")}
      onDragEnter={handleRootDragEnter}
      onDragLeave={handleRootDragLeave}
      onDragOver={handleRootDragOver}
      onDrop={handleRootDrop}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 h-8 border-b border-border shrink-0">
        <button onClick={() => handleAction("new-file", ROOT_NODE)} title="New File" className={toolbarBtnClass}>
          <FilePlus className="size-3.5" />
        </button>
        <button onClick={() => handleAction("new-folder", ROOT_NODE)} title="New Folder" className={toolbarBtnClass}>
          <FolderPlus className="size-3.5" />
        </button>
        <div className="flex-1" />
        <button onClick={loadTree} title="Refresh" className={toolbarBtnClass}>
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {/* File tree with blank-area context menu */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ScrollArea className="flex-1">
            <div className="py-1">
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
          <ContextMenuItem onClick={loadTree}>
            <RefreshCw className="size-3.5 mr-2" />
            Refresh
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {actionState && (
        <FileActions
          action={actionState.action}
          node={actionState.node}
          projectName={activeProject.name}
          onClose={() => setActionState(null)}
          onRefresh={loadTree}
        />
      )}
    </div>
  );
}
