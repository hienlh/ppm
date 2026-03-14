import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileJson,
  FileText,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from "../ui/context-menu";
import { useTabStore } from "../../stores/tab.store";
import type { FileEntry } from "../../../types/api";
import { cn } from "../../lib/utils";
import { FileActions } from "./file-actions";

type FileActionType = "new-file" | "new-folder" | "rename" | "delete" | null;

interface FileActionState {
  action: FileActionType;
  targetPath: string;
  targetName?: string;
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return <FileCode className="size-4 shrink-0 text-blue-400" />;
    case "json":
      return <FileJson className="size-4 shrink-0 text-yellow-400" />;
    case "md":
    case "txt":
      return <FileText className="size-4 shrink-0 text-gray-400" />;
    default:
      return <File className="size-4 shrink-0 text-muted-foreground" />;
  }
}

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  projectName: string;
  onAction: (state: FileActionState) => void;
}

function FileTreeNode({ entry, depth, projectName, onAction }: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const { openTab } = useTabStore();

  const handleClick = () => {
    if (entry.type === "directory") {
      setExpanded((v) => !v);
    } else {
      openTab({
        type: "editor",
        title: entry.name,
        metadata: { filePath: entry.path, projectName },
        closable: true,
      });
    }
  };

  const indent = depth * 12;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={handleClick}
            className={cn(
              "flex items-center gap-1.5 w-full text-left py-1 px-2 text-sm hover:bg-muted rounded transition-colors",
            )}
            style={{ paddingLeft: `${indent + 8}px` }}
          >
            {entry.type === "directory" ? (
              <>
                {expanded ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )}
                {expanded ? (
                  <FolderOpen className="size-4 shrink-0 text-yellow-400" />
                ) : (
                  <Folder className="size-4 shrink-0 text-yellow-400" />
                )}
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                {getFileIcon(entry.name)}
              </>
            )}
            <span className="truncate">{entry.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onAction({ action: "new-file", targetPath: entry.path })}>
            New File
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onAction({ action: "new-folder", targetPath: entry.path })}>
            New Folder
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => onAction({ action: "rename", targetPath: entry.path, targetName: entry.name })}
          >
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => onAction({ action: "delete", targetPath: entry.path, targetName: entry.name })}
          >
            Delete
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              navigator.clipboard.writeText(entry.path).catch(console.error);
            }}
          >
            Copy Path
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {entry.type === "directory" && expanded && entry.children && (
        <div>
          {entry.children.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              projectName={projectName}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface FileTreeProps {
  entries: FileEntry[];
  projectName: string;
  onRefresh: () => void;
}

export function FileTree({ entries, projectName, onRefresh }: FileTreeProps) {
  const [actionState, setActionState] = useState<FileActionState>({ action: null, targetPath: "" });

  return (
    <div className="py-1">
      {entries.map((entry) => (
        <FileTreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          projectName={projectName}
          onAction={setActionState}
        />
      ))}
      <FileActions
        action={actionState.action}
        targetPath={actionState.targetPath}
        targetName={actionState.targetName}
        onClose={() => setActionState({ action: null, targetPath: "" })}
        onDone={onRefresh}
      />
    </div>
  );
}
