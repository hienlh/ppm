import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { canonicalPath, expandHome, isInside, patternLeavesRoot } from "../design/design-tool-policy.ts";
import { ASSISTANT_TOOLS, CLAUDE_ASSISTANT_MCP_PREFIX, CLAUDE_ASSISTANT_MCP_SERVER, claudeAssistantToolName } from "../../shared/assistant-tool-names.ts";
import { assistantPrivateRoots, isAssistantPrivatePath, privateRootWithin } from "./assistant-private-paths.ts";

/**
 * Permission policy for a PPM Assistant session's Claude tools. The Assistant reads content it
 * did not write (other chats, database rows, terminal output), so anything that could carry
 * that content off the machine or change something asks first, whatever mode the composer
 * shows. Answers "allow" only for:
 *  - Read, Glob and Grep whose target resolves inside a registered project and outside every
 *    private root (`assistant-private-paths.ts`: the PPM dir, `~/.cloudflared`, the database
 *    snapshots, and the credential stores common tools keep under the home folder) — a project
 *    registered at the home directory must not open `~/.ppm/ppm.db` or `~/.ssh` to an unasked
 *    Read. A Glob or Grep searches everything below its folder, so one whose folder *holds* a
 *    private root asks too;
 *  - ToolSearch and TodoWrite, which touch nothing outside the conversation;
 *  - the Assistant's own MCP tools, by exact name, which ask inside their endpoint before any change.
 * Everything else — web, shell, file writes, subagents, skills, the user's own MCP servers,
 * reads anywhere else — answers "ask".
 *
 * Fail-closed like the design policy it borrows its path rules from: a path that is not a
 * string, cannot be resolved, names no drive on Windows (a network share, which is never
 * resolved), or is relative with no known working directory answers "ask", and symlinks are
 * judged by where they point.
 *
 * Links *below* a Glob or Grep folder need no scan: the bundled Claude Code CLI runs both tools
 * on ripgrep without `--follow` (Glob: `--files --glob <p> --sort=modified --no-ignore --hidden`;
 * Grep: `--hidden`, VCS excludes, `--max-columns 500`, the output flags), and ripgrep then skips
 * every link it meets while walking. Measured with the CLI's own ripgrep 14.1.1 (SDK 0.3.280):
 * a file symlink, a directory symlink and a Windows junction inside a project, each pointing
 * out of it, are neither listed nor searched, while the same run with `--follow` reaches all
 * three. Only the folder named on the command line is followed, and that one is judged by its
 * real location below. The exception is a ripgrep config file, which can add `--follow` to every
 * search: the embedded ripgrep honours `RIPGREP_CONFIG_PATH`. An Assistant session's CLI is
 * started without that variable (`buildQueryEnv`), and the check below stays as a second line:
 * should the CLI's environment ever carry it, Glob and Grep ask.
 */
export type AssistantToolDecision = "allow" | "ask";

/**
 * The Assistant's own MCP server key and its tools' name prefix; a user server of this name is
 * never loaded beside it.
 */
export { CLAUDE_ASSISTANT_MCP_PREFIX, CLAUDE_ASSISTANT_MCP_SERVER };

const ALWAYS_ALLOWED = new Set(["ToolSearch", "TodoWrite"]);

/**
 * The Assistant's tools as Claude names them, matched whole. A prefix test would also pass a
 * user server named `ppm-assistant_`, whose tools Claude spells `mcp__ppm-assistant___<tool>`.
 */
const OWN_MCP_TOOLS: ReadonlySet<string> = new Set(ASSISTANT_TOOLS.map(claudeAssistantToolName));

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
  /** The home folder whose credential stores always ask; the real one unless a test names another. */
  home?: string;
  /** The environment the CLI inherits; this process's unless a test names another. */
  env?: NodeJS.ProcessEnv;
}

export function assistantToolDecision(
  toolName: string,
  input: unknown,
  ctx: AssistantPolicyContext,
): AssistantToolDecision {
  if (ALWAYS_ALLOWED.has(toolName) || OWN_MCP_TOOLS.has(toolName)) return "allow";
  const spec = READ_TOOLS[toolName];
  if (!spec || !input || typeof input !== "object") return "ask";
  const record = input as Record<string, unknown>;

  // A Glob pattern is itself a path expression: `/etc/*`, `../**` or `{..,x}/**` enumerates
  // outside whatever `path` names.
  // A ripgrep config may turn on `--follow`, after which links below the folder lead anywhere.
  if (toolName !== "Read" && (ctx.env ?? process.env).RIPGREP_CONFIG_PATH) return "ask";
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
  if (!resolved) return "ask";
  const privateRoots = assistantPrivateRoots(ctx.home ?? homedir());
  if (isAssistantPrivatePath(resolved, privateRoots)) return "ask";
  // Glob and Grep walk the whole tree below their folder; Read on a file walks nothing.
  if (toolName !== "Read" && privateRootWithin(resolved, privateRoots)) return "ask";
  for (const root of ctx.projectRoots) {
    const canonicalRoot = canonicalPath(root);
    if (canonicalRoot && isInside(resolved, canonicalRoot)) return "allow";
  }
  return "ask";
}
