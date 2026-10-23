import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getPpmDir } from "../services/ppm-dir.ts";
import { getBackupsDir } from "../services/db-backup/db-backup-paths.ts";
import { canonicalPath, expandHome, isInside, matchesProtectedPath, patternLeavesRoot, relativeInside } from "../services/tool-path-scope.ts";
import { EXTENSION_MCP_TOOL_PREFIX, type ExtensionToolPolicy } from "../shared/extension-session-binding.ts";

/**
 * The permission decision for a chat session an extension bound with a tool policy. It is
 * exhaustive: every tool gets an explicit allow or deny, so nothing reaches an approval card
 * or a permission mode's own auto-approvals. Fail-closed throughout — anything that cannot
 * be resolved is denied with the reason the model is told.
 */
export type ExtensionToolVerdict = { decision: "allow" } | { decision: "deny"; reason: string };

/** Refused inside every write root, at any depth, on top of the policy's own list. */
export const ALWAYS_PROTECTED_PATHS: readonly string[] = [
  ".git", ".git/**", "package.json", "bun.lock", "bun.lockb", "bunfig.toml", ".claude/**", ".github/**", "node_modules/**",
];

/** Tool → the input field naming its target; Glob and Grep default to the session's directory. */
const READ_TOOLS: Record<string, { field: string; optional: boolean }> = {
  Read: { field: "file_path", optional: false }, Glob: { field: "path", optional: true }, Grep: { field: "path", optional: true },
};
const WRITE_TOOLS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
/** Questions and plan approval would wait on a person who may not be there. */
const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
/** Only loads the definitions of tools the session already has (deferred MCP tools among them). */
const ALWAYS_ALLOWED = new Set(["ToolSearch"]);

/**
 * A policy is only enforceable outside bypass mode, where the permission hook does not even
 * run: bypass (or no choice, which falls back to a provider default that is usually bypass)
 * becomes acceptEdits, whose own auto-approvals the policy then overrides tool by tool.
 */
export function clampBoundPermissionMode(mode: string | undefined): "default" | "plan" | "acceptEdits" {
  return mode === "default" || mode === "plan" ? mode : "acceptEdits";
}

const ALLOW: ExtensionToolVerdict = { decision: "allow" };
const deny = (reason: string): ExtensionToolVerdict => ({ decision: "deny", reason });

/**
 * Directories holding credentials, refused even inside a root: PPM's own (config database,
 * account tokens), its database snapshots, and the CLIs' and SSH's homes. The real home
 * directory is deliberate for the last four — those tools, not PPM, decide where they live.
 */
function credentialRoots(): string[] {
  const homeDirs = [".claude", ".codex", ".ssh", ".cloudflared"].map((dir) => resolve(homedir(), dir));
  const moved = [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME].filter((dir): dir is string => !!dir).map((dir) => resolve(dir));
  return canonicalRoots([getPpmDir(), getBackupsDir(), ...homeDirs, ...moved]);
}

function canonicalRoots(roots: readonly string[]): string[] {
  return roots.map((root) => canonicalPath(root)).filter((root): root is string => !!root);
}

/** The canonical target of a tool's path field, or a verdict when there is none to judge. */
function resolveTarget(raw: unknown, cwd: string): { resolved: string; literal: string } | ExtensionToolVerdict {
  if (typeof raw !== "string" || !raw) return deny("The tool call names no path");
  const literal = resolve(cwd, expandHome(raw));
  const resolved = canonicalPath(literal);
  if (!resolved) return deny(`${raw} cannot be resolved`);
  if (credentialRoots().some((root) => isInside(resolved, root))) return deny(`${raw} holds credentials and is off limits`);
  return { resolved, literal };
}

function readDecision(toolName: string, input: Record<string, unknown>, policy: ExtensionToolPolicy, cwd: string): ExtensionToolVerdict {
  const spec = READ_TOOLS[toolName]!;
  if (toolName === "Glob") {
    const pattern = input.pattern;
    if (typeof pattern !== "string" || !pattern || patternLeavesRoot(pattern)) return deny("The Glob pattern must stay inside the search directory");
  }
  const raw = input[spec.field];
  const target = resolveTarget(raw === undefined || raw === null || raw === "" ? (spec.optional ? cwd : raw) : raw, cwd);
  if ("decision" in target) return target;
  if (canonicalRoots(policy.readRoots).some((root) => isInside(target.resolved, root))) return ALLOW;
  return deny(`${String(raw ?? cwd)} is outside the folders this chat may read`);
}

function writeDecision(raw: unknown, policy: ExtensionToolPolicy, cwd: string): ExtensionToolVerdict {
  const target = resolveTarget(raw, cwd);
  if ("decision" in target) return target;
  const roots = canonicalRoots(policy.writeRoots).filter((root) => isInside(target.resolved, root));
  if (roots.length === 0) return deny(`${String(raw)} is outside the folders this chat may write`);
  try {
    const stat = lstatSync(target.literal);
    if (stat.isSymbolicLink()) return deny(`${String(raw)} is a symbolic link`);
    if (stat.isFile() && stat.nlink > 1) return deny(`${String(raw)} is hard-linked elsewhere`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return deny(`${String(raw)} cannot be checked`);
  }
  const patterns = [...ALWAYS_PROTECTED_PATHS, ...(policy.protectedPaths ?? [])];
  for (const root of roots) {
    const rel = relativeInside(target.resolved, root);
    if (!rel || matchesProtectedPath(rel, patterns)) return deny(`${String(raw)} is protected and cannot be written`);
  }
  return ALLOW;
}

export function extensionToolDecision(
  toolName: string,
  toolInput: unknown,
  policy: ExtensionToolPolicy,
  cwd: string,
): ExtensionToolVerdict {
  if (QUESTION_TOOLS.has(toolName)) return deny("Hãy hỏi bằng tin nhắn thường trong chat");
  const input = toolInput && typeof toolInput === "object" ? toolInput as Record<string, unknown> : {};
  if (READ_TOOLS[toolName]) return readDecision(toolName, input, policy, cwd);
  const writeField = WRITE_TOOLS[toolName];
  if (writeField) return writeDecision(input[writeField], policy, cwd);
  if (toolName.startsWith(EXTENSION_MCP_TOOL_PREFIX) || ALWAYS_ALLOWED.has(toolName)) return ALLOW;
  if (policy.allowTools?.includes(toolName)) return ALLOW;
  return deny(`${toolName} is not available in this chat`);
}
