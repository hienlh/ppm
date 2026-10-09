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
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Whether a Glob pattern could match outside the folder it is rooted at: an absolute or
 * drive-qualified pattern, `~`, a `..` segment, or a brace expression that could spell one.
 * Glob expands braces before matching, so `{..,src}/**` and `.{.,}/x` reach the parent and
 * `{/etc,src}/*` an absolute root, though no segment of the text reads `..`. A brace group is
 * judged by what it holds: alternatives made only of name characters (`*.{ts,tsx}`) cannot
 * form a parent, a root or a home, so only a group holding a dot, a separator, `~` or `:` —
 * or one left unclosed, which a matcher may read either way — counts as leaving.
 */
export function patternLeavesRoot(pattern: string): boolean {
  if (isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.startsWith("~")) return true;
  if (pattern.split(/[\\/]/).includes("..")) return true;
  return braceGroupCouldLeave(pattern);
}

function braceGroupCouldLeave(pattern: string): boolean {
  let depth = 0;
  let inside = "";
  for (const ch of pattern) {
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        if (/[./\\~:]/.test(inside)) return true;
        inside = "";
      }
      continue;
    }
    if (depth > 0) inside += ch;
  }
  return depth > 0;
}

/**
 * On Windows, a path that does not start with a drive letter — `\\server\share\…`, the
 * device namespaces `\\?\…` and `\\.\…`, or their forward-slash spellings. Decided from the
 * text alone: resolving such a path opens an SMB session to whatever host it names (sending
 * the user's NTLM credentials there) and blocks the event loop while Windows gives up, so no
 * policy may touch the disk to find out what it is. Never true on other platforms, where `//x`
 * is an ordinary local path.
 */
export function isWindowsNonDrivePath(path: string, platform: string = process.platform): boolean {
  return platform === "win32" && !/^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Realpath of the path, or of its nearest existing ancestor with the missing tail
 * re-appended — a Write usually targets a file that does not exist yet, and its parent
 * directories may not either. Null when nothing along the chain resolves, and — without
 * touching the disk — for a Windows path that names no drive (see {@link isWindowsNonDrivePath}).
 */
export function canonicalPath(path: string): string | null {
  const tail: string[] = [];
  let current = resolve(path);
  if (isWindowsNonDrivePath(current)) return null;
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

export function isInside(target: string, root: string): boolean {
  const caseFold = process.platform === "win32" || process.platform === "darwin";
  const a = caseFold ? target.toLowerCase() : target;
  const b = caseFold ? root.toLowerCase() : root;
  const rel = relative(b, a);
  if (rel === "") return true;
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
