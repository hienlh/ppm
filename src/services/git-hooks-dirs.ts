import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandHome } from "./tool-path-scope.ts";

/**
 * The hooks folders git would run for a commit in the repository holding a path, read from
 * the files themselves rather than by spawning git on every tool call. A file written there
 * runs as the user on their next commit, which is why a tool policy refuses it.
 *
 * Covered: the repository's own config (and a linked worktree's, through its `commondir`),
 * `config.worktree`, and the user's global config. Not followed: `include`/`includeIf` and
 * the system config — a policy root should not hold those, and a missed one is no wider than
 * before this check existed.
 */

/** The last `core.hooksPath` value in one git config file's text, or null; the last one wins, as in git. */
export function hooksPathInConfig(text: string): string | null {
  let inCore = false;
  let found: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]*)\]\s*(.*)$/.exec(line);
    if (header) {
      // `[core]` only: a subsection (`[core "x"]`) or any other section is something else.
      inCore = header[1]!.trim().toLowerCase() === "core";
      line = header[2]!;
      if (!line) continue;
    }
    if (!inCore) continue;
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!entry || entry[1]!.toLowerCase() !== "hookspath") continue;
    found = configValue(entry[2]!);
  }
  return found || null;
}

/** A config value without its trailing comment or surrounding quotes. */
function configValue(raw: string): string {
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, "$1");
  return raw.replace(/\s[#;].*$/, "").trim();
}

/** The git directory and work-tree top for a path, by the nearest `.git` above it. */
function findRepository(start: string): { gitDir: string; top: string } | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return { gitDir: dotGit, top: dir };
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      return pointer ? { gitDir: resolve(dir, pointer[1]!.trim()), top: dir } : null;
    } catch {
      // Nothing named .git here.
    }
    if (dirname(dir) === dir) return null;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function repositoryConfigFiles(gitDir: string): string[] {
  const files = [join(gitDir, "config"), join(gitDir, "config.worktree")];
  const common = readText(join(gitDir, "commondir"))?.trim();
  if (common) files.push(join(resolve(gitDir, common), "config"));
  return files;
}

/** Every hooks folder a `core.hooksPath` names for the repository holding `target`. */
export function gitHooksDirs(target: string): string[] {
  const repository = findRepository(dirname(target));
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const files = [join(homedir(), ".gitconfig"), join(xdgConfig, "git", "config")];
  if (repository) files.push(...repositoryConfigFiles(repository.gitDir));
  const dirs: string[] = [];
  for (const file of files) {
    const text = readText(file);
    const value = text === null ? null : hooksPathInConfig(text);
    if (!value) continue;
    const named = expandHome(value);
    // A relative hooks path is relative to the top of the work tree the commit runs in.
    if (isAbsolute(named)) dirs.push(named);
    else if (repository) dirs.push(resolve(repository.top, named));
  }
  return dirs;
}
