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
  GitCommitHorizontal,
  GitBranch,
  Check,
  SquareDashedMousePointer,
} from "@/lib/icons";
import { SidebarHeader } from "@/components/ui/sidebar-header";
import { api, projectUrl } from "@/lib/api-client";
import { basename } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProjectStore } from "@/stores/project-store";
import { useGitStatusStore } from "@/stores/git-status-store";
import { useGitRepo } from "@/hooks/use-git-repo";
import { FileIcon } from "@/lib/file-icons";
import { useExtensionStore } from "@/stores/extension-store";
import { GitWorktreePanel } from "./git-worktree-panel";
import { HunkStageDialog, type HunkStageTarget } from "./hunk-stage-dialog";
import { GitRepoBar, GitRepoChoice, GitNoRepo } from "./git-repo-picker";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GitStatus, GitFileChange } from "../../../types/git";
import { buildTree, compactTree, collectFiles, type TreeNode } from "@/lib/git-file-tree";

interface GitStatusPanelProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
  /** Called after an action that opens a new tab (e.g. view diff, open file) */
  onNavigate?: () => void;
}

type ViewMode = "flat" | "tree";

const STATUS_COLORS: Record<string, string> = {
  M: "text-warning",
  A: "text-success",
  D: "text-error",
  R: "text-primary",
  C: "text-accent-2",
  "?": "text-text-3",
};

/** Indent per nesting level, and where that level's guide line sits inside it. */
const TREE_INDENT = 14;
const TREE_GUIDE_X = 7;

/**
 * Ellipsize a name from its *start* instead of its end.
 *
 * These names are distinguished by their suffix, and `text-overflow: ellipsis`
 * cuts the wrong end: `remote-desktop-capture-input.ts` and
 * `remote-desktop-capture-args.ts` are identical for 23 characters, so a column
 * of right-truncated siblings renders as the same row repeated — which is the
 * bug this replaced.
 *
 * A right-to-left box ellipsizes at its end edge, which is the left one, and
 * `<bdi>` isolates the name so it still *reads* left to right. That matters for
 * a leading dot: outside an isolate, the `.` of `.gitignore` is a neutral
 * character at a run boundary and takes the paragraph's direction, so it hops
 * to the other end and the name renders as `gitignore.`.
 *
 * Preferred over splitting the name in two and pinning the tail beside an
 * ellipsized head: flex hands the head a fractional width while the ellipsis
 * lands on a whole character, and the remainder shows as a ragged gap in the
 * middle of every truncated name. Measured — `text-align` does not close it,
 * because alignment does not apply to overflowing content.
 */
function StartEllipsis({ children, className }: { children: string; className?: string }) {
  return (
    <span dir="rtl" className={`truncate text-left ${className ?? ""}`}>
      <bdi>{children}</bdi>
    </span>
  );
}

export function GitStatusPanel({ metadata, tabId, onNavigate }: GitStatusPanelProps) {
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
  // Non-null while the hunk picker is open, for the file it was opened on.
  const [hunkTarget, setHunkTarget] = useState<HunkStageTarget | null>(null);
  const { openTab } = useTabStore(useShallow((s) => ({ openTab: s.openTab })));
  const viewMode = useSettingsStore((s) => s.gitStatusViewMode);
  const setViewMode = useSettingsStore((s) => s.setGitStatusViewMode);
  const activeProjectPath = useProjectStore((s) =>
    s.projects.find((p) => p.name === projectName)?.path,
  );
  const setGitChangesCount = useGitStatusStore((s) => s.setCount);
  // A project folder is not always the repository: it is often a container
  // whose children are. This resolves which one every call below talks to.
  const gitRepo = useGitRepo(projectName);
  const gitRoot = gitRepo.repo?.path ?? activeProjectPath;
  // Git Graph extension is available when it has registered its command.
  const gitGraphAvailable = useExtensionStore(
    (s) => s.contributions?.commands?.some((c) => c.command === "git-graph.view") ?? false,
  );

  const fetchStatus = useCallback(async () => {
    // No repository resolved yet: the panel is showing the picker, and asking
    // git in the container folder is what produced the error this replaced.
    if (!projectName || !gitRepo.repo) return;
    try {
      setLoading(true);
      const data = await api.get<GitStatus>(
        gitRepo.gitUrl("/status"),
      );
      setStatus(data);
      setGitChangesCount(
        projectName,
        data.staged.length + data.unstaged.length + data.untracked.length,
      );
      useGitStatusStore.getState().setMeta(projectName, data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch status");
    } finally {
      setLoading(false);
    }
  }, [projectName, gitRepo, setGitChangesCount]);

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
      await api.post(gitRepo.gitUrl("/stage"), { files });
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
      await api.post(gitRepo.gitUrl("/unstage"), { files });
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
      await api.post(gitRepo.gitUrl("/discard"), { files });
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
      await api.post(gitRepo.gitUrl("/commit"), {
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
      await api.post(gitRepo.gitUrl("/push"), {});
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
      await api.post(gitRepo.gitUrl("/pull"), {});
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setActing(false);
    }
  };

  const handleAmend = async () => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(gitRepo.gitUrl("/commit"), {
        message: commitMsg.trim(),
        amend: true,
      });
      setCommitMsg("");
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Amend failed");
    } finally {
      setActing(false);
    }
  };

  const handleFetch = async () => {
    if (!projectName) return;
    setActing(true);
    try {
      await api.post(gitRepo.gitUrl("/fetch"), {});
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setActing(false);
    }
  };

  // Composite actions sequence existing handlers (each guards on `acting` itself).
  const handleCommitPush = async () => {
    await handleCommit();
    await handlePush();
  };

  const handleCommitSync = async () => {
    await handleCommit();
    await handlePull();
    await handlePush();
  };

  const openDiff = (file: GitFileChange) => {
    openTab({
      type: "git-diff",
      title: basename(file.path),
      closable: true,
      metadata: {
        projectName,
        // git named this relative to the repository; a tab's filePath is
        // relative to the project, and one directory up is an empty buffer.
        filePath: gitRepo.projectFile(file.path),
      },
      projectId: projectName ?? null,
    });
    onNavigate?.();
  };

  const openFile = (file: GitFileChange) => {
    openTab({
      type: "editor",
      title: basename(file.path),
      closable: true,
      metadata: {
        projectName,
        // git named this relative to the repository; a tab's filePath is
        // relative to the project, and one directory up is an empty buffer.
        filePath: gitRepo.projectFile(file.path),
      },
      projectId: projectName ?? null,
    });
    onNavigate?.();
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

  // Which repository comes first: a container workspace has no status of its
  // own, and the panel's body renders the chooser. Both spinners below have to
  // let that through, or the panel sits on "Loading git status..." forever
  // waiting for a fetch that deliberately never runs.
  if (!gitRepo.repo && !gitRepo.needsPick && !gitRepo.noRepo) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Looking for a repository...</span>
      </div>
    );
  }

  if (loading && !status && gitRepo.repo) {
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

  const stagedCount = status?.staged.length ?? 0;
  const commitDisabled = acting || !commitMsg.trim() || !stagedCount;

  // Compact commit UI — rendered in two slots (top on desktop, bottom on mobile).
  // State lives in the parent, so both instances stay in sync.
  const commitBox = (
    <div className="p-2 flex flex-col gap-2">
      <textarea
        className="w-full h-10 px-3 py-2 text-base md:text-sm text-foreground bg-surface border border-border rounded-lg resize-none focus:outline-none focus:border-ring placeholder:text-muted-foreground"
        placeholder="Message (⌘↵)"
        value={commitMsg}
        onChange={(e) => setCommitMsg(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            handleCommit();
          }
        }}
      />
      <div className="flex h-8">
        <Button
          size="sm"
          className="flex-1 rounded-r-none"
          disabled={commitDisabled}
          onClick={handleCommit}
        >
          {acting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <>
              <Check className="size-3.5" />
              Commit ({stagedCount})
            </>
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="w-8 px-0 rounded-l-none border-l border-white/20"
              disabled={acting}
              title="More commit actions"
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={handleCommitPush} disabled={commitDisabled}>
              <ArrowUpFromLine className="size-3.5" />
              Commit &amp; Push
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCommitSync} disabled={commitDisabled}>
              <RefreshCw className="size-3.5" />
              Commit &amp; Sync
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleAmend} disabled={acting}>
              <GitCommitHorizontal className="size-3.5" />
              Amend Last Commit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handlePush} disabled={acting}>
              <ArrowUpFromLine className="size-3.5" />
              Push
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handlePull} disabled={acting}>
              <ArrowDownToLine className="size-3.5" />
              Pull
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleFetch} disabled={acting}>
              <RefreshCw className="size-3.5" />
              Fetch
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <SidebarHeader icon={GitBranch} title={status?.current ? `On: ${status.current}` : "Source Control"}>
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
          onClick={() => {
            if (gitGraphAvailable) {
              const args: unknown[] = [];
              // The repository, not the project folder: the graph runs git in
              // whatever path it is handed.
              if (gitRoot) args.push(gitRoot);
              window.dispatchEvent(
                new CustomEvent("ext:command:execute", {
                  detail: { command: "git-graph.view", args },
                }),
              );
            } else {
              openTab({
                type: "git-log",
                title: "Git Log",
                projectId: projectName ?? null,
                closable: true,
                metadata: { projectName },
              });
            }
            onNavigate?.();
          }}
          title={gitGraphAvailable ? "Open Git Graph (⌘G)" : "View Git Log"}
        >
          <GitBranch className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={fetchStatus}
          disabled={acting}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </SidebarHeader>

      {error && (
        <div className="px-3 py-1.5 text-xs text-destructive bg-destructive/10 shrink-0">
          {error}
        </div>
      )}

      {/* Which repository, when the project folder is not one itself. */}
      {gitRepo.isNested && gitRepo.repo && (
        <GitRepoBar repo={gitRepo.repo} repos={gitRepo.repos} onChoose={gitRepo.choose} />
      )}

      {/* Until one is chosen there is nothing else this panel can show. */}
      {gitRepo.needsPick ? (
        <GitRepoChoice repos={gitRepo.repos} onChoose={gitRepo.choose} />
      ) : gitRepo.noRepo ? (
        <GitNoRepo onReload={gitRepo.reload} />
      ) : (
        <>
      {/* Commit block — top on web/desktop */}
      <div className="hidden md:block border-b border-border">{commitBox}</div>

      {/* Worktrees collapsible section */}
      {projectName && (
        <GitWorktreePanel
          projectName={projectName}
          projectPath={gitRoot}
        />
      )}

      <ScrollArea className="flex-1 overflow-hidden">
        <div className="p-1.5 space-y-2 overflow-hidden">
          {/* Staged Changes */}
          <FileSection
            title="Staged Changes"
            count={status?.staged.length ?? 0}
            files={status?.staged ?? []}
            viewMode={viewMode}
            actionIcon={<Minus className="size-3" />}
            actionAllIcon={<Minus className="size-3" />}
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
            onPickHunks={(f) => setHunkTarget({ filePath: f.path, scope: "index" })}
            disabled={acting}
          />

          {/* Unstaged Changes */}
          <FileSection
            title="Changes"
            count={allUnstaged.length}
            files={allUnstaged}
            viewMode={viewMode}
            actionIcon={<Plus className="size-3" />}
            actionAllIcon={<Plus className="size-3" />}
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
            onPickHunks={(f) => setHunkTarget({ filePath: f.path, scope: "worktree" })}
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

      {/* Commit block — bottom on mobile */}
      <div className="md:hidden border-t border-border shrink-0">{commitBox}</div>
        </>
      )}

      {/* Hunk / line picker */}
      <HunkStageDialog
        projectName={projectName}
        target={hunkTarget}
        onClose={() => setHunkTarget(null)}
        onApplied={fetchStatus}
      />

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

/** Overlay action buttons — visible on desktop hover, hidden on mobile */
function ActionButtons({
  showRevert,
  onRevert,
  onAction,
  onOpenFile,
  onPickHunks,
  actionIcon,
  actionTitle,
  disabled,
}: {
  showRevert?: boolean;
  onRevert?: () => void;
  onAction: () => void;
  onOpenFile?: () => void;
  onPickHunks?: () => void;
  actionIcon: React.ReactNode;
  actionTitle: string;
  disabled: boolean;
}) {
  return (
    <div className="hidden md:flex absolute right-0 top-0 bottom-0 items-center gap-0.5 pl-6 pr-1 bg-gradient-to-l from-background from-70% to-transparent can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity">
      {onOpenFile && (
        <button
          type="button"
          className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-primary active:scale-95 transition-colors"
          onClick={(e) => { e.stopPropagation(); onOpenFile(); }}
          disabled={disabled}
          title="Open file"
        >
          <FileText className="size-3" />
        </button>
      )}
      {onPickHunks && (
        <button
          type="button"
          className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-primary active:scale-95 transition-colors"
          onClick={(e) => { e.stopPropagation(); onPickHunks(); }}
          disabled={disabled}
          title={`${actionTitle} lines…`}
        >
          <SquareDashedMousePointer className="size-3" />
        </button>
      )}
      {showRevert && onRevert && (
        <button
          type="button"
          className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-destructive active:scale-95 transition-colors"
          onClick={(e) => { e.stopPropagation(); onRevert(); }}
          disabled={disabled}
          title="Discard changes"
        >
          <Undo2 className="size-3" />
        </button>
      )}
      <button
        type="button"
        className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-accent-foreground active:scale-95 transition-colors"
        onClick={(e) => { e.stopPropagation(); onAction(); }}
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
  actionAllIcon,
  actionTitle,
  onAction,
  onActionAll,
  actionAllLabel,
  onFolderAction,
  onClickFile,
  onOpenFile,
  onPickHunks,
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
  actionAllIcon?: React.ReactNode;
  actionTitle: string;
  onAction: (f: GitFileChange) => void;
  onActionAll?: () => void;
  actionAllLabel: string;
  onFolderAction?: (files: GitFileChange[]) => void;
  onClickFile: (f: GitFileChange) => void;
  onOpenFile?: (f: GitFileChange) => void;
  onPickHunks?: (f: GitFileChange) => void;
  disabled: boolean;
  showRevert?: boolean;
  onRevert?: (f: GitFileChange) => void;
  onFolderRevert?: (files: GitFileChange[], folderName: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          {title} ({count})
        </span>
        {onActionAll && count > 0 && (
          <button
            type="button"
            className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-accent-foreground active:scale-95 transition-colors"
            onClick={onActionAll}
            disabled={disabled}
            title={actionAllLabel}
          >
            {actionAllIcon}
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground px-1">No changes</p>
      ) : viewMode === "flat" ? (
        <div className="w-full overflow-hidden">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              actionIcon={actionIcon}
              actionTitle={actionTitle}
              onAction={onAction}
              onClickFile={onClickFile}
              onOpenFile={onOpenFile}
              onPickHunks={onPickHunks}
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
          onPickHunks={onPickHunks}
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
  onPickHunks,
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
  onPickHunks?: (f: GitFileChange) => void;
  disabled: boolean;
  showRevert?: boolean;
  onRevert?: (f: GitFileChange) => void;
  displayName?: string;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* One row for both platforms: the adaptive menu is what differs, and
            the tap that opens the diff is the filename button itself rather
            than a hand-rolled tap detector — so a press that became a scroll,
            or one that opened the sheet, cannot also open a diff. */}
        {/* 44px of row on a touch screen, compact where there is a pointer. */}
        <div className="group relative flex items-center gap-1.5 hover:bg-muted/50 rounded pl-1 py-2.5 md:py-1 w-full min-w-0 select-none">
          <span
            className={`text-xs font-mono w-3.5 text-center shrink-0 ${STATUS_COLORS[file.status] ?? ""}`}
          >
            {file.status}
          </span>
          <FileIcon name={file.path} className="size-4 shrink-0" />
          <button
            type="button"
            className="flex-1 flex min-w-0 text-left text-sm can-hover:hover:underline"
            onClick={() => onClickFile(file)}
            title={file.path}
          >
            <StartEllipsis className="min-w-0 flex-1">
              {displayName ?? file.path}
            </StartEllipsis>
          </button>
          <ActionButtons
            showRevert={showRevert}
            onRevert={onRevert ? () => onRevert(file) : undefined}
            onOpenFile={onOpenFile ? () => onOpenFile(file) : undefined}
            onPickHunks={onPickHunks ? () => onPickHunks(file) : undefined}
            onAction={() => onAction(file)}
            actionIcon={actionIcon}
            actionTitle={actionTitle}
            disabled={disabled}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onClick={() => onClickFile(file)}>View Diff</ContextMenuItem>
        {onOpenFile && (
          <ContextMenuItem onClick={() => onOpenFile(file)}>Open File</ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => onAction(file)} disabled={disabled}>
          {actionTitle}
        </ContextMenuItem>
        {onPickHunks && (
          <ContextMenuItem onClick={() => onPickHunks(file)} disabled={disabled}>
            {actionTitle} Lines…
          </ContextMenuItem>
        )}
        {showRevert && onRevert && (
          <>
            {/* Set apart, because on a sheet these rows are 44px tall and sit
                where the thumb already is. */}
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onClick={() => onRevert(file)}
              disabled={disabled}
            >
              Discard Changes
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
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
  onPickHunks,
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
  onPickHunks?: (f: GitFileChange) => void;
  disabled: boolean;
  showRevert?: boolean;
  onRevert?: (f: GitFileChange) => void;
  onFolderRevert?: (files: GitFileChange[], folderName: string) => void;
}) {
  const tree = useMemo(() => compactTree(buildTree(files)), [files]);

  return (
    <div>
      {tree.map((node, i) => (
        <TreeNodeView
          key={node.fullPath}
          node={node}
          depth={0}
          actionIcon={actionIcon}
          actionTitle={actionTitle}
          onAction={onAction}
          onFolderAction={onFolderAction}
          onClickFile={onClickFile}
          onOpenFile={onOpenFile}
          onPickHunks={onPickHunks}
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
  actionIcon,
  actionTitle,
  onAction,
  onFolderAction,
  onClickFile,
  onOpenFile,
  onPickHunks,
  disabled,
  showRevert,
  onRevert,
  onFolderRevert,
}: {
  node: TreeNode;
  depth: number;
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: (f: GitFileChange) => void;
  onFolderAction?: (files: GitFileChange[]) => void;
  onClickFile: (f: GitFileChange) => void;
  onOpenFile?: (f: GitFileChange) => void;
  onPickHunks?: (f: GitFileChange) => void;
  disabled: boolean;
  showRevert?: boolean;
  onRevert?: (f: GitFileChange) => void;
  onFolderRevert?: (files: GitFileChange[], folderName: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const isDir = node.children.length > 0 && !node.file;

  if (node.file) {
    return (
      <div style={{ paddingLeft: depth * TREE_INDENT }}>
        <FileRow
          file={node.file}
          displayName={node.name}
          actionIcon={actionIcon}
          actionTitle={actionTitle}
          onAction={onAction}
          onClickFile={onClickFile}
          onOpenFile={onOpenFile}
          onPickHunks={onPickHunks}
          disabled={disabled}
          showRevert={showRevert}
          onRevert={onRevert}
        />
      </div>
    );
  }

  if (isDir) {
    const folderFiles = collectFiles(node);
    const lastSlash = node.name.lastIndexOf("/");
    const folderPrefix = lastSlash >= 0 ? node.name.slice(0, lastSlash + 1) : "";
    const folderLeaf = lastSlash >= 0 ? node.name.slice(lastSlash + 1) : node.name;

    return (
      <div>
        {/* Folder row. The menu used to be a plain dropdown whose trigger was
            the whole row, which on a touch screen opens on *tap* — so tapping
            a folder opened a menu instead of expanding it, and there was no
            way to expand one at all. Long-press is the gesture for a menu. */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              // 44px of row on a touch screen, compact where there is a pointer.
              className="group relative flex items-center hover:bg-muted/50 rounded py-2.5 md:py-1 select-none"
              style={{ paddingLeft: depth * TREE_INDENT }}
            >
              <button
                type="button"
                className="flex items-center gap-1.5 flex-1 min-w-0 text-sm text-muted-foreground"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? (
                  <ChevronDown className="size-4 shrink-0" />
                ) : (
                  <ChevronRight className="size-4 shrink-0" />
                )}
                {/*
                 * A compacted name is a path, and for a path the last segment is
                 * the specific one — so the leading ones are what may be dropped,
                 * and they are dimmed to read as context rather than as the
                 * folder's own name. One inline flow inside the isolate, not two
                 * flex children: the row's `gap-1.5` would otherwise open a space
                 * inside the path, between `web/` and `components`.
                 */}
                <span dir="rtl" className="flex-1 min-w-0 truncate text-left">
                  <bdi>
                    {folderPrefix && <span className="opacity-55">{folderPrefix}</span>}
                    <span className="font-medium">{folderLeaf}</span>
                  </bdi>
                </span>
                <span className="text-xs opacity-55 shrink-0">
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
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-40">
            <ContextMenuItem onClick={() => onFolderAction?.(folderFiles)} disabled={disabled}>
              {actionTitle} {node.name}/
            </ContextMenuItem>
            {onFolderRevert && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  onClick={() => onFolderRevert(folderFiles, node.fullPath)}
                  disabled={disabled}
                >
                  Discard Changes
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
        {/*
         * One continuous guide per level, drawn here by the parent rather than
         * as a segment per child. The old version gave every row its own elbow
         * positioned by hand — a file's branch at `top: 50%`, a folder's at a
         * fixed `top: 13`, against rows of two different heights — so the
         * pieces never met and the rails read as broken. A single line owned by
         * the container it groups cannot drift from it, and dropping the elbows
         * is what VS Code's own tree does.
         */}
        {expanded && (
          <div className="relative">
            <span
              aria-hidden
              className="absolute top-0 bottom-0 w-px bg-border/70"
              style={{ left: depth * TREE_INDENT + TREE_GUIDE_X }}
            />
            {node.children.map((child, i) => (
              <TreeNodeView
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                actionIcon={actionIcon}
                actionTitle={actionTitle}
                onAction={onAction}
                onFolderAction={onFolderAction}
                onClickFile={onClickFile}
                onOpenFile={onOpenFile}
                onPickHunks={onPickHunks}
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
