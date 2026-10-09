import { isAbsolute, resolve } from "node:path";
import { canonicalPath, expandHome, isInside, patternLeavesRoot } from "../design/design-tool-policy.ts";
import { isCredentialPath } from "../fs-credential-path-guard.ts";
import { CLAUDE_ASSISTANT_MCP_PREFIX, CLAUDE_ASSISTANT_MCP_SERVER } from "../../shared/assistant-tool-names.ts";

/**
 * Permission policy for a PPM Assistant session's Claude tools. The Assistant reads content it
 * did not write (other chats, database rows, terminal output), so anything that could carry
 * that content off the machine or change something asks first, whatever mode the composer
 * shows. Answers "allow" only for:
 *  - Read, Glob and Grep whose target resolves inside a registered project and outside every
 *    credential root (the PPM dir, `~/.cloudflared`, the database snapshots) — a project
 *    registered at the home directory must not open `~/.ppm/ppm.db` to an unasked Read;
 *  - ToolSearch and TodoWrite, which touch nothing outside the conversation;
 *  - the Assistant's own MCP tools, which ask inside their endpoint before any change.
 * Everything else — web, shell, file writes, subagents, skills, the user's own MCP servers,
 * reads anywhere else — answers "ask".
 *
 * Fail-closed like the design policy it borrows its path rules from: a path that is not a
 * string, cannot be resolved, or is relative with no known working directory answers "ask",
 * and symlinks are judged by where they point.
 */
export type AssistantToolDecision = "allow" | "ask";

/**
 * The Assistant's own MCP server key and its tools' name prefix; a user server of this name is
 * never loaded beside it.
 */
export { CLAUDE_ASSISTANT_MCP_PREFIX, CLAUDE_ASSISTANT_MCP_SERVER };

const ALWAYS_ALLOWED = new Set(["ToolSearch", "TodoWrite"]);

/** Tool → the input field naming its target; Glob and Grep default to the working directory. */
const READ_TOOLS: Record<string, { field: string; optional: boolean }> = {
  Read: { field: "file_path", optional: false },
  Glob: { field: "path", optional: true },
  Grep: { field: "path", optional: true },
};

export interface AssistantPolicyContext {
  /** The session's working directory — the Assistant's own folder, so never a project. */
  cwd?: string;
  /** Paths of every registered project, read per call so a project added mid-session counts. */
  projectRoots: readonly string[];
}

export function assistantToolDecision(
  toolName: string,
  input: unknown,
  ctx: AssistantPolicyContext,
): AssistantToolDecision {
  if (ALWAYS_ALLOWED.has(toolName) || toolName.startsWith(CLAUDE_ASSISTANT_MCP_PREFIX)) return "allow";
  const spec = READ_TOOLS[toolName];
  if (!spec || !input || typeof input !== "object") return "ask";
  const record = input as Record<string, unknown>;

  // A Glob pattern is itself a path expression: `/etc/*` or `../**` enumerates outside
  // whatever `path` names.
  if (toolName === "Glob") {
    const pattern = record.pattern;
    if (typeof pattern !== "string" || !pattern || patternLeavesRoot(pattern)) return "ask";
  }

  let target = record[spec.field];
  if (target === undefined || target === null || target === "") {
    if (!spec.optional) return "ask";
    target = ctx.cwd;
  }
  if (typeof target !== "string" || !target) return "ask";
  const expanded = expandHome(target);
  if (!isAbsolute(expanded) && !ctx.cwd) return "ask";

  const resolved = canonicalPath(ctx.cwd ? resolve(ctx.cwd, expanded) : resolve(expanded));
  if (!resolved || isCredentialPath(resolved)) return "ask";
  for (const root of ctx.projectRoots) {
    const canonicalRoot = canonicalPath(root);
    if (canonicalRoot && isInside(resolved, canonicalRoot)) return "allow";
  }
  return "ask";
}
