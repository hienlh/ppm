import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Plus,
  Minus,
  RefreshCw,
  ArrowUpFromLine,
  ArrowDownToLine,
  Loader2,
  Undo2,
  List,
  FolderTree,
  ChevronRight,
  ChevronDown,
  FileText,
} from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GitStatus, GitFileChange } from "../../../types/git";

interface GitStatusPanelProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

type ViewMode = "flat" | "tree";

const STATUS_COLORS: Record<string, string> = {
  M: "text-yellow-500",
  A: "text-green-500",
  D: "text-red-500",
  R: "text-blue-500",
  C: "text-purple-500",
  "?": "text-gray-400",
};

/** Build a tree structure from flat file paths */
interface TreeNode {
  name: string;
  fullPath: string;
  file?: GitFileChange;
  children: TreeNode[];
}

function buildTree(files: GitFileChange[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const f of files) {
    const parts = f.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const fullPath = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;

      let existing = current.find((n) => n.name === part);
      if (!existing) {
        existing = {
          name: part,
          fullPath,
          file: isFile ? f : undefined,
          children: [],
        };
        current.push(existing);
      }
      if (isFile) {
        existing.file = f;
      }
      current = existing.children;
    }
  }

  return root;
}

/** Collect all file paths under a tree node (recursively) */
function collectFiles(node: TreeNode): GitFileChange[] {
  const result: GitFileChange[] = [];
  if (node.file) result.push(node.file);
  for (const child of node.children) {
    result.push(...collectFiles(child));
  }
  return result;
}

export function GitStatusPanel({ metadata, tabId }: GitStatusPanelProps) {
  const projectName = metadata?.projectName as string | undefined;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [acting, setActing] = useState(false);
  const [revertTarget, setRevertTarget] = useState<{
    label: string;
    files: string[];
  } | null>(null);
  const { openTab, updateTab } = useTabStore();

  // Restore viewMode from tab metadata
  const viewMode: ViewMode =
    (metadata?.viewMode as ViewMode) === "tree" ? "tree" : "flat";

  const setViewMode = (mode: ViewMode) => {
    if (tabId) {
      updateTab(tabId, { metadata: { ...metadata, viewMode: mode } });
    }
  };

  const fetchStatus = useCallback(async () => {
    if (!projectName) return;
    try {
      setLoading(true);
      const data = await api.get<GitStatus>(
        `${projectUrl(projectName)}/git/status`,
      );
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch status");
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    fetchStatus();
    // Auto-reload every 5 seconds
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const stageFiles = async (files: string[]) => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/stage`, { files });
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stage failed");
    } finally {
      setActing(false);
    }
  };

  const unstageFiles = async (files: string[]) => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/unstage`, { files });
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unstage failed");
    } finally {
      setActing(false);
    }
  };

  const discardChanges = async (files: string[]) => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/discard`, { files });
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discard failed");
    } finally {
      setActing(false);
    }
  };

  const handleConfirmRevert = async () => {
    if (!revertTarget) return;
    await discardChanges(revertTarget.files);
    setRevertTarget(null);
  };

  const handleCommit = async () => {
    if (!projectName || !commitMsg.trim() || !status?.staged.length) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/commit`, {
        message: commitMsg.trim(),
      });
      setCommitMsg("");
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setActing(false);
    }
  };

  const handlePush = async () => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/push`, {});
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Push failed");
    } finally {
      setActing(false);
    }
  };

  const handlePull = async () => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(`${projectUrl(projectName)}/git/pull`, {});
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setActing(false);
    }
  };

  const openDiff = (file: GitFileChange) => {
    openTab({
      type: "git-diff",
      title: file.path.split("/").pop() ?? file.path,
      closable: true,
      metadata: {
        projectName,
        filePath: file.path,
      },
      projectId: projectName ?? null,
    });
  };

  const openFile = (file: GitFileChange) => {
    openTab({
      type: "editor",
      title: file.path.split("/").pop() ?? file.path,
      closable: true,
      metadata: {
        projectName,
        filePath: file.path,
      },
      projectId: projectName ?? null,
    });
  };

  const allUnstaged = useMemo(
    () => [
      ...(status?.unstaged ?? []),
      ...(status?.untracked.map(
        (p): GitFileChange => ({ path: p, status: "?" }),
      ) ?? []),
    ],
    [status],
  );

  if (!projectName) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No project selected.
      </div>
    );
  }

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Loading git status...</span>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive text-sm">
        <p>{error}</p>
        <Button variant="outline" size="sm" onClick={fetchStatus}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-sm font-medium">
          {status?.current ? `On: ${status.current}` : "Git Status"}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant={viewMode === "flat" ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => setViewMode("flat")}
            title="Flat view"
          >
            <List className="size-3.5" />
          </Button>
          <Button
            variant={viewMode === "tree" ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => setViewMode("tree")}
            title="Tree view"
          >
            <FolderTree className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={fetchStatus}
            disabled={acting}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-1.5 text-xs text-destructive bg-destructive/10 shrink-0">
          {error}
        </div>
      )}

      <ScrollArea className="flex-1 overflow-hidden">
        <div className="p-2 space-y-3 overflow-hidden">
          {/* Staged Changes */}
          <FileSection
            title="Staged Changes"
            count={status?.staged.length ?? 0}
            files={status?.staged ?? []}
            viewMode={viewMode}
            actionIcon={<Minus className="size-3.5" />}
            actionTitle="Unstage"
            onAction={(f) => unstageFiles([f.path])}
            onActionAll={
              status?.staged.length
                ? () => unstageFiles(status.staged.map((f) => f.path))
                : undefined
            }
            actionAllLabel="Unstage All"
            onFolderAction={(files) => unstageFiles(files.map((f) => f.path))}
            onClickFile={openDiff}
            onOpenFile={openFile}
            disabled={acting}
          />

          {/* Unstaged Changes */}
          <FileSection
            title="Changes"
            count={allUnstaged.length}
            files={allUnstaged}
            viewMode={viewMode}
            actionIcon={<Plus className="size-3.5" />}
            actionTitle="Stage"
            onAction={(f) => stageFiles([f.path])}
            onActionAll={
              allUnstaged.length
                ? () => stageFiles(allUnstaged.map((f) => f.path))
                : undefined
            }
            actionAllLabel="Stage All"
            onFolderAction={(files) => stageFiles(files.map((f) => f.path))}
            onClickFile={openDiff}
            onOpenFile={openFile}
            disabled={acting}
            showRevert
            onRevert={(f) =>
              setRevertTarget({ label: f.path, files: [f.path] })
            }
            onFolderRevert={(files, folderName) =>
              setRevertTarget({
                label: `${folderName}/ (${files.length} files)`,
                files: files.map((f) => f.path),
              })
            }
          />
        </div>
      </ScrollArea>

      {/* Commit section */}
      <div className="border-t p-2 space-y-2 shrink-0">
        <textarea
          className="w-full h-16 px-3 py-2 text-base md:text-sm text-foreground bg-surface border border-border rounded-lg resize-none focus:outline-none focus:border-ring placeholder:text-muted-foreground"
          placeholder="Commit message..."
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              handleCommit();
            }
          }}
        />
        <Button
          size="sm"
          className="w-full"
          disabled={
            acting || !commitMsg.trim() || !status?.staged.length
          }
          onClick={handleCommit}
        >
          {acting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            `Commit (${status?.staged.length ?? 0})`
          )}
        </Button>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={acting}
            onClick={handlePush}
          >
            <ArrowUpFromLine className="size-3" />
            Push
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={acting}
            onClick={handlePull}
          >
            <ArrowDownToLine className="size-3" />
            Pull
          </Button>
        </div>
      </div>

      {/* Revert confirmation dialog */}
      <Dialog
        open={!!revertTarget}
        onOpenChange={(open) => !open && setRevertTarget(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard Changes</DialogTitle>
            <DialogDescription>
              Are you sure you want to discard all changes to{" "}
              <code className="px-1 py-0.5 rounded bg-muted text-sm font-mono">
                {revertTarget?.label}
              </code>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevertTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmRevert}
              disabled={acting}
            >
              {acting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                "Discard"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Action buttons                                                     */
/* ------------------------------------------------------------------ */

/** Inline action buttons for a file / folder row */
function ActionButtons({
  showRevert,
  onRevert,
  onAction,
  onOpenFile,
  actionIcon,
  actionTitle,
  disabled,
}: {
  showRevert?: boolean;
  onRevert?: () => void;
  onAction: () => void;
  onOpenFile?: () => void;
  actionIcon: React.ReactNode;
  actionTitle: string;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5 shrink-0 ml-1">
      {onOpenFile && (
        <button
          type="button"
          className="flex items-center justify-center size-7 rounded border border-border/60 bg-muted/60 text-muted-foreground hover:bg-primary/15 hover:text-primary hover:border-primary/40 active:scale-95 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile();
          }}
          disabled={disabled}
          title="Open file"
        >
          <FileText className="size-3.5" />
        </button>
      )}
      {showRevert && onRevert && (
        <button
          type="button"
          className="flex items-center justify-center size-7 rounded border border-border/60 bg-muted/60 text-muted-foreground hover:bg-destructive/15 hover:text-destructive hover:border-destructive/40 active:scale-95 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onRevert();
          }}
          disabled={disabled}
          title="Discard changes"
        >
          <Undo2 className="size-3.5" />
        </button>
      )}
      <button
        type="button"
        className="flex items-center justify-center size-7 rounded border border-border/60 bg-muted/60 text-muted-foreground hover:bg-accent hover:text-accent-foreground active:scale-95 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
        disabled={disabled}
        title={actionTitle}
      >
        {actionIcon}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  FileSection                                                        */
/* ------------------------------------------------------------------ */

function FileSection({
  title,
  count,
  files,
  viewMode,
  actionIcon,
  actionTitle,
  onAction,
  onActionAll,
  actionAllLabel,
  onFolderAction,
  onClickFile,
  onOpenFile,
  disabled,
  showRevert,
  onRevert,
  onFolderRevert,
}: {
  title: string;
  count: number;
  files: GitFileChange[];
  viewMode: ViewMode;
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: (f: GitFileChange) => void;
  onActionAll?: () => void;
  actionAllLabel: string;
  onFolderAction?: (files: GitFileChange[]) => void;
  onClickFile: (f: GitFileChange) => void;
  onOpenFile?: (f: GitFileChange) => void;
  disabled: boolean;
  showRevert?: boolean;
  onRevert?: (f: GitFileChange) => void;
  onFolderRevert?: (files: GitFileChange[], folderName: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          {title} ({count})
        </span>
        {onActionAll && count > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onActionAll}
            disabled={disabled}
            title={actionAllLabel}
          >
            {actionAllLabel}
          </Button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground px-1">No changes</p>
      ) : viewMode === "flat" ? (
        <div className="divide-y divide-border/40 w-full overflow-hidden">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              actionIcon={actionIcon}
              actionTitle={actionTitle}
              onAction={onAction}
              onClickFile={onClickFile}
              onOpenFile={onOpenFile}
              disabled={disabled}
              showRevert={showRevert}
              onRevert={onRevert}
            />
          ))}
        </div>
      ) : (
        <TreeView
          files={files}
          actionIcon={actionIcon}
          actionTitle={actionTitle}
          onAction={onAction}
          onFolderAction={onFolderAction}
          onClickFile={onClickFile}
          onOpenFile={onOpenFile}
          disabled={disabled}
          showRevert={showRevert}
          onRevert={onRevert}
          onFolderRevert={onFolderRevert}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  FileRow                                                            */
/* ------------------------------------------------------------------ */

function FileRow({
  file,
  actionIcon,
  actionTitle,
  onAction,
  onClickFile,
  onOpenFile,
  disabled,
  showRevert,
  onRevert,
  displayName,
}: {
  file: GitFileChange;
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: (f: GitFileChange) => void;
  onClickFile: (f: GitFileChange) => void;
  onOpenFile?: (f: GitFileChange) => void;
  disabled: boolean;
  showRevert?: boolean;
  onRevert?: (f: GitFileChange) => void;
  displayName?: string;
}) {
  return (
    <div className="flex items-center gap-1 hover:bg-muted/50 rounded px-1 py-1 w-full min-w-0">
      <span
        className={`text-xs font-mono w-4 text-center shrink-0 ${STATUS_COLORS[file.status] ?? ""}`}
      >
        {file.status}
      </span>
      <button
        type="button"
        className="flex-1 text-left text-xs font-mono truncate hover:underline min-w-0"
        onClick={() => onClickFile(file)}
        title={file.path}
      >
        {displayName ?? file.path}
      </button>
      <ActionButtons
        showRevert={showRevert}
        onRevert={onRevert ? () => onRevert(file) : undefined}
        onOpenFile={onOpenFile ? () => onOpenFile(file) : undefined}
        onAction={() => onAction(file)}
        actionIcon={actionIcon}
        actionTitle={actionTitle}
        disabled={disabled}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  TreeView                                                           */
/* ------------------------------------------------------------------ */

function TreeView({
  files,
  actionIcon,
  actionTitle,
  onAction,
  onFolderAction,
  onClickFile,
  onOpenFile,
  disabled,
  showRevert,
  onRevert,
  onFolderRevert,
}: {
  files: GitFileChange[];
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: (f: GitFileChange) => void;
  onFolderAction?: (files: GitFileChange[]) => void;
  onClickFile: (f: GitFileChange) => void;
  onOpenFile?: (f: GitFileChange) => void;
  disabled: boolean;
  showRevert?: boolean;
  onRevert?: (f: GitFileChange) => void;
  onFolderRevert?: (files: GitFileChange[], folderName: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <div>
      {tree.map((node, i) => (
        <TreeNodeView
          key={node.fullPath}
          node={node}
          depth={0}
          isLast={i === tree.length - 1}
          actionIcon={actionIcon}
          actionTitle={actionTitle}
          onAction={onAction}
          onFolderAction={onFolderAction}
          onClickFile={onClickFile}
          onOpenFile={onOpenFile}
          disabled={disabled}
          showRevert={showRevert}
          onRevert={onRevert}
          onFolderRevert={onFolderRevert}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  TreeNodeView                                                       */
/* ------------------------------------------------------------------ */

function TreeNodeView({
  node,
  depth,
  isLast,
  actionIcon,
  actionTitle,
  onAction,
  onFolderAction,
  onClickFile,
  onOpenFile,
  disabled,
  showRevert,
  onRevert,
  onFolderRevert,
}: {
  node: TreeNode;
  depth: number;
  isLast: boolean;
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: (f: GitFileChange) => void;
  onFolderAction?: (files: GitFileChange[]) => void;
  onClickFile: (f: GitFileChange) => void;
  onOpenFile?: (f: GitFileChange) => void;
  disabled: boolean;
  showRevert?: boolean;
  onRevert?: (f: GitFileChange) => void;
  onFolderRevert?: (files: GitFileChange[], folderName: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const isDir = node.children.length > 0 && !node.file;

  if (node.file) {
    return (
      <div
        className="relative overflow-hidden border-b border-border/30"
        style={{ paddingLeft: depth * 16 }}
      >
        {/* Vertical indent line */}
        {depth > 0 && (
          <div
            className="absolute top-0 bottom-0 border-l border-border/30"
            style={{ left: depth * 16 - 8 }}
          />
        )}
        <FileRow
          file={node.file}
          displayName={node.name}
          actionIcon={actionIcon}
          actionTitle={actionTitle}
          onAction={onAction}
          onClickFile={onClickFile}
          onOpenFile={onOpenFile}
          disabled={disabled}
          showRevert={showRevert}
          onRevert={onRevert}
        />
      </div>
    );
  }

  if (isDir) {
    const folderFiles = collectFiles(node);

    return (
      <div className="relative overflow-hidden">
        {/* Vertical indent line for this level */}
        {depth > 0 && (
          <div
            className="absolute top-0 border-l border-border/30"
            style={{ left: depth * 16 - 8, bottom: isLast ? "50%" : 0 }}
          />
        )}
        {/* Folder row */}
        <div
          className="flex items-center hover:bg-muted/50 rounded py-1 pr-1 border-b border-border/30"
          style={{ paddingLeft: depth * 16 + 4 }}
        >
          <button
            type="button"
            className="flex items-center gap-1 flex-1 min-w-0 text-xs font-mono text-muted-foreground"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" />
            )}
            <span className="truncate font-semibold">{node.name}</span>
            <span className="text-[10px] opacity-60 shrink-0">
              ({folderFiles.length})
            </span>
          </button>
          <ActionButtons
            showRevert={showRevert}
            onRevert={
              onFolderRevert
                ? () => onFolderRevert(folderFiles, node.fullPath)
                : undefined
            }
            onAction={() => onFolderAction?.(folderFiles)}
            actionIcon={actionIcon}
            actionTitle={`${actionTitle} ${node.name}/`}
            disabled={disabled}
          />
        </div>
        {/* Children with vertical guide line */}
        {expanded && (
          <div className="relative">
            {/* Continuous vertical line for children */}
            <div
              className="absolute top-0 bottom-0 border-l border-border/30"
              style={{ left: depth * 16 + 8 }}
            />
            {node.children.map((child, i) => (
              <TreeNodeView
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                isLast={i === node.children.length - 1}
                actionIcon={actionIcon}
                actionTitle={actionTitle}
                onAction={onAction}
                onFolderAction={onFolderAction}
                onClickFile={onClickFile}
                onOpenFile={onOpenFile}
                disabled={disabled}
                showRevert={showRevert}
                onRevert={onRevert}
                onFolderRevert={onFolderRevert}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return null;
}
