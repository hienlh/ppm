/**
 * Which PPM project a panel's git root belongs to, and how to address a file
 * inside it.
 *
 * A panel is opened on the *repository*. For nearly every project that is the
 * project folder itself, but a workspace folder can be a container whose
 * children are the repositories — so the path a panel was handed is often a
 * subfolder of the project. Two things follow, and both are silent failures
 * otherwise:
 *
 * - The project name is not the basename of that path. It is the name of the
 *   registered project *containing* it, because that is what `/api/projects/:name`
 *   and `window.openTab` are keyed by; the basename fallback would build URLs
 *   for a project that does not exist and 404.
 * - A file path git reported is relative to the repository, while a tab's
 *   `filePath` is relative to the project. Opening a diff without rebasing it
 *   lands one or more directories too high and shows an empty buffer for a file
 *   that plainly exists.
 *
 * Pure on purpose: the fetch-backed wrappers live in `ppm-api.ts`.
 */

export interface ProjectRef {
  name: string;
  path: string;
}

/** Trailing separators off, backslashes to forward slashes. */
function normalizeDir(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The registered project that owns `dirPath`, or null when none does.
 *
 * Longest match wins: a project nested inside another one is the more specific
 * answer, and taking the first hit would attribute its repositories to the
 * outer project.
 */
export function pickProject(projects: ProjectRef[], dirPath: string): ProjectRef | null {
  const target = normalizeDir(dirPath);
  let best: ProjectRef | null = null;
  let bestLength = -1;
  for (const project of projects) {
    const root = normalizeDir(project.path);
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (root.length > bestLength) {
      best = project;
      bestLength = root.length;
    }
  }
  return best;
}

/**
 * A repository-relative file path, expressed relative to the project root.
 *
 * The identity when the repository *is* the project — which is the case worth
 * protecting, since it is every ordinary project.
 */
export function toProjectRelative(projectPath: string, gitRoot: string, filePath: string): string {
  const root = normalizeDir(projectPath);
  const repo = normalizeDir(gitRoot);
  const file = filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (repo === root) return file;
  if (!repo.startsWith(`${root}/`)) return file;
  const prefix = repo.slice(root.length + 1);
  return file ? `${prefix}/${file}` : prefix;
}
