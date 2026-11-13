/**
 * Which of a repository's own git hooks an operation will run, so an approval card can say so.
 * A merge, a cherry-pick or a revert runs whatever the repository keeps in its hooks folder,
 * inside PPM's process; with Husky that folder is tracked (`core.hooksPath = .husky`), so the
 * very branch being merged can carry the hook that runs. Hooks are disclosed, never switched
 * off: commits made from PPM's own screens run them too.
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runGit, toDisplay } from "../git-hunks/git-hunks.service.ts";

export interface PresentHooks {
  /** The hooks that exist, in the order asked for. */
  hooks: string[];
  /** Where they live: relative to the repository when inside it (`.husky`, `.git/hooks`), else absolute. */
  where: string;
  /**
   * Hooks the commit coming in (a merge's source, a picked or reverted commit) keeps in that
   * folder and the working tree does not have yet: git writes them while it updates the tree, then
   * runs them. Null when git could not list that commit's folder.
   */
  incoming?: string[] | null;
}

const isFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The folder whose files the hooks really are. Husky 9 points `core.hooksPath` at `.husky/_`,
 * which holds a stub for every hook name plus the `h` runner; each stub runs `.husky/<name>`
 * only when that file exists, so the stubs say nothing and the parent folder is what counts.
 */
export function effectiveHooksDir(hooksDir: string): string {
  return basename(hooksDir) === "_" && isFile(join(hooksDir, "h")) ? dirname(hooksDir) : hooksDir;
}

/** Of `names`, the hooks that exist as files in `hooksDir` (a `.sample` never matches a name). */
export function hooksIn(hooksDir: string, names: readonly string[]): string[] {
  const dir = effectiveHooksDir(hooksDir);
  return names.filter((name) => isFile(join(dir, name)));
}

/** The folder git takes hooks from: `core.hooksPath` when set, else the repository's `hooks` folder. */
export async function gitHooksDir(repoPath: string): Promise<string | null> {
  const res = await runGit(repoPath, ["rev-parse", "--git-path", "hooks"]).catch(() => null);
  if (!res || res.exitCode !== 0) return null;
  const out = toDisplay(res.stdout).trim();
  if (!out) return null;
  // A relative `core.hooksPath` is relative to the top of the working tree, which `repoPath` is.
  return isAbsolute(out) ? out : resolve(repoPath, out);
}

/**
 * The hooks of `names` this repository has, and where; null when git could not say where its
 * hooks live (the card then says they may run).
 */
export async function gitHooksPresent(repoPath: string, names: readonly string[]): Promise<PresentHooks | null> {
  const dir = await gitHooksDir(repoPath);
  if (!dir) return null;
  const real = effectiveHooksDir(dir);
  const rel = relative(resolve(repoPath), real);
  const where = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : real;
  return { hooks: hooksIn(dir, names), where };
}

/**
 * Of `names`, the hooks any of `commits` holds in the tracked hooks folder `where` (repository-
 * relative, as `gitHooksPresent` gives it), read from the commits' trees with `git ls-tree`, not
 * from the working tree. An absolute `where` is outside the repository, so no commit can bring a
 * hook there: none. Null when git could not list a commit's folder.
 */
export async function hooksInCommits(repoPath: string, commits: readonly string[], names: readonly string[], where: string): Promise<string[] | null> {
  // Outside the repository, or inside its `.git` folder: never part of a commit.
  if (!where || isAbsolute(where) || where.startsWith("..") || where === ".git" || where.startsWith(".git/")) return [];
  const found = new Set<string>();
  for (const commit of commits) {
    const res = await runGit(repoPath, ["ls-tree", "--name-only", commit, "--", `${where}/`], { env: { GIT_LITERAL_PATHSPECS: "1" } }).catch(() => null);
    if (!res || res.exitCode !== 0) return null;
    for (const line of toDisplay(res.stdout).split("\n")) {
      const name = line.trim().split("/").pop();
      if (name) found.add(name);
    }
  }
  return names.filter((name) => found.has(name));
}
