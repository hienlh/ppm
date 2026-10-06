/**
 * Source Control: the branch and its sync button, the shared commit message,
 * and the working tree as one list of changed files.
 *
 * One list rather than VS Code's "Staged" and "Changes" groups, because a
 * file is not one or the other — staging works block by block, so a file is
 * often partly staged. Each row says how much with a dot per block and a
 * three-state checkbox; ticking it stages the rest of the file, and the Review
 * tab (or Lines…) is where a single block is picked.
 *
 * Read from `GET /git/changes` (`useGitChanges`), which also keeps the sidebar
 * badge, the explorer's decorations and the status bar current while this
 * panel is open. Every discard can be undone from its toast for a day: the
 * server keeps what it threw away (`git-discard-journal`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { emitOnboardingEvidence } from "@/lib/onboarding/onboarding-types";
import {
  AlertCircle,
  Archive,
  ArrowDownToLine,
  Check,
  FileDiff,
  FolderTree,
  GitBranch,
  History,
  List,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "@/lib/icons";
import { SidebarHeader } from "@/components/ui/sidebar-header";
import { api, projectUrl } from "@/lib/api-client";
import { basename } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProjectStore } from "@/stores/project-store";
import { useGitRepo } from "@/hooks/use-git-repo";
import { useGitChanges } from "@/hooks/use-git-changes";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useExtensionStore } from "@/stores/extension-store";
import { openGitReview } from "@/lib/open-git-review";
import {
  allCheckState,
  changeTotals,
  discardSummary,
  fileCheckState,
  hasConflictMarkers,
  hasUnstaged,
  OPERATION_NOUN,
  splitPath,
  syncMode,
  unstagePaths,
  type SyncMode,
} from "@/lib/git-changes-view";
import { formatRelativeDate } from "@/lib/format-date";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChangedFile, DiscardRecord, GitChanges, StashEntry } from "../../../shared/git-changes";
import { GitWorktreePanel } from "./git-worktree-panel";
import { HunkStageDialog, type HunkStageTarget } from "./hunk-stage-dialog";
import { GitRepoBar, GitRepoChoice, GitNoRepo } from "./git-repo-picker";
import { GitBranchRow } from "./git-branch-row";
import { GitCommitComposer, type CommitOptions } from "./git-commit-composer";
import { GitOperationBanner } from "./git-operation-banner";
import { GitStashSection, type StashAction } from "./git-stash-section";
import { GitChangeRow, type ChangeRowActions } from "./git-change-row";
import { GitChangeTree, type FolderActions } from "./git-change-tree";
import { CheckCell, CountChip, GroupLabel } from "./git-change-parts";
import { GitConfirm, type GitConfirmRequest } from "./git-confirm";

interface GitStatusPanelProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
  /** Called after an action that opens a new tab (e.g. view diff, open file) */
  onNavigate?: () => void;
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function GitStatusPanel({ metadata, tabId, onNavigate }: GitStatusPanelProps) {
  const projectName = metadata?.projectName as string | undefined;
  // A project folder is not always the repository: it is often a container
  // whose children are. This resolves which one every call below talks to.
  const gitRepo = useGitRepo(projectName);
  const { changes, error, refresh } = useGitChanges(projectName);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<GitConfirmRequest | null>(null);
  // Non-null while the hunk picker is open, for the file it was opened on.
  const [hunkTarget, setHunkTarget] = useState<HunkStageTarget | null>(null);
  const { openTab } = useTabStore(useShallow((s) => ({ openTab: s.openTab })));
  const viewMode = useSettingsStore((s) => s.gitStatusViewMode);
  const setViewMode = useSettingsStore((s) => s.setGitStatusViewMode);
  const activeProjectPath = useProjectStore((s) =>
    s.projects.find((p) => p.name === projectName)?.path,
  );
  const gitRoot = gitRepo.repo?.path ?? activeProjectPath;
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  // The write under way, for a toast's Undo: it outlives the render it was made in.
  const running = useRef<string | null>(null);

  const activeProjectName = useProjectStore((s) => s.activeProject?.name);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const [onboardingRefresh, setOnboardingRefresh] = useState(0);
  useEffect(() => {
    const onRefresh = () => setOnboardingRefresh((n) => n + 1);
    window.addEventListener("ppm:onboarding-refresh", onRefresh);
    return () => window.removeEventListener("ppm:onboarding-refresh", onRefresh);
  }, []);
  useEffect(() => {
    if (!projectName || projectName !== activeProjectName || (tabId && tabId !== activeTabId) ||
      !gitRepo.repo || !changes) return;
    const visible = !!panelRef.current?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    if (visible) emitOnboardingEvidence({ type: "git-ready", projectName, visible });
  }, [onboardingRefresh, projectName, activeProjectName, tabId, activeTabId, gitRepo.repo, changes]);
  // Git Graph extension is available when it has registered its command.
  const gitGraphAvailable = useExtensionStore(
    (s) => s.contributions?.commands?.some((c) => c.command === "git-graph.view") ?? false,
  );

  const files = useMemo(() => changes?.files ?? [], [changes]);
  const totals = useMemo(() => changeTotals(files), [files]);
  const conflicts = useMemo(() => files.filter((f) => f.conflict), [files]);
  const others = useMemo(() => files.filter((f) => !f.conflict), [files]);
  const url = gitRepo.gitUrl;

  /** One git write at a time; a failure is a toast, and the list is read again either way. */
  async function run<T>(name: string, fn: () => Promise<T>, failure: string): Promise<{ value: T } | null> {
    setBusy(name);
    running.current = name;
    try {
      return { value: await fn() };
    } catch (e) {
      toast.error(failure, { description: errorText(e) });
      return null;
    } finally {
      setBusy(null);
      running.current = null;
      void refresh();
    }
  }

  const stage = (paths: string[]) =>
    run("stage", () => api.post(url("/stage"), { files: paths }), "Could not stage");
  const unstage = (paths: string[]) =>
    run("unstage", () => api.post(url("/unstage"), { files: paths }), "Could not unstage");
  /** Tick: stage the rest; untick once it is all staged. Conflicts are only ever staged one by one. */
  const toggleMany = (targets: ChangedFile[]) =>
    allCheckState(targets) === "all"
      ? unstage(targets.flatMap(unstagePaths))
      : stage(targets.filter((f) => !f.conflict).map((f) => f.path));

  const undoDiscard = async (record: DiscardRecord, what: string) => {
    const done = await run("undo", () => api.post(url("/discard/undo"), { id: record.id }), "Could not undo the discard");
    if (done) toast.success(`Restored ${what}`);
  };

  const discard = async (targets: ChangedFile[]) => {
    const what = targets.length === 1 ? splitPath(targets[0]!.path)[1] : plural(targets.length, "file");
    const done = await run(
      "discard",
      () => api.post<{ discarded: string[]; undo: DiscardRecord | null }>(url("/discard"), { files: targets.map((f) => f.path) }),
      "Could not discard",
    );
    const record = done?.value.undo;
    if (!record) return;
    // Undo brings back what was kept, and nothing else: a file too large to copy is gone
    // for good, so a discard that kept nothing offers no Undo at all.
    if (record.paths.length) {
      const kept = record.paths.length === 1 ? splitPath(record.paths[0]!)[1] : plural(record.paths.length, "file");
      toast(`Discarded changes to ${what}`, {
        action: { label: "Undo", onClick: () => void undoDiscard(record, kept) },
        duration: 8000,
      });
    }
    if (record.skipped?.length) {
      toast.warning(`${record.skipped.join(", ")} could not be kept, so it cannot be restored`, {
        description: "Files over 20 MB are discarded without a copy.",
      });
    }
  };

  const askDiscard = (targets: ChangedFile[], anchor: HTMLElement) => {
    if (!targets.length) return;
    const summary = discardSummary(targets);
    setConfirm({
      anchor,
      title: summary.title,
      body: summary.body,
      confirmLabel: summary.confirm,
      onConfirm: () => void discard(targets),
    });
  };

  const openDiff = (file: ChangedFile) => {
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

  /** The Review changes tab, on `file` when one is given (a repository path, as git named it). */
  const review = (file?: ChangedFile) => {
    if (!projectName) return;
    openGitReview(projectName, file?.path);
    onNavigate?.();
  };

  const openFile = (file: ChangedFile) => {
    openTab({
      type: "editor",
      title: basename(file.path),
      closable: true,
      metadata: { projectName, filePath: gitRepo.projectFile(file.path) },
      projectId: projectName ?? null,
    });
    onNavigate?.();
  };

  const resolve = (file: ChangedFile) => {
    openTab({
      type: "conflict-editor",
      title: `Conflict: ${basename(file.path)}`,
      closable: true,
      metadata: { projectName, filePath: gitRepo.projectFile(file.path) },
      projectId: projectName ?? null,
    });
    onNavigate?.();
  };

  /**
   * Staging a conflict is what marks it resolved, markers or not — so with
   * git's markers still in the file, ask first, as VS Code does.
   */
  const markResolved = async (file: ChangedFile, anchor?: HTMLElement) => {
    const text = projectName
      ? await api
          .get<{ content: string }>(`${projectUrl(projectName)}/files/read?path=${encodeURIComponent(gitRepo.projectFile(file.path))}`)
          .then((r) => r.content, () => "")
      : "";
    if (!anchor || !hasConflictMarkers(text)) return void stage([file.path]);
    setConfirm({
      anchor,
      title: `${basename(file.path)} still has conflict markers`,
      body: "Marking it resolved stages the file as it is, markers and all.",
      confirmLabel: "Mark resolved",
      confirmIcon: <Check />,
      onConfirm: () => void stage([file.path]),
    });
  };

  const rowActions: ChangeRowActions = {
    onOpen: review,
    onOpenDiff: openDiff,
    onOpenFile: openFile,
    onToggle: (file, anchor) => {
      if (file.conflict) void markResolved(file, anchor);
      else if (fileCheckState(file) === "all") void unstage(unstagePaths(file));
      else void stage([file.path]);
    },
    onStage: (file, anchor) => (file.conflict ? void markResolved(file, anchor) : void stage([file.path])),
    onUnstage: (file) => unstage(unstagePaths(file)),
    onPickLines: (file, scope) => setHunkTarget({ filePath: file.path, scope }),
    onDiscard: (file, anchor) => askDiscard([file], anchor),
    onResolve: resolve,
  };
  const folderActions: FolderActions = {
    onToggleFolder: toggleMany,
    onDiscardFolder: (targets, _folder, anchor) => askDiscard(targets, anchor),
  };

  /** Undo the commit `hash` names: the server refuses once it is no longer the last one. */
  const undoCommit = async (hash: string | undefined) => {
    // A push still going out could carry the commit to the remote after it was taken back here.
    if (running.current) return void toast.warning("Wait for git to finish", { description: "Undo the commit once it is done." });
    if (!hash) return;
    const done = await run("undo-commit", () => api.post(url("/commit/undo"), { hash }), "Could not undo the commit");
    if (done) toast("Commit undone — its changes are staged again");
  };

  async function sync(mode: SyncMode, branch = changes?.branch): Promise<boolean> {
    if (!branch) return false;
    const upstream = branch.upstream ?? "the remote";
    switch (mode) {
      case "push": {
        const done = await run("push", () => api.post(url("/push"), {}), "Push failed");
        if (done) toast.success(branch.ahead ? `Pushed ${plural(branch.ahead, "commit")} to ${upstream}` : `Pushed to ${upstream}`);
        return !!done;
      }
      case "pull": {
        const done = await run("pull", () => api.post(url("/pull"), {}), "Pull failed");
        if (done) toast.success(`Pulled ${plural(branch.behind, "commit")} from ${upstream}`);
        return !!done;
      }
      case "sync": {
        const done = await run("sync", async () => {
          await api.post(url("/pull"), {});
          await api.post(url("/push"), {});
        }, "Sync failed");
        if (done) toast.success(`In sync with ${upstream}`);
        return !!done;
      }
      case "publish": {
        const done = await run("publish", () => api.post<{ remote: string; branch: string }>(url("/publish"), {}), "Publish failed");
        if (done) toast.success(`Published ${done.value.branch} to ${done.value.remote}`);
        return !!done;
      }
      case "synced": {
        const done = await run("fetch", () => api.post(url("/fetch"), {}), "Fetch failed");
        if (!done) return false;
        const next = await refresh();
        const behind = next?.branch.behind ?? 0;
        toast(behind ? `Fetched — ${plural(behind, "new commit")} to pull` : "Fetched — nothing new");
        return true;
      }
    }
  }

  const commit = async (message: string, options: CommitOptions): Promise<boolean> => {
    const before: GitChanges | null = changes;
    const filesStaged = totals.filesStaged;
    const done = await run(
      "commit",
      () => api.post<{ hash: string }>(url("/commit"), { message, amend: !!options.amend, signoff: !!options.signoff }),
      options.amend ? "Could not amend the commit" : "Could not commit",
    );
    if (!done) return false;
    const short = done.value.hash.slice(0, 7);
    if (options.amend) {
      // Undo takes a commit back whole, which for an amend is more than the amend.
      toast(`Amended ${short}`);
    } else {
      const hash = done.value.hash;
      toast(`Committed ${short} · ${plural(filesStaged, "file")}`, {
        action: { label: "Undo", onClick: () => void undoCommit(hash) },
      });
    }
    if (options.push && before) {
      // A branch with no upstream yet is published, not pushed.
      const mode = syncMode(before.branch) === "publish" ? "publish" : "push";
      await sync(mode, { ...before.branch, ahead: before.branch.ahead + 1 });
    }
    return true;
  };

  const stashAll = async () => {
    const done = await run(
      "stash",
      () => api.post<{ stash: StashEntry | null }>(url("/stash"), { includeUntracked: true }),
      "Could not stash",
    );
    if (!done) return;
    // The stash this made, never the one on top: with nothing it could save, git
    // still succeeds, and the stash on top is then an older one.
    const top = done.value.stash;
    if (!top) return void toast("Nothing was stashed", { description: "git found no change it could save." });
    toast(`Stashed ${plural(totals.files, "file")}`, {
      action: { label: "Undo", onClick: () => void stashAction("pop", top) },
    });
  };

  const stashAction = async (action: StashAction, stash: StashEntry) => {
    const done = await run(
      `stash-${action}`,
      () => api.post<{ indexRestored?: boolean }>(url(`/stash/${action}`), { index: stash.index, hash: stash.hash }),
      `Could not ${action} the stash`,
    );
    if (!done) return;
    const what = action === "apply" ? "Stash applied" : action === "pop" ? "Stash applied and dropped" : "Stash dropped";
    if (done.value.indexRestored === false) {
      toast.warning(what, { description: "Its staged changes no longer fit the index, so they came back unstaged." });
    } else {
      toast.success(what);
    }
  };
  const onStash = (action: StashAction, stash: StashEntry, anchor: HTMLElement) => {
    if (action !== "drop") return void stashAction(action, stash);
    setConfirm({
      anchor,
      title: `Drop “${stash.message || `stash@{${stash.index}}`}”?`,
      body: "The stash is deleted for good: nothing in PPM can bring it back.",
      confirmLabel: "Drop stash",
      onConfirm: () => void stashAction("drop", stash),
    });
  };

  const abortOperation = (anchor: HTMLElement) => {
    const op = changes?.operation;
    if (!op) return;
    const noun = OPERATION_NOUN[op.kind];
    setConfirm({
      anchor,
      title: `Abort the ${noun}?`,
      body: `This puts the branch back where it was before the ${noun} started. Conflicts you resolved so far are lost.`,
      confirmLabel: `Abort ${noun}`,
      confirmIcon: <X />,
      onConfirm: () => void run("abort", () => api.post(url("/operation/abort"), {}), `Could not abort the ${noun}`),
    });
  };
  const continueOperation = async () => {
    const op = changes?.operation;
    if (!op) return;
    const done = await run("continue", () => api.post(url("/operation/continue"), {}), `Could not continue the ${OPERATION_NOUN[op.kind]}`);
    if (done) toast.success(`The ${OPERATION_NOUN[op.kind]} is finished`);
  };

  const openGraph = () => {
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
  };

  /*
   * Review the whole branch at once, rather than one commit at a time. Core
   * rather than the Git Graph extension's compare panel: a review is the one
   * git surface that wants Monaco, and a webview cannot have it. The tab picks
   * its own defaults — main/master against the current branch.
   */
  const openBranchReview = () => {
    openTab({
      type: "branch-review",
      title: "Branch Review",
      projectId: projectName ?? null,
      closable: true,
      metadata: { projectName },
    });
    onNavigate?.();
  };

  if (!projectName) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No project selected.
      </div>
    );
  }

  // Which repository comes first: a container workspace has no changes of its
  // own, and the panel's body renders the chooser. Both spinners below have to
  // let that through, or the panel sits on a spinner forever waiting for a
  // fetch that deliberately never runs.
  if (!gitRepo.repo && !gitRepo.needsPick && !gitRepo.noRepo) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Looking for a repository...</span>
      </div>
    );
  }

  const discardable = others.filter(hasUnstaged);
  const operation = changes?.operation ?? null;
  const headerButton = "max-md:size-11";

  const composer = changes && files.length > 0 && !operation && (
    <GitCommitComposer
      projectName={projectName}
      branch={changes.branch.head}
      totals={totals}
      lastCommit={changes.lastCommit}
      busy={busy}
      onCommit={commit}
      onUndoCommit={() => undoCommit(changes.lastCommit?.hash)}
      className={isMobile ? "shrink-0 border-t border-border-soft" : "shrink-0"}
    />
  );

  const list = changes && (
    files.length > 0 ? (
      <>
        {conflicts.length > 0 && (
          <>
            <GroupLabel count={conflicts.length} tone="error">
              <AlertCircle className="size-3.5" />
              Conflicts
            </GroupLabel>
            {conflicts.map((file) => (
              <GitChangeRow key={file.path} file={file} busy={!!busy} actions={rowActions} />
            ))}
          </>
        )}
        {others.length > 0 && (
          <>
            {/* On a phone the border sits outside the 44px, which the select-all box stretches to fill. */}
            <div className="flex h-11 md:h-[34px] max-md:box-content shrink-0 items-center gap-1.5 border-t border-border-soft pl-2.5 first:border-t-0">
              <span className="text-[10.5px] font-semibold uppercase tracking-[.07em] text-text-3">
                {operation?.kind === "merge" ? "Merged" : "Changes"}
              </span>
              <CountChip count={others.length} />
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="xs"
                className="text-text-2 max-md:h-11"
                title="Review block by block"
                onClick={() => review()}
              >
                <FileDiff className="size-3.5" />
                Review
              </Button>
              {/* Mid-merge these are the merge's own result: unticking them all
                  would quietly leave them out of the merge commit. */}
              {!operation && (
                <CheckCell
                  state={allCheckState(others)}
                  disabled={!!busy}
                  label={allCheckState(others) === "all" ? "Unstage everything" : "Stage everything"}
                  title={allCheckState(others) === "all" ? "Unstage everything" : "Stage everything"}
                  onToggle={() => void toggleMany(others)}
                />
              )}
            </div>
            {viewMode === "tree" ? (
              <GitChangeTree files={others} busy={!!busy} actions={rowActions} folderActions={folderActions} />
            ) : (
              others.map((file) => (
                <GitChangeRow key={file.path} file={file} busy={!!busy} actions={rowActions} />
              ))
            )}
          </>
        )}
        {changes.truncated && (
          <p className="px-2.5 py-2 text-xs text-text-3">Only the first {files.length.toLocaleString()} changes are listed.</p>
        )}
      </>
    ) : (
      <CleanState changes={changes} busy={busy} onUndoCommit={() => void undoCommit(changes.lastCommit?.hash)} />
    )
  );

  const folds = projectName && changes && (
    <div className="border-t border-border-soft">
      <GitStashSection projectName={projectName} count={changes.stashes} busy={busy} onAction={onStash} />
      <GitWorktreePanel projectName={projectName} projectPath={gitRoot} />
    </div>
  );

  return (
    <div ref={panelRef} data-onboarding="git" className="flex flex-col h-full overflow-hidden">
      <SidebarHeader icon={GitBranch} title="Source Control">
        <Button
          variant="ghost"
          size="icon-xs"
          className={headerButton}
          onClick={() => setViewMode(viewMode === "tree" ? "flat" : "tree")}
          title={viewMode === "tree" ? "Show as a list" : "Group by folder"}
          aria-label={viewMode === "tree" ? "Show as a list" : "Group by folder"}
        >
          {viewMode === "tree" ? <List className="size-3.5" /> : <FolderTree className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={headerButton}
          onClick={openGraph}
          title={gitGraphAvailable ? "Open Git Graph (⌘G)" : "View Git Log"}
        >
          <History className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={moreRef}
              variant="ghost"
              size="icon-xs"
              className={headerButton}
              title="More actions"
              aria-label="More actions"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onClick={() => void sync("synced")} disabled={!!busy || !changes?.branch.hasRemote}>
              <RefreshCw />
              Fetch
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void run("pull", () => api.post(url("/pull"), { rebase: true }), "Pull failed")}
              disabled={!!busy || !changes?.branch.upstream || changes.branch.upstreamGone}
            >
              <ArrowDownToLine />
              Pull with rebase
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void stashAll()} disabled={!!busy || !files.length}>
              <Archive />
              Stash all changes
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openBranchReview}>
              <FileDiff />
              Review branch…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void refresh()}>
              <RefreshCw />
              Refresh
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!!busy || !discardable.length}
              onClick={() => {
                if (moreRef.current) askDiscard(discardable, moreRef.current);
              }}
            >
              <Trash2 />
              Discard all changes…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarHeader>

      {/* Which repository, when the project folder is not one itself. */}
      {gitRepo.isNested && gitRepo.repo && (
        <GitRepoBar repo={gitRepo.repo} repos={gitRepo.repos} onChoose={gitRepo.choose} />
      )}

      {/* Until one is chosen there is nothing else this panel can show. */}
      {gitRepo.needsPick ? (
        <GitRepoChoice repos={gitRepo.repos} onChoose={gitRepo.choose} />
      ) : gitRepo.noRepo ? (
        <GitNoRepo onReload={gitRepo.reload} />
      ) : !changes ? (
        error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center text-destructive text-sm">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-sm">Loading git status...</span>
          </div>
        )
      ) : (
        <>
          <GitBranchRow
            projectName={projectName}
            branch={changes.branch}
            operation={operation}
            files={files.length}
            busy={busy}
            onSync={(mode) => void sync(mode)}
          />
          {error && (
            <div className="shrink-0 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{error}</div>
          )}
          {operation && (
            <GitOperationBanner
              operation={operation}
              branch={changes.branch.head}
              conflicts={conflicts.length}
              busy={busy}
              onAbort={abortOperation}
              onContinue={() => void continueOperation()}
            />
          )}
          {/* The message box: under the branch where there is a pointer, in the thumb zone on a phone. */}
          {!isMobile && composer}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
            {list}
            {isMobile && folds}
          </div>
          {!isMobile && folds}
          {isMobile && composer}
        </>
      )}

      {/* Hunk / line picker */}
      <HunkStageDialog
        projectName={projectName}
        target={hunkTarget}
        onClose={() => setHunkTarget(null)}
        onApplied={() => void refresh()}
      />
      <GitConfirm request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/** Nothing to commit: say so, and show the last commit with its Undo while that is still safe. */
function CleanState({ changes, busy, onUndoCommit }: {
  changes: GitChanges;
  busy: string | null;
  onUndoCommit: () => void;
}) {
  const last = changes.lastCommit;
  const undoable = !!last && !last.pushed && last.hasParent && !changes.operation;
  return (
    <>
      <div className="px-[18px] py-[26px] text-center text-[12.5px] text-text-2">
        <div className="mx-auto mb-2.5 grid size-10 place-items-center rounded-full bg-success/14 text-success">
          <Check className="size-4" />
        </div>
        <b className="mb-1 block text-[13px] font-semibold text-text">Nothing to commit</b>
        The working tree matches the last commit.
      </div>
      {last && (
        <div className="mx-2.5 mb-2.5 rounded-[10px] border border-border-soft bg-background px-3 py-2.5 text-xs text-text-2">
          <span className="text-text-3">Last commit</span>
          <b className="block truncate font-medium text-text" title={last.subject}>{last.subject}</b>
          <div className="mt-1.5 flex items-center gap-2 whitespace-nowrap text-text-3">
            <span className="font-mono">{last.hash.slice(0, 7)}</span>
            <span>{formatRelativeDate(last.date)}</span>
            <span className="flex-1" />
            {undoable && (
              <button
                type="button"
                className="inline-flex h-11 md:h-6 items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] font-medium text-text-2 hover:bg-surface-hover hover:text-text disabled:opacity-50"
                disabled={!!busy}
                onClick={onUndoCommit}
                title="Take the commit back, keeping its changes staged"
              >
                <Undo2 className="size-3.5" />
                Undo
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
