/**
 * The repository a git surface should talk to, and the ways to address it.
 *
 * `gitUrl` builds a project-scoped git URL carrying the `repo=` scope of the
 * repository the panels are pointed at (status, log, graph, worktrees, and the
 * hunks and staging that act on what those panels list).
 *
 * A call about one file — blame, a file's diff, a blob — goes through
 * `fileScope` and `fileGitUrl` instead: a file has exactly one repository,
 * whatever Source Control is pointed at.
 *
 * For a project that *is* a repository — nearly all of them — every URL this
 * returns is byte-identical to what the call site built before, and every file
 * path is unchanged. That is deliberate: the container-folder case must not be
 * able to regress the ordinary one.
 */
import { useCallback, useEffect, useMemo } from "react";
import { projectUrl } from "@/lib/api-client";
import { useGitRepoStore } from "@/stores/git-repo-store";
import {
  hasNoRepo,
  needsPick,
  projectRelativePath,
  rebaseStatusPaths,
  fileGitScope,
  resolveRepo,
  withRepoParam,
  type FileGitScope,
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
  /** `gitUrl("/status")`, `gitUrl("/graph?max=50")` — scope included. */
  gitUrl: (suffix: string) => string;
  /**
   * Where a call about this one file goes, regardless of the choice. `undefined`
   * while discovery is pending, `null` when no repository holds the file.
   */
  fileScope: (projectRelative: string) => FileGitScope | null | undefined;
  /**
   * A git URL scoped to a `fileScope` answer's `repo` (`null`: no `repo=`). Its
   * identity follows the project only, so an effect depending on it does not
   * re-run when the choice changes.
   */
  fileGitUrl: (suffix: string, repo: GitRepoCandidate | null) => string;
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

  const fileScope = useCallback(
    (projectRelative: string) => fileGitScope(discovery, projectRelative),
    [discovery],
  );

  const fileGitUrl = useCallback(
    (suffix: string, repo: GitRepoCandidate | null) =>
      withRepoParam(`${projectUrl(projectName ?? "")}/git${suffix}`, repo),
    [projectName],
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
  //
  // The store's in-flight flag used to be one of them. It went false → true →
  // false on every mount and nothing ever read it, so all it did was hand every
  // consumer three identities where one would do — and fire the first
  // `git blame`, `git status` and file diff three times. It is gone from the
  // store entirely now rather than merely left out here. The two identities
  // that remain are the ones that mean something: before discovery answers,
  // and after.
  return useMemo(
    () => ({
      repo,
      repos: discovery?.repos ?? [],
      isNested: !!discovery && !discovery.rootIsRepo && discovery.repos.length > 0,
      needsPick: needsPick(discovery, chosen),
      noRepo: hasNoRepo(discovery),
      gitUrl,
      fileScope,
      fileGitUrl,
      projectFile,
      rebaseStatus,
      choose,
      reload,
    }),
    [repo, discovery, chosen, gitUrl, fileScope, fileGitUrl, projectFile, rebaseStatus, choose, reload],
  );
}
