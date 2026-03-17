import { useEffect, useCallback, useState } from "react";
import {
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileJson,
  FileText,
  FileType,
  ChevronRight,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FileActions } from "./file-actions";

const FILE_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  py: FileCode,
  rs: FileCode,
  go: FileCode,
  json: FileJson,
  md: FileText,
  txt: FileText,
  yaml: FileType,
  yml: FileType,
  html: FileCode,
  css: FileCode,
  scss: FileCode,
};

function getFileIcon(name: string): React.ComponentType<{ className?: string }> {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return FILE_ICON_MAP[ext] ?? File;
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  projectName: string;
  onAction: (action: string, node: FileNode) => void;
  onFileOpen?: () => void;
}

function TreeNode({ node, depth, projectName, onAction, onFileOpen }: TreeNodeProps) {
  const { expandedPaths, toggleExpand, selectedFiles, toggleFileSelect } = useFileStore();
  const openTab = useTabStore((s) => s.openTab);
  const isExpanded = expandedPaths.has(node.path);
  const isDir = node.type === "directory";
  const isSelected = selectedFiles.includes(node.path);

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
    openTab({
      type: "editor",
      title: node.name,
      metadata: { filePath: node.path, projectName },
      projectId: projectName,
      closable: true,
    });
    onFileOpen?.();
  }

  const Icon = isDir
    ? isExpanded
      ? FolderOpen
      : Folder
    : getFileIcon(node.name);

  const sortedChildren = node.children
    ? [...node.children].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
    : [];

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={handleClick}
            className={cn(
              "flex items-center w-full gap-1.5 px-2 py-1 rounded-sm text-sm",
              "min-h-[32px] hover:bg-surface-elevated transition-colors text-left",
              "select-none",
              isSelected && "bg-primary/15 ring-1 ring-primary/40",
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
            <Icon
              className={cn(
                "size-4 shrink-0",
                isDir ? "text-primary" : "text-text-secondary",
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
          onFileOpen={onFileOpen}
        />
      ))}
    </div>
  );
}

interface FileTreeProps {
  onFileOpen?: () => void;
}

export function FileTree({ onFileOpen }: FileTreeProps = {}) {
  const { tree, loading, error, fetchTree, reset, selectedFiles, clearSelection } = useFileStore();
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

  // Auto-refresh file tree when window regains focus
  useEffect(() => {
    const handleFocus = () => { if (activeProject) fetchTree(activeProject.name); };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [activeProject, fetchTree]);

  function handleAction(action: string, node: FileNode) {
    if (action === "copy-path") {
      navigator.clipboard.writeText(node.path).catch(() => {});
      return;
    }
    if (action === "compare-selected" && selectedFiles.length === 2) {
      const file1 = selectedFiles[0]!;
      const file2 = selectedFiles[1]!;
      const name1 = file1.split("/").pop() ?? file1;
      const name2 = file2.split("/").pop() ?? file2;
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

  return (
    <>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {sorted.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              projectName={activeProject.name}
              onAction={handleAction}
              onFileOpen={onFileOpen}
            />
          ))}
          {sorted.length === 0 && (
            <p className="p-3 text-xs text-text-subtle">Empty project.</p>
          )}
        </div>
      </ScrollArea>

      {actionState && (
        <FileActions
          action={actionState.action}
          node={actionState.node}
          projectName={activeProject.name}
          onClose={() => setActionState(null)}
          onRefresh={loadTree}
        />
      )}
    </>
  );
}
