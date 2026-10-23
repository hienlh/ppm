import { resolve } from "node:path";
import { canonicalPath, expandHome, isInside, patternLeavesRoot } from "../tool-path-scope.ts";

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
