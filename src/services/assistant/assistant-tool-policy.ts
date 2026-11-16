import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalPath, isInside, patternLeavesRoot } from "../design/design-tool-policy.ts";
import { ASSISTANT_TOOLS, CLAUDE_ASSISTANT_MCP_PREFIX, CLAUDE_ASSISTANT_MCP_SERVER, claudeAssistantToolName } from "../../shared/assistant-tool-names.ts";
import { CLAUDE_SESSION_COLLAB_MCP_SERVER, SESSION_COLLAB_TOOLS } from "../../shared/session-collab.ts";
import { VAULT_TOOLS } from "../../shared/vault.ts";
import { PPM_TASK_TOOLS } from "../../shared/ppm-task-tools.ts";
import { assistantPrivateScope, isAssistantPrivatePath, privateRootWithin, type AssistantPrivateScope } from "./assistant-private-paths.ts";
import { assistantReadRoots } from "./readonly-shell/readonly-path-check.ts";

/**
 * Permission policy for a PPM Assistant session's Claude tools. The Assistant reads content it
 * did not write (other chats, database rows, terminal output), so anything that could carry
 * that content off the machine or change something asks first, whatever mode the composer
 * shows. Answers "allow" only for:
 *  - Read, Glob and Grep whose target resolves inside a registered project (or PPM's own install
 *    folder, `assistantReadRoots`) and outside every private root (`assistant-private-paths.ts`: the PPM dir, `~/.cloudflared`, the database
 *    snapshots, the credential stores common tools keep under the home folder, `/proc`, `/sys`
 *    and `/dev`, and — while the only project holding them is the home folder or above — the
 *    home folder's dot-entries, `Library` and `AppData`) — a project registered at the home
 *    directory must not open `~/.ppm/ppm.db`, `~/.ssh` or a browser's saved logins to an unasked
 *    Read. A Glob or Grep searches everything below its folder, so one whose folder *holds* a
 *    private root, or the home folder, asks too;
 *  - ToolSearch and TodoWrite, which touch nothing outside the conversation;
 *  - the Assistant's own MCP tools and PPM's session tools, by exact name, which ask inside their
 *    endpoint before any change.
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
const OWN_MCP_TOOLS: ReadonlySet<string> = new Set([
  ...ASSISTANT_TOOLS.map(claudeAssistantToolName),
  // PPM's session tools, which ask the user inside their endpoint before every create or message.
  ...SESSION_COLLAB_TOOLS.map((tool) => `mcp__${CLAUDE_SESSION_COLLAB_MCP_SERVER}__${tool}`),
  // The vault's tools, which ask the user on a card (with the tier's password) before any locked read.
  ...VAULT_TOOLS.map((tool) => `mcp__${CLAUDE_SESSION_COLLAB_MCP_SERVER}__${tool}`),
  // PPM's task store, whose every change is recorded, undoable and (unattended) put on a card.
  ...PPM_TASK_TOOLS.map((tool) => `mcp__${CLAUDE_SESSION_COLLAB_MCP_SERVER}__${tool}`),
]);

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
  /** PPM's install folder: undefined → found from this module's location, null → none (tests). */
  installRoot?: string | null;
}

/** The file tools' input field naming the file they write. */
const WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

interface ResolvedTarget {
  resolved: string;
  /** Registered projects plus the install folder when it qualifies, as real paths. */
  roots: string[];
  scope: AssistantPrivateScope;
  /** Glob and Grep walk the whole tree below their folder; Read on a file walks nothing. */
  recursive: boolean;
}

export function assistantToolDecision(
  toolName: string,
  input: unknown,
  ctx: AssistantPolicyContext,
): AssistantToolDecision {
  if (ALWAYS_ALLOWED.has(toolName) || OWN_MCP_TOOLS.has(toolName)) return "allow";
  const target = readTarget(toolName, input, ctx);
  if (!target) return "ask";
  const { resolved, roots, scope, recursive } = target;
  if (isAssistantPrivatePath(resolved, scope)) return "ask";
  if (recursive && privateRootWithin(resolved, scope)) return "ask";
  return roots.some((root) => isInside(resolved, root)) ? "allow" : "ask";
}

/**
 * Whether a Read, Glob, Grep or file write may reach a private root: what still asks when the
 * user has let the Assistant act on its own, wherever else the target lies. True for every other
 * tool and for any target that cannot be resolved with certainty, since unsure means private.
 */
export function assistantToolTouchesPrivate(toolName: string, input: unknown, ctx: AssistantPolicyContext): boolean {
  const field = WRITE_TOOLS[toolName];
  const target = field ? writeTarget(field, input, ctx) : readTarget(toolName, input, ctx);
  if (!target) return true;
  return isAssistantPrivatePath(target.resolved, target.scope) || (target.recursive && !!privateRootWithin(target.resolved, target.scope));
}

/** Where a Read, Glob or Grep call reads, resolved; null when that cannot be told with certainty. */
function readTarget(toolName: string, input: unknown, ctx: AssistantPolicyContext): ResolvedTarget | null {
  const spec = READ_TOOLS[toolName];
  if (!spec || !input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;

  // A Glob pattern is itself a path expression: `/etc/*`, `../**` or `{..,x}/**` enumerates
  // outside whatever `path` names.
  // A ripgrep config may turn on `--follow`, after which links below the folder lead anywhere.
  if (toolName !== "Read" && (ctx.env ?? process.env).RIPGREP_CONFIG_PATH) return null;
  if (toolName === "Glob") {
    const pattern = record.pattern;
    if (typeof pattern !== "string" || !pattern || patternLeavesRoot(pattern)) return null;
  }
  return resolveTarget(record[spec.field], spec.optional, toolName !== "Read", ctx);
}

/** Where a file write lands; a file that does not exist yet resolves through its nearest folder. */
function writeTarget(field: string, input: unknown, ctx: AssistantPolicyContext): ResolvedTarget | null {
  if (!input || typeof input !== "object") return null;
  return resolveTarget((input as Record<string, unknown>)[field], false, false, ctx);
}

function resolveTarget(raw: unknown, optional: boolean, recursive: boolean, ctx: AssistantPolicyContext): ResolvedTarget | null {
  const home = ctx.home ?? homedir();
  if (raw !== undefined && raw !== null && typeof raw !== "string") return null;
  let target = typeof raw === "string" ? cliPath(raw, home) : null;
  if (target === null) {
    if (!optional) return null;
    target = ctx.cwd ?? null;
  }
  if (!target) return null;
  if (!isAbsolute(target) && !ctx.cwd) return null;

  const resolved = canonicalPath(ctx.cwd ? resolve(ctx.cwd, target) : resolve(target));
  if (!resolved) return null;
  const roots = assistantReadRoots(ctx.projectRoots, { home, installRoot: ctx.installRoot });
  // The install folder counts as a project for the home-state rule too, so PPM installed under
  // `~/.bun` stays readable while a project registered at the home folder keeps the rest of
  // `~/.bun` private.
  const scope = assistantPrivateScope({ projectRoots: roots, home });
  return { resolved, roots, scope, recursive };
}

/**
 * The folders a Codex turn acting on its own may write in: each registered project as its real
 * path, minus any that is, lies inside or holds a private root (the PPM dir, a credential store,
 * the home folder's application state) and any that cannot be resolved. Read per turn, so a
 * project added or removed counts from the next one.
 */
export function assistantWritableRoots(projectRoots: readonly string[], opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const real = [...new Set(projectRoots.map(canonicalPath).filter((r): r is string => !!r))];
  const scope = assistantPrivateScope({ projectRoots: real, home: opts.home ?? homedir(), ...(opts.env ? { env: opts.env } : {}) });
  return real.filter((root) => !isAssistantPrivatePath(root, scope) && !privateRootWithin(root, scope));
}

/**
 * The path the Claude Code CLI will actually open for a Read/Glob/Grep target, spelled the way
 * its own path expansion spells it: surrounding whitespace dropped, `~` and `~/…` taken as the
 * home folder, and on Windows a Git Bash spelling `/c/…` taken as drive `C:`. Judging the raw
 * text instead would resolve `" /home/u/.ssh"` as a relative name inside the working directory
 * while the CLI reads `~/.ssh`. Null for a blank value, which the CLI treats as no path at all.
 */
export function cliPath(raw: string, home: string, platform: string = process.platform): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || (platform === "win32" && trimmed.startsWith("~\\"))) return join(home, trimmed.slice(2));
  const drive = platform === "win32" ? /^\/([a-z])\//i.exec(trimmed) : null;
  if (drive) return `${drive[1]!.toUpperCase()}:\\${trimmed.slice(3).replace(/\//g, "\\")}`;
  return trimmed;
}
