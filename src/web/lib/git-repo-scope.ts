/**
 * Which repository a git surface is looking at, when the project is not one.
 *
 * A workspace folder is often a container whose *children* are the
 * repositories — a folder of checkouts, a monorepo of unrelated services. The
 * server discovers them (`GET /git/repos`) and accepts a `?repo=` scope; these
 * are the pure decisions the UI makes on top of that answer, kept out of the
 * store so they can be tested without React.
 *
 * Two rules are load-bearing:
 *
 * - **The parameter is omitted when the repository *is* the project root.**
 *   Every URL for an ordinary single-repo project stays byte-identical to what
 *   it was, so nothing about the common case can regress on this path.
 * - **A file outside the chosen repository resolves to `null`, not to a
 *   best-effort path.** `git blame -- ../docs/x.md` does not error usefully; it
 *   answers about a path the repository does not track, or reports the file as
 *   untracked, and the annotation quietly shows nothing rather than saying why.
 */

export interface GitRepoCandidate {
  path: string;
  name: string;
  /** Path relative to the project root; `.` when it is the root. */
  relative: string;
}

export interface GitRepoDiscovery {
  root: string;
  rootIsRepo: boolean;
  repos: GitRepoCandidate[];
}

/**
 * The repository to run git in, or `null` when the answer is not yet decided.
 *
 * A single candidate is chosen without asking: a picker offering one option is
 * a click that cannot go any other way.
 */
export function resolveRepo(
  discovery: GitRepoDiscovery | undefined,
  chosen: string | undefined,
): GitRepoCandidate | null {
  if (!discovery) return null;
  if (discovery.rootIsRepo) return discovery.repos[0] ?? null;
  if (chosen) {
    const match = discovery.repos.find((r) => r.path === chosen);
    if (match) return match;
  }
  return discovery.repos.length === 1 ? discovery.repos[0]! : null;
}

/** True when there is a choice to make and it has not been made. */
export function needsPick(
  discovery: GitRepoDiscovery | undefined,
  chosen: string | undefined,
): boolean {
  if (!discovery || discovery.rootIsRepo) return false;
  return discovery.repos.length > 1 && !resolveRepo(discovery, chosen);
}

/** True when nothing under the project is a repository at all. */
export function hasNoRepo(discovery: GitRepoDiscovery | undefined): boolean {
  return !!discovery && !discovery.rootIsRepo && discovery.repos.length === 0;
}

/**
 * Add `repo=` to a git URL, unless the repository is the project root — in
 * which case the URL is left exactly as it was before any of this existed.
 */
export function withRepoParam(url: string, repo: GitRepoCandidate | null): string {
  if (!repo || repo.relative === ".") return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}repo=${encodeURIComponent(repo.path)}`;
}

/**
 * Rebase a project-relative file path onto the chosen repository.
 *
 * `null` means the file is not inside it — the caller has nothing to ask git.
 */
export function repoRelativePath(
  projectRelative: string,
  repo: GitRepoCandidate | null,
): string | null {
  const path = projectRelative.replace(/^\.?\//, "");
  if (!repo || repo.relative === ".") return path;
  const prefix = `${repo.relative}/`;
  if (path === repo.relative) return "";
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length);
}

/**
 * The inverse: a path git reported, expressed relative to the project.
 *
 * `git status` run inside the repository names files relative to *it*, and a
 * tab's `filePath` is relative to the project — so opening a changed file from
 * the panel without this lands one directory too high and the editor shows an
 * empty buffer for a file that plainly exists.
 */
export function projectRelativePath(
  repoRelative: string,
  repo: GitRepoCandidate | null,
): string {
  const path = repoRelative.replace(/^\.?\//, "");
  if (!repo || repo.relative === ".") return path;
  return path ? `${repo.relative}/${path}` : repo.relative;
}

/** The shape of `GitStatus` this module needs, without importing it. */
export interface StatusPaths {
  staged: { path: string; oldPath?: string }[];
  unstaged: { path: string; oldPath?: string }[];
  untracked: string[];
}

/**
 * A status answer, with its paths moved into the project's terms.
 *
 * Only for the *file tree*, which decorates nodes keyed by project-relative
 * path. The panel's own copy stays as git reported it, because that is what
 * `stage`, `unstage`, `discard` and the hunk picker send straight back — a
 * rebased path there would name a file the repository does not have.
 */
export function rebaseStatusPaths<T extends StatusPaths>(
  status: T,
  repo: GitRepoCandidate | null,
): T {
  if (!repo || repo.relative === ".") return status;
  const move = (path: string): string => projectRelativePath(path, repo);
  const moveFile = <F extends { path: string; oldPath?: string }>(file: F): F => ({
    ...file,
    path: move(file.path),
    ...(file.oldPath ? { oldPath: move(file.oldPath) } : {}),
  });
  return {
    ...status,
    staged: status.staged.map(moveFile),
    unstaged: status.unstaged.map(moveFile),
    untracked: status.untracked.map(move),
  };
}

/**
 * Whether an extension command's path argument should be the repository rather
 * than the project folder.
 *
 * Every dispatch site hands over the active project's path, and for anything
 * that is not running git that is still the right answer — an extension was
 * told about a workspace folder, not about one checkout inside it. Only the git
 * views are re-pointed, and they are recognised by their command namespace, so
 * another extension opts in the same way.
 */
export function commandRunsGit(command: string): boolean {
  return command.startsWith("git-graph.");
}
