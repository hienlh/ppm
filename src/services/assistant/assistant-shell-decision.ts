import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { createLogger } from "../logger.ts";
import { assistantToolDecision, assistantToolTouchesPrivate, type AssistantPolicyContext } from "./assistant-tool-policy.ts";
import { assistantPrivateRoots } from "./assistant-private-paths.ts";
import { assistantPolicySwitches } from "./assistant-settings.service.ts";
import { classifyBashCommand } from "./readonly-shell/bash-readonly-classifier.ts";
import type { ReadonlyShellContext } from "./readonly-shell/readonly-path-check.ts";
import { ask, type ShellVerdict } from "./readonly-shell/shell-verdict.ts";
import { commandSendsOut, mcpToolSendsOut } from "./assistant-outbound-action.ts";

/**
 * The PPM Assistant's permission decisions beyond the synchronous path rules of
 * `assistant-tool-policy.ts`: a shell command PPM can show only reads runs without a card
 * (Settings → PPM Assistant → `auto_readonly_commands`), and "let the Assistant act on its own"
 * (`act_on_own`) lets the provider's own tools run in turns the user started.
 *
 * Everything is read per call — settings, project list, turn provenance — and no verdict is
 * cached, so a switch turned off takes effect at the next tool call.
 */

const log = createLogger("assistant-policy");

export type ShellKind = "bash" | "powershell";
type ShellJudge = (script: string, ctx: ReadonlyShellContext) => Promise<ShellVerdict>;

/** The shell tools a Claude Assistant session runs commands through, and the shell each speaks. */
const CLAUDE_SHELL_TOOLS: Record<string, ShellKind> = { Bash: "bash", PowerShell: "powershell" };

/** File tools the Assistant is not offered unless the user lets it act on its own. */
export const ASSISTANT_EDIT_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** Tools that name a file or folder; under act-on-its-own these still ask for a private one. */
const PATH_TOOLS = new Set(["Read", "Glob", "Grep", ...ASSISTANT_EDIT_TOOLS]);

/** Seams for tests; production code never reassigns these. */
export const shellDecisionDeps = {
  switches: assistantPolicySwitches,
  /** Whether a turn the user opened (in PPM or on Telegram) is running in one of these sessions. */
  userStarted: assistantTurnStartedByUser,
  bash: (async (script, ctx) => classifyBashCommand(script, ctx)) as ShellJudge,
  powershell: classifyPowerShell as ShellJudge,
  /** Longest a classifier may take before the command falls back to a card. */
  timeoutMs: 5_000,
};

export type AssistantDecision =
  /** Allowed by the path rules or as one of the Assistant's own tools, as before these switches. */
  | { decision: "allow"; via: "policy" }
  /** A command PPM showed only reads: runs with no card, badged as such. */
  | { decision: "allow"; via: "readonly"; reason: string }
  /** The user lets the Assistant act on its own and started this turn. */
  | { decision: "allow"; via: "act_on_own"; reason: string }
  | { decision: "ask"; reason: string };

/**
 * The verdict for one shell script, never throwing and never waiting past the timeout: anything
 * but a clean `readonly` is `ask`. No working directory is passed — the Assistant's starts inside
 * the private PPM dir and a `cd` in an earlier call moves it unseen — so a command that acts on
 * its current folder by default asks.
 */
export async function judgeShellScript(shell: ShellKind, script: string, ctx: ReadonlyShellContext): Promise<ShellVerdict> {
  const judge = shell === "bash" ? shellDecisionDeps.bash : shellDecisionDeps.powershell;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ShellVerdict>((done) => {
    timer = setTimeout(() => done(ask("the read-only check took too long")), shellDecisionDeps.timeoutMs);
  });
  try {
    const verdict = await Promise.race([judge(script, { ...ctx, cwd: undefined }), timeout]);
    return verdict?.verdict === "readonly" ? verdict : ask(verdict?.reason ?? "the read-only check gave no answer");
  } catch (err) {
    return ask(`the read-only check failed: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The context a command is judged in: the policy's roots, home and environment — never a cwd. */
function shellContext(ctx: AssistantPolicyContext): ReadonlyShellContext {
  return {
    projectRoots: ctx.projectRoots,
    home: ctx.home ?? homedir(),
    ...(ctx.env ? { env: ctx.env } : {}),
    ...(ctx.installRoot !== undefined ? { installRoot: ctx.installRoot } : {}),
  };
}

/** The decision for one Claude tool call in Assistant session `sessionId`. */
export async function assistantClaudeDecision(
  sessionId: string,
  toolName: string,
  input: unknown,
  ctx: AssistantPolicyContext,
): Promise<AssistantDecision> {
  if (assistantToolDecision(toolName, input, ctx) === "allow") return { decision: "allow", via: "policy" };
  const switches = shellDecisionDeps.switches();
  const shell = CLAUDE_SHELL_TOOLS[toolName];
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const command = typeof record.command === "string" ? record.command : null;

  let reason = shell ? "read-only commands run unasked only while that setting is on" : "outside what the Assistant may do unasked";
  if (shell && switches.autoReadonlyCommands) {
    // A background command outlives the check, and one outside the sandbox is the model asking
    // for more than a read; neither is judged.
    if (record.run_in_background === true) reason = "it runs in the background";
    else if (record.dangerouslyDisableSandbox === true) reason = "it asks to run outside the sandbox";
    else if (command === null) reason = "it names no command";
    else {
      const verdict = await judgeShellScript(shell, command, shellContext(ctx));
      if (verdict.verdict === "readonly") return { decision: "allow", via: "readonly", reason: verdict.reason };
      reason = verdict.reason;
    }
  }
  if (!switches.actOnOwn) return { decision: "ask", reason };
  if (!(await turnStartedByUser([sessionId]))) return { decision: "ask", reason: `${reason}; acting on its own applies only to turns the user started` };
  if (shell && (command === null || commandMentionsPrivateRoot(command, ctx.home ?? homedir(), ctx.env))) {
    return { decision: "ask", reason: "the command names a private folder" };
  }
  // Pushing, publishing and sending to other people still need the user, as in Full mode's own cards.
  const sendsOut = shell && command !== null ? commandSendsOut(command) : mcpToolSendsOut(toolName);
  if (sendsOut) return { decision: "ask", reason: `${sendsOut} still needs the user` };
  if (PATH_TOOLS.has(toolName) && assistantToolTouchesPrivate(toolName, input, ctx)) {
    return { decision: "ask", reason: "it reaches a private folder" };
  }
  return { decision: "allow", via: "act_on_own", reason: "the user lets the Assistant act on its own" };
}

/**
 * Whether a command's text names a private root: by full path, by its path under the home folder
 * (`.ssh`, `.ppm`, `.docker/config.json`, however the home folder is spelled — `~`, `$HOME`,
 * `%USERPROFILE%`), PPM's database file, or a `..` step, which from the Assistant's working
 * directory climbs into the PPM dir. Text only: a glob or a variable can still spell one, which
 * is why this guards acting on its own — a switch the user turns on knowingly — and never the
 * read-only shortcut, which resolves every path it allows.
 */
export function commandMentionsPrivateRoot(command: string, home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const text = fold(command).replaceAll("/dev/null", "");
  if (/(^|[^.])\.\.([/\s'"`;|&)]|$)/.test(text)) return true;
  if (/\bppm(\.[a-z0-9_-]+)?\.db\b/.test(text)) return true;
  for (const root of assistantPrivateRoots(home, env)) {
    if (text.includes(fold(root))) return true;
    const rel = relative(home, root);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && text.includes(fold(rel))) return true;
  }
  return false;
}

/** Case and separators folded; a Windows path's doubled backslashes (as Codex shows them) collapse. */
function fold(text: string): string {
  return text.toLowerCase().replace(/[\\/]+/g, "/");
}

/**
 * Whether one of the session's ids has a running turn the user opened, in PPM or on Telegram. A
 * session Codex renamed mid-turn answers to both ids for a moment, so each is asked. A turn the
 * tracker never saw open counts as not the user's: unknown never gets the looser rule.
 */
export async function assistantTurnStartedByUser(sessionIds: readonly string[]): Promise<boolean> {
  try {
    // Loaded on first use: the tracker hangs off the chat lifecycle, which a provider module must
    // not pull in as it loads.
    const { assistantTurnProvenance } = await import("./assistant-turn-provenance.ts");
    return sessionIds.some((id) => {
      const p = assistantTurnProvenance.provenance(id);
      const unseen = (p.reason ?? "").split(", ").includes("unknown");
      return !unseen && (p.startedBy === "user_ppm" || p.startedBy === "user_telegram");
    });
  } catch (err) {
    log.warn(`turn provenance unavailable, acting on its own stays off: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

function turnStartedByUser(ids: readonly string[]): Promise<boolean> {
  return Promise.resolve().then(() => shellDecisionDeps.userStarted(ids)).catch(() => false);
}

/** Whether the running turn of a session may act on its own: the switch is on and the user started it. */
export async function assistantMayActOnOwn(sessionIds: readonly string[]): Promise<boolean> {
  return shellDecisionDeps.switches().actOnOwn && (await turnStartedByUser(sessionIds));
}

/**
 * The answer for a Codex command approval, given the script unwrapped from Codex's shell (null
 * when the wrapper is not one PPM recognises): accept only what the classifier shows is a read.
 */
export async function assistantCommandApprovalVerdict(
  unwrapped: { shell: ShellKind; script: string } | null,
  ctx: AssistantPolicyContext,
): Promise<{ accept: boolean; reason: string }> {
  if (!shellDecisionDeps.switches().autoReadonlyCommands) return { accept: false, reason: "read-only commands ask while that setting is off" };
  if (!unwrapped) return { accept: false, reason: "the command is not wrapped in a shell PPM recognises" };
  const verdict = await judgeShellScript(unwrapped.shell, unwrapped.script, shellContext(ctx));
  return { accept: verdict.verdict === "readonly", reason: verdict.reason };
}

/** A debug line for a decision; never the command, which can carry secrets. */
export function logAssistantDecision(sessionId: string, tool: string, decision: string, reason: string): void {
  log.debug(`session=${sessionId} tool=${tool} ${decision}: ${reason}`);
}

/**
 * The PowerShell judge, loaded on first use: it runs PowerShell's own parser in a helper process,
 * which a host that never sees a PowerShell command should not pay for. A module that fails to
 * load answers `ask`, so PowerShell simply keeps its cards; the next call tries again.
 */
async function classifyPowerShell(script: string, ctx: ReadonlyShellContext): Promise<ShellVerdict> {
  let judge: ShellJudge;
  try {
    judge = (await import("./readonly-shell/powershell-readonly-classifier.ts")).classifyPowerShellCommand;
  } catch (err) {
    return ask(`PowerShell commands cannot be judged on this host: ${(err as Error)?.message ?? String(err)}`);
  }
  return judge(script, ctx);
}

/**
 * The audit of a tool call the Assistant ran with no card because of these switches: a session
 * trace row (the trace already holds the call's input) and a debug line without the command.
 */
export function recordAssistantAutoAllow(
  sessionId: string,
  providerId: string,
  tool: string,
  via: "readonly" | "act_on_own",
  reason: string,
  toolUseId?: string,
): void {
  logAssistantDecision(sessionId, tool, `allow via=${via}`, reason);
  void import("../session-trace/trace-recorder.ts")
    .then(({ traceServerEvent }) => traceServerEvent(sessionId, providerId, "assistant_auto_allowed", {
      tool, via, reason, ...(toolUseId ? { toolUseId } : {}),
    }))
    .catch(() => { /* the trace never breaks a chat */ });
}
