/**
 * "Allow for this chat" on a Claude chat's approval card.
 *
 * PPM asks for approval from its own PreToolUse hook, which runs before the CLI's permission
 * rules, so the CLI's `permissions.allow` never gets a say here: the rules a person saves from a
 * card are PPM's own, checked by that hook before it asks.
 *
 * A rule is as narrow as the card could show it:
 * - a shell command is allowed by its program and subcommand (`git status`, `bun test`), and only
 *   for a command that chains, pipes, redirects or substitutes nothing — `git status; rm -rf x`
 *   matches no rule. A command that does any of those can be allowed only as that exact text;
 * - file edits (Edit, Write, MultiEdit, NotebookEdit) as one rule, as Claude Code's own
 *   "Allow edits" does;
 * - any other tool by its name (an MCP tool, WebFetch…).
 *
 * The rules live in memory for the server's life and cover one chat. A standing rule for a whole
 * project is "Allow & remember" (`src/services/remembered-approvals/`), with its deny list.
 */
export interface ApprovalRule {
  /** What is stored and matched. */
  key: string;
  /** What the card says it allows: "`git status` commands", "file edits", "WebFetch". */
  label: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools that are themselves the question, or a mode change, never a standing permission. */
const NEVER_RULED = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);
/** Anything that makes one command line run more than its first program, or write elsewhere. */
const SHELL_COMPOSITION = /[;&|`<>\n\r]|\$\(|\$\{|\$\[/;
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

function shellCommand(input: unknown): string | null {
  const c = input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

/** The program and its subcommand when there is one: `git status`, `bun test`, `ls`. */
function commandPrefix(command: string): string {
  const [program, second] = command.split(/\s+/);
  // A path to a program (`./scripts/test.sh`) takes arguments, not subcommands.
  return second && !program!.includes("/") && SUBCOMMAND.test(second) ? `${program} ${second}` : program!;
}

/** The rule a card offers for this call, or null when it offers none. */
export function approvalRuleFor(toolName: string, input: unknown): ApprovalRule | null {
  if (NEVER_RULED.has(toolName)) return null;
  if (toolName === "Bash") {
    const command = shellCommand(input);
    if (!command) return null;
    if (SHELL_COMPOSITION.test(command)) return { key: `bash-exact:${command}`, label: "this exact command" };
    const prefix = commandPrefix(command);
    return { key: `bash:${prefix}`, label: `\`${prefix}\` commands` };
  }
  if (EDIT_TOOLS.has(toolName)) return { key: "edits", label: "file edits" };
  return { key: `tool:${toolName}`, label: toolName };
}

/** Whether a saved rule key covers this call. */
export function ruleCovers(key: string, toolName: string, input: unknown): boolean {
  if (key === "edits") return EDIT_TOOLS.has(toolName);
  if (key.startsWith("tool:")) return key === `tool:${toolName}`;
  if (toolName !== "Bash") return false;
  const command = shellCommand(input);
  if (!command) return false;
  if (key.startsWith("bash-exact:")) return key === `bash-exact:${command}`;
  if (!key.startsWith("bash:") || SHELL_COMPOSITION.test(command)) return false;
  const prefix = key.slice("bash:".length).split(" ");
  const words = command.split(/\s+/);
  return prefix.every((w, i) => words[i] === w);
}

// ─── chat rules ───────────────────────────────────────────────────────────────

const chatRules = new Map<string, Set<string>>();

export function allowForChat(sessionId: string, key: string): void {
  let set = chatRules.get(sessionId);
  if (!set) chatRules.set(sessionId, (set = new Set()));
  set.add(key);
}

/** Whether a rule saved for this chat lets this call run without asking. */
export function chatAllows(sessionId: string, toolName: string, input: unknown): boolean {
  for (const key of chatRules.get(sessionId) ?? []) if (ruleCovers(key, toolName, input)) return true;
  return false;
}

/** What the approval card sends back besides yes or no. */
export interface ApprovalChoice {
  scope?: "chat";
  /** Deny: what the person wants done instead, passed to Claude as the denial's reason. */
  message?: string;
}

export function approvalChoiceFrom(data: unknown): ApprovalChoice {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  return {
    ...(d.scope === "chat" ? { scope: d.scope } : {}),
    ...(typeof d.message === "string" && d.message.trim() ? { message: d.message.trim().slice(0, 4_000) } : {}),
  };
}
