/**
 * The repository a git surface should talk to, and the two ways to address it.
 *
 * `gitUrl` builds a project-scoped git URL carrying the `repo=` scope, and
 * `repoPath` rebases a project-relative file path onto that repository. Between
 * them they cover both shapes of git route: the repo-scoped ones (status, log,
 * graph, worktrees) and the file-scoped ones (blame, hunks, file diff).
 *
 * For a project that *is* a repository — nearly all of them — every URL this
 * returns is byte-identical to what the call site built before, and
 * `repoPath` is the identity. That is deliberate: the container-folder case
 * must not be able to regress the ordinary one.
 */
import { useCallback, useEffect, useMemo } from "react";
import { projectUrl } from "@/lib/api-client";
import { useGitRepoStore } from "@/stores/git-repo-store";
import {
  hasNoRepo,
  needsPick,
  projectRelativePath,
  rebaseStatusPaths,
  repoRelativePath,
  resolveRepo,
  withRepoParam,
  type GitRepoCandidate,
  type StatusPaths,
} from "@/lib/git-repo-scope";

export interface UseGitRepo {
  /** The resolved repository, or null while loading / awaiting a choice. */
  repo: GitRepoCandidate | null;
  /** Every repository under the project, for a picker. */
  repos: GitRepoCandidate[];
  /** True when the project root is not a repository but something under it is. */
  isNested: boolean;
  /** True when there is a choice to make and it has not been made. */
  needsPick: boolean;
  /** True when nothing under the project is a repository. */
  noRepo: boolean;
  loading: boolean;
  /** `gitUrl("/status")`, `gitUrl("/graph?max=50")` — scope included. */
  gitUrl: (suffix: string) => string;
  /** Project-relative → repository-relative; null when outside the repository. */
  repoPath: (projectRelative: string) => string | null;
  /** Repository-relative → project-relative, for paths git reported. */
  projectFile: (repoRelative: string) => string;
  /** A status answer with its paths in the project's terms, for the file tree. */
  rebaseStatus: <T extends StatusPaths>(status: T) => T;
  choose: (repoPath: string) => void;
  reload: () => void;
}

export function useGitRepo(projectName: string | undefined): UseGitRepo {
  const discovery = useGitRepoStore((s) => (projectName ? s.discovery[projectName] : undefined));
  const chosen = useGitRepoStore((s) => (projectName ? s.chosen[projectName] : undefined));
  const loading = useGitRepoStore((s) => (projectName ? (s.loading[projectName] ?? false) : false));
  const load = useGitRepoStore((s) => s.load);
  const chooseInStore = useGitRepoStore((s) => s.choose);

  useEffect(() => {
    if (projectName) void load(projectName);
  }, [projectName, load]);

  const repo = resolveRepo(discovery, chosen);

  const gitUrl = useCallback(
    (suffix: string) => withRepoParam(`${projectUrl(projectName ?? "")}/git${suffix}`, repo),
    [projectName, repo],
  );

  const repoPath = useCallback(
    (projectRelative: string) => repoRelativePath(projectRelative, repo),
    [repo],
  );

  const projectFile = useCallback(
    (repoRelative: string) => projectRelativePath(repoRelative, repo),
    [repo],
  );

  const rebaseStatus = useCallback(
    <T extends StatusPaths>(status: T) => rebaseStatusPaths(status, repo),
    [repo],
  );

  const choose = useCallback(
    (path: string) => {
      if (projectName) chooseInStore(projectName, path);
    },
    [projectName, chooseInStore],
  );

  const reload = useCallback(() => {
    if (projectName) void load(projectName, true);
  }, [projectName, load]);

  // Memoised because call sites name `gitRepo` itself in a dependency array —
  // a fresh object literal every render would re-create their `useCallback`s
  // every render, and an effect depending on one of those would re-fetch in a
  // loop. Every field is already stable: the store's own values, or a
  // `useCallback` keyed on the resolved repo.
  return useMemo(
    () => ({
      repo,
      repos: discovery?.repos ?? [],
      isNested: !!discovery && !discovery.rootIsRepo && discovery.repos.length > 0,
      needsPick: needsPick(discovery, chosen),
      noRepo: hasNoRepo(discovery),
      loading,
      gitUrl,
      repoPath,
      projectFile,
      rebaseStatus,
      choose,
      reload,
    }),
    [repo, discovery, chosen, loading, gitUrl, repoPath, projectFile, rebaseStatus, choose, reload],
  );
}
