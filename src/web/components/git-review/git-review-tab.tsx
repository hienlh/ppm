/**
 * Review changes — the working tree block by block: each change staged or
 * discarded where it sits in its file, with the shared commit box beside it.
 * One tab per project, on whichever repository Source Control has chosen;
 * opened from Source Control and from the Git Graph's uncommitted changes.
 *
 * The state lives in `useGitReview`; this picks the desktop or the phone
 * layout and keeps the tab's title on the branch.
 */
import { useCallback, useEffect } from "react";
import { Loader2 } from "@/lib/icons";
import { basename } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useGitRepo } from "@/hooks/use-git-repo";
import { useGitReview, type GitReview } from "@/hooks/use-git-review";
import { useExtensionStore } from "@/stores/extension-store";
import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import { patchTabMetadata } from "@/lib/patch-tab-metadata";
import type { ChangedFile } from "../../../shared/git-changes";
import { GitReviewDesktop } from "./git-review-desktop";
import { GitReviewPhone } from "./git-review-phone";

export interface GitReviewView {
  review: GitReview;
  projectName: string;
  branch: string | null;
  /** Open the file in the editor (repository-relative path). */
  openFile: (path: string) => void;
  openGraph: () => void;
  resolve: (file: ChangedFile) => void;
}

export function GitReviewTab({ metadata, tabId }: { metadata?: Record<string, unknown>; tabId?: string }) {
  const projectName = metadata?.projectName as string | undefined;
  const select = metadata?.select as { path?: string; at?: number; repo?: string } | undefined;
  const isMobile = useIsMobile();
  const gitRepo = useGitRepo(projectName);
  // The file named is in the repository asked for: looked for in the list of the one the
  // tab is still on, it would not be found and never be shown once the tab had moved.
  const held = !!select?.repo && select.repo !== gitRepo.repo?.path;
  const review = useGitReview(projectName, held ? undefined : select);

  // Asked for by a surface on another repository — the Git Graph of a
  // sub-repository — so that is the one to review. Applied once and then
  // dropped from the tab, or a reload would undo a choice made since in Source
  // Control.
  const chooseRepo = gitRepo.choose;
  useEffect(() => {
    if (!select?.repo || !tabId) return;
    chooseRepo(select.repo);
    const { repo: _applied, ...rest } = select;
    patchTabMetadata(tabId, { select: rest });
  }, [select, tabId, chooseRepo]);
  const branch = review.changes?.branch.head ?? null;
  const gitGraphAvailable = useExtensionStore(
    (s) => s.contributions?.commands?.some((c) => c.command === "git-graph.view") ?? false,
  );

  // The tab names the branch it reviews, which can change under it.
  useEffect(() => {
    if (!tabId || !review.changes) return;
    const title = `Changes · ${branch ?? "detached HEAD"}`;
    const tab = usePanelStore.getState().getPanelForTab(tabId)?.tabs.find((t) => t.id === tabId);
    if (tab && tab.title !== title) useTabStore.getState().updateTab(tabId, { title });
  }, [tabId, branch, review.changes]);

  const { projectFile } = gitRepo;
  const repoPath = gitRepo.repo?.path;
  const openTab = useCallback((type: "editor" | "conflict-editor", path: string) => {
    if (!projectName) return;
    useTabStore.getState().openTab({
      type,
      title: type === "editor" ? basename(path) : `Conflict: ${basename(path)}`,
      closable: true,
      // git names it relative to the repository; a tab's filePath is relative to the project.
      metadata: { projectName, filePath: projectFile(path) },
      projectId: projectName,
    });
  }, [projectName, projectFile]);

  const openGraph = useCallback(() => {
    if (gitGraphAvailable) {
      // The repository, not the project folder: the graph runs git in whatever path it is handed.
      window.dispatchEvent(new CustomEvent("ext:command:execute", { detail: { command: "git-graph.view", args: repoPath ? [repoPath] : [] } }));
    } else if (projectName) {
      useTabStore.getState().openTab({ type: "git-log", title: "Git Log", projectId: projectName, closable: true, metadata: { projectName } });
    }
  }, [gitGraphAvailable, repoPath, projectName]);

  if (!projectName) {
    return <div className="flex h-full items-center justify-center text-sm text-text-3">No project selected.</div>;
  }
  if (gitRepo.needsPick || gitRepo.noRepo) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-3">
        {gitRepo.noRepo ? "This project is not a git repository." : "Choose a repository in Source Control first."}
      </div>
    );
  }
  if (!review.changes) {
    return review.error ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-destructive">
        <p>{review.error}</p>
      </div>
    ) : (
      <div className="flex h-full items-center justify-center gap-2 text-text-3">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Reading the changes…</span>
      </div>
    );
  }

  const view: GitReviewView = {
    review,
    projectName,
    branch,
    openFile: (path) => openTab("editor", path),
    openGraph,
    resolve: (file) => openTab("conflict-editor", file.path),
  };
  return isMobile ? <GitReviewPhone view={view} /> : <GitReviewDesktop view={view} />;
}
