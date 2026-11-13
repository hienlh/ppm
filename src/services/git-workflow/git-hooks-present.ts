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
