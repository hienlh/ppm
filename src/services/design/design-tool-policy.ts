import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Permission policy for a design session in `acceptEdits` mode: file reads, searches,
 * writes and edits are auto-approved while their target resolves inside the project, and
 * every other tool — shell, web, MCP, subagents, anything unknown — goes to the user.
 *
 * Fail-closed throughout: a missing project root, a path that is not a string, or a path
 * that cannot be resolved all answer "ask". The check follows symlinks (realpath), so a
 * link inside the project pointing outside it is treated as the outside path it is.
 */
export type DesignToolDecision = "allow" | "ask";

/** Tool → the input field naming its target, and whether that field may be omitted
 *  (Glob/Grep default to the session cwd, which is the project root). */
const FILE_TOOLS: Record<string, { field: string; optional: boolean }> = {
  Read: { field: "file_path", optional: false },
  Write: { field: "file_path", optional: false },
  Edit: { field: "file_path", optional: false },
  Glob: { field: "path", optional: true },
  Grep: { field: "path", optional: true },
};

export function designToolDecision(
  toolName: string,
  input: unknown,
  projectPath: string | undefined,
): DesignToolDecision {
  const spec = FILE_TOOLS[toolName];
  if (!spec || !projectPath) return "ask";
  if (!input || typeof input !== "object") return "ask";
  const record = input as Record<string, unknown>;

  const root = canonicalPath(projectPath);
  if (!root) return "ask";

  // Glob's pattern is itself a path expression: `../../**` or `/etc/*` would enumerate
  // outside the project even with no `path` given.
  if (toolName === "Glob") {
    const pattern = record.pattern;
    if (typeof pattern !== "string" || !pattern || patternLeavesRoot(pattern)) return "ask";
  }

  const target = record[spec.field];
  if (target === undefined || target === null || target === "") {
    return spec.optional ? "allow" : "ask";
  }
  if (typeof target !== "string") return "ask";

  const resolved = canonicalPath(resolve(projectPath, expandHome(target)));
  if (!resolved) return "ask";
  return isInside(resolved, root) ? "allow" : "ask";
}

/** `~` is expanded the way a shell would, so `~/.ssh` is judged as the home directory it
 *  names rather than as a folder called `~` inside the project. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function patternLeavesRoot(pattern: string): boolean {
  if (isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.startsWith("~")) return true;
  return pattern.split(/[\\/]/).includes("..");
}

/**
 * Realpath of the path, or of its nearest existing ancestor with the missing tail
 * re-appended — a Write usually targets a file that does not exist yet, and its parent
 * directories may not either. Null when nothing along the chain resolves.
 */
function canonicalPath(path: string): string | null {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      // Something is there but cannot be resolved — typically a dangling symlink, which
      // a Write would follow to wherever it points. Only a truly absent entry may be
      // replaced by its parent.
      if (entryExists(current)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      tail.push(basename(current));
      current = parent;
    }
  }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isInside(target: string, root: string): boolean {
  const caseFold = process.platform === "win32" || process.platform === "darwin";
  const a = caseFold ? target.toLowerCase() : target;
  const b = caseFold ? root.toLowerCase() : root;
  const rel = relative(b, a);
  if (rel === "") return true;
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
