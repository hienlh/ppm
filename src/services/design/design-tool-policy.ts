import { isAbsolute, resolve } from "node:path";
import { canonicalPath, expandHome, isInside } from "../tool-path-scope.ts";

// The design and Assistant policies, and the services that judge a path the way they do, import
// these from here; the path checks themselves live in the module every tool policy shares.
export { canonicalPath, expandHome, isInside, isWindowsNonDrivePath } from "../tool-path-scope.ts";

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

/**
 * Whether a Glob pattern could match outside the folder it is rooted at: an absolute or
 * drive-qualified pattern, `~`, a `..` segment, or a brace expression that could spell one.
 * Glob expands braces before matching, so `{..,src}/**` and `.{.,}/x` reach the parent and
 * `{/etc,src}/*` an absolute root, though no segment of the text reads `..`. A brace group is
 * judged by what it holds: alternatives made only of name characters (`*.{ts,tsx}`) cannot
 * form a parent, a root or a home, so only a group holding a dot, a separator, `~` or `:` —
 * or one left unclosed, which a matcher may read either way — counts as leaving.
 *
 * The design and Assistant policies use this one; a chat an extension bound uses the stricter
 * `patternLeavesRoot` in `tool-path-scope.ts`, which refuses a `..` anywhere in the text.
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
