// Pure resolution of the model / effort / thinking query options for the Claude
// Agent SDK. Extracted so the effort enum guard is unit-testable in isolation.
//
// Effort enum is enforced here as defense-in-depth: the CLI rejects any value
// outside this set and crashes the subprocess (notably "extra" — the app UI
// label "Extra" must map to "xhigh" before reaching this layer).

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getPpmDir } from "../services/ppm-dir.ts";
import type { McpHttpServerConfig, McpServerConfig, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMcpServer } from "../shared/assistant-settings.ts";
import {
  CLAUDE_DESIGN_MCP_SERVER, DESIGN_CHECK_TOOL_TIMEOUT_MS, type DesignMcpAccess,
} from "../services/design/mcp/design-mcp-tool.ts";
import {
  CLAUDE_TAB_TOOLS_MCP_SERVER, TAB_TOOLS_TIMEOUT_MS, type TabToolsMcpAccess,
} from "../services/tab-tools-mcp/tab-tools-mcp-tool.ts";
import { ASSISTANT_MCP_TIMEOUT_MS, type AssistantMcpAccess } from "../services/assistant-mcp/assistant-mcp-tools.ts";
import { CLAUDE_ASSISTANT_MCP_SERVER } from "../shared/assistant-tool-names.ts";
import { TAB_TOOLS } from "../shared/ppm-tools.ts";
import { CLAUDE_DB_TOOLS_MCP_SERVER, DB_TOOLS, DB_TOOLS_TIMEOUT_MS, type DbToolsMcpAccess } from "../services/db-ai-tools/db-ai-tools-tool.ts";
import {
  CLAUDE_SESSION_COLLAB_MCP_SERVER, SESSION_COLLAB_TOOLS_TIMEOUT_MS, type SessionCollabMcpAccess,
} from "../services/session-collab/session-collab-tool.ts";
import { SESSION_SERVER_TOOLS } from "../shared/session-collab.ts";
import { EFFORT_LEVELS, type EffortLevel } from "../shared/effort-status.ts";
import { EXTENSION_MCP_SERVER, EXTENSION_MCP_TOOL_PREFIX } from "../shared/extension-session-binding.ts";
import { EXTENSION_TOOL_CALL_TIMEOUT_MS } from "../shared/extension-mcp.ts";

export const VALID_EFFORT_VALUES = EFFORT_LEVELS;
export type EffortValue = EffortLevel;

export type ClaudeSettingSource = "user" | "project" | "local";

/**
 * The settings files a chat's CLI loads. `local` stays out: a project's
 * `.claude/settings.local.json` can deny tools and set `env` (an `ANTHROPIC_API_KEY` there moves
 * the chat onto another account), and the empty `settings` PPM passes cancels neither. The
 * project's own `.claude/settings.json` is loaded and can do the same; only the local file is out.
 */
export const CLAUDE_SETTING_SOURCES: readonly ClaudeSettingSource[] = ["user", "project"];

/**
 * Thinking is a tri-state carried as a nullable integer through config, the DB and
 * the WS protocol:
 *   null / undefined  → inherit: omit the option so the SDK default (adaptive) applies
 *   0                 → explicitly disabled
 *   THINKING_ADAPTIVE → on, model picks its own depth (guided by effort)
 *   > 0               → on with a fixed token budget (older models)
 *
 * The "on" sentinel is negative so it can never collide with a real token count.
 * Collapsing this to a boolean is what silently disabled thinking: an unset session
 * read back as `false`, which round-tripped into an explicit 0.
 */
export const THINKING_ADAPTIVE = -1;

/**
 * The tools the SDK runs without asking — it skips `canUseTool` for everything listed.
 *
 * In non-bypass modes only the read-only tools are listed, so write/execute tools go through
 * the permission evaluation chain → the PreToolUse hook. The design policy lists nothing:
 * the read-only list would let Read and Grep reach any path on disk and every MCP tool run
 * unasked, which is exactly what a design session's agent (fed page content it did not
 * write) must not do. The Assistant policy lists nothing for the same reason, and because its
 * one read rule depends on the path, which only the permission hook sees.
 */
export const READ_ONLY_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "ToolSearch"];

export function allowedToolsFor(p: {
  isBypass: boolean;
  agentTeams?: boolean;
  designPolicy?: boolean;
  designCheckTool?: string | null;
  assistantPolicy?: boolean;
  /** A session an extension bound with a tool policy: only the extension's own MCP tools. */
  extensionPolicy?: boolean;
}): string[] {
  if (p.assistantPolicy) return [];
  if (p.extensionPolicy) return [`${EXTENSION_MCP_TOOL_PREFIX}*`];
  if (p.designPolicy) return p.designCheckTool ? [p.designCheckTool] : [];
  const writeTools = ["Write", "Edit", "Bash", "Agent", "Skill", "TodoWrite", "AskUserQuestion"];
  const teamTools = p.agentTeams
    ? ["TeamCreate", "TeamDelete", "SendMessage", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]
    : [];
  const mcpTools = ["mcp__*"];
  return p.isBypass
    ? [...READ_ONLY_TOOLS, ...writeTools, ...teamTools, ...mcpTools]
    : [...READ_ONLY_TOOLS, ...mcpTools];
}

export interface ModelQueryOverrides {
  model?: string;
  oneMContext?: boolean;
  effort?: string;
  thinkingBudget?: number;
}

export interface ModelProviderConfig {
  model?: string;
  context_1m?: boolean;
  effort?: string;
  thinking_budget_tokens?: number;
}

export interface ResolvedModelQueryOptions {
  model?: string;
  effort?: string;
  thinking?: ThinkingConfig;
  /** Whether the 1M-context window is active — caller uses this for the betas header. */
  use1m: boolean;
}

/**
 * Map the tri-state budget onto the SDK's thinking config.
 *
 * `display` must be requested explicitly: the CLI otherwise omits reasoning content and
 * streams `thinking_delta` frames whose `thinking` field is an empty string carrying only
 * `estimated_tokens`. The model still thinks, but there is nothing to render — which is
 * exactly how the thinking blocks disappeared from chat.
 */
export function resolveThinkingConfig(
  budget: number | null | undefined,
): ThinkingConfig | undefined {
  if (budget === 0) return { type: "disabled" };
  if (budget == null || budget < 0) return { type: "adaptive", display: "summarized" };
  return { type: "enabled", budgetTokens: budget, display: "summarized" };
}

/**
 * On/off state for the UI toggle. Nothing set at either level means the SDK default
 * applies, which is adaptive thinking — so the honest answer is ON, not OFF.
 */
export function isThinkingEnabled(
  sessionBudget: number | null | undefined,
  configBudget: number | null | undefined,
): boolean {
  const effective = sessionBudget ?? configBudget;
  return effective == null ? true : effective !== 0;
}

/** The only system-prompt shape PPM sends: Claude Code's own prompt, optionally extended. */
export interface PresetSystemPromptOption {
  type: "preset";
  preset: "claude_code";
  append?: string;
}

/**
 * Compose the SDK `systemPrompt` option from the provider's "Additional Instructions"
 * (`system_prompt`), the session's own instruction block — a design session's or a PPM
 * Assistant session's, never both — and the instructions an extension bound to the session, in
 * that order.
 *
 * All are appended to the preset, never used as a replacing `custom` prompt: the setting
 * is labelled as *additional* instructions, and replacing Claude Code's prompt would drop
 * its tool-use guidance. Computed on every turn, so nothing depends on the SDK recording
 * the prompt on the session's first request.
 */
export function buildSystemPromptOption(
  additional?: string,
  session?: string,
  extension?: string,
): PresetSystemPromptOption {
  const parts = [additional, session, extension]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part);
  return parts.length
    ? { type: "preset", preset: "claude_code", append: parts.join("\n\n") }
    : { type: "preset", preset: "claude_code" };
}

/**
 * A PreToolUse hook's permission verdict in the shape the CLI actually honours.
 *
 * `hookEventName` is not decoration: the bundled CLI reads `permissionDecision` only when
 * `hookSpecificOutput.hookEventName === "PreToolUse"`, and it rejects a callback hook whose
 * output names no (or another) event with "Hook returned incorrect event name". Without
 * it, a "deny" the user clicked is not a deny. The reason travels as
 * `permissionDecisionReason`, the field the CLI reports back to the model.
 */
export function preToolUseDecision(decision: "allow" | "deny", reason?: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: decision,
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
}

/**
 * The tools that write a file, as a hook matcher. The hook checks the name again
 * (`fileWriteTarget`), so the matcher only has to keep every other tool from paying for a
 * round trip to it.
 */
export const FILE_WRITE_TOOLS_MATCHER = "Write|Edit|MultiEdit|NotebookEdit";

/** The file a Write/Edit/MultiEdit/NotebookEdit call is about to change, or null for any other call. */
export function fileWriteTarget(toolName: unknown, toolInput: unknown, cwd?: string): string | null {
  const input = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {};
  const raw = toolName === "NotebookEdit"
    ? input.notebook_path
    : toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" ? input.file_path : undefined;
  if (typeof raw !== "string" || !raw) return null;
  return isAbsolute(raw) || !cwd ? raw : resolve(cwd, raw);
}

/** The tools that run a shell command: each is bracketed with `git status` for the review. */
export const SHELL_TOOLS_MATCHER = "Bash|PowerShell";

/** A shell tool's hook call, as the change tracker needs it; null for any other tool or event. */
export function shellHookCall(hookInput: any): { phase: "begin" | "end"; toolUseId: string; cwd?: string; command?: string } | null {
  const toolUseId = hookInput?.tool_use_id;
  if (!SHELL_TOOLS_MATCHER.split("|").includes(hookInput?.tool_name) || typeof toolUseId !== "string") return null;
  const event = hookInput?.hook_event_name;
  const phase = event === "PreToolUse" ? "begin" : event === "PostToolUse" || event === "PostToolUseFailure" ? "end" : null;
  if (!phase) return null;
  const command = hookInput?.tool_input?.command;
  return {
    phase,
    toolUseId,
    cwd: typeof hookInput?.cwd === "string" ? hookInput.cwd : undefined,
    command: typeof command === "string" ? command : undefined,
  };
}

type ToolHook = (...args: any[]) => Promise<any>;

/**
 * Seconds the CLI waits for the permission hook. Its own default is ten minutes, and the hook
 * waits for the user's answer to an approval card, which takes as long as the user takes: an
 * Assistant card in particular waits until it is answered or PPM restarts. The largest value the
 * CLI can hold — it turns this into a timer, and one past 2^31 − 1 ms fires at once.
 */
export const PERMISSION_HOOK_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);

/** The permission hook, then — for a call it let through — the shell or file-write hook. */
function thenCapture(preToolUse: ToolHook, shellCommand: ToolHook, fileWrite: ToolHook): ToolHook {
  return async (...args) => {
    const verdict = await preToolUse(...args);
    if (verdict?.hookSpecificOutput?.permissionDecision === "deny") return verdict;
    if (shellHookCall(args[0])) await shellCommand(...args);
    else if (fileWriteTarget(args[0]?.tool_name, args[0]?.tool_input, args[0]?.cwd)) await fileWrite(...args);
    return verdict;
  };
}

/**
 * The tool hooks a turn's CLI is spawned with.
 *
 * The file-write hook runs in every permission mode, bypass included: it decides nothing, it
 * only keeps the session's "before" for the file (see `session-file-baselines.service.ts`),
 * and a hook is the one place that runs before the tool does — the CLI waits for it, while a
 * tool_use block on the stream can arrive after the file was already written. It runs after
 * the tool as well, to keep the state the call left (`session-file-history.ts`), which is what
 * names the turn that wrote each block. The shell hook is the same for a command, before and
 * after it (`shell-change-tracker.ts`). The permission hook stays out of bypass mode, where it
 * would only add a round trip to every tool call, so there both run as hooks of their own.
 * Elsewhere the permission hook runs them itself once it has allowed the call: a denied call
 * records nothing, and an edit made while the approval prompt was open is not put on the call.
 *
 * `userPromptSubmit` names each turn the CLI starts to the browser message that asked for it
 * (`claude-prompt-turn-binder.ts`); it decides nothing either.
 */
export function buildToolHooks(p: { isBypass: boolean; preToolUse: ToolHook; fileWrite: ToolHook; shellCommand: ToolHook; userPromptSubmit?: ToolHook }) {
  const shell = { matcher: SHELL_TOOLS_MATCHER, hooks: [p.shellCommand] };
  const fileWrite = { matcher: FILE_WRITE_TOOLS_MATCHER, hooks: [p.fileWrite] };
  return {
    PreToolUse: p.isBypass
      ? [fileWrite, shell]
      : [{ matcher: ".*", hooks: [thenCapture(p.preToolUse, p.shellCommand, p.fileWrite)], timeout: PERMISSION_HOOK_TIMEOUT_SECONDS }],
    PostToolUse: [shell, fileWrite],
    PostToolUseFailure: [shell, fileWrite],
    ...(p.userPromptSubmit ? { UserPromptSubmit: [{ hooks: [p.userPromptSubmit] }] } : {}),
  };
}

/**
 * The design MCP server (`design_check`) as the SDK's `http` server config, for a design
 * session only; `{}` otherwise, so an ordinary chat's server list is exactly what it was.
 * The bearer token is the session's capability and travels in the header, never the URL.
 */
export function designMcpServers(access: DesignMcpAccess | undefined): Record<string, McpHttpServerConfig> {
  if (!access) return {};
  return {
    [CLAUDE_DESIGN_MCP_SERVER]: {
      type: "http",
      url: access.url,
      headers: { Authorization: `Bearer ${access.token}` },
      timeout: DESIGN_CHECK_TOOL_TIMEOUT_MS,
    },
  };
}

/**
 * The tab-tools MCP server (`open_file`, `open_preview`, `open_url`, `read_terminal`,
 * `run_in_terminal`) as the SDK's `http` server config, while the user has any of them on; `{}`
 * otherwise. The token travels in the header.
 */
export function tabToolsMcpServers(access: TabToolsMcpAccess | null | undefined): Record<string, McpHttpServerConfig> {
  if (!access) return {};
  return {
    [CLAUDE_TAB_TOOLS_MCP_SERVER]: {
      type: "http",
      url: access.url,
      headers: { Authorization: `Bearer ${access.token}` },
      timeout: TAB_TOOLS_TIMEOUT_MS,
    },
  };
}

/**
 * An Assistant session's whole MCP server list: the servers the user connected for the Assistant
 * in Settings → PPM Assistant, then PPM's session tools and the PPM Assistant's own server as the
 * SDK's `http` config, written last so nothing can stand in for them. `{}` for any other session.
 * The own server's timeout is long because a query may run for minutes and a change waits for the
 * user's approval inside the call; its token travels in the header. The user's servers carry no
 * permission of their own: the Assistant policy asks before every one of their tools runs.
 */
export function assistantMcpServers(
  access: AssistantMcpAccess | null | undefined,
  servers: readonly AssistantMcpServer[] = [],
  sessionTools?: SessionCollabMcpAccess | null,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if (!server.enabled || server.name === CLAUDE_ASSISTANT_MCP_SERVER || server.name === CLAUDE_SESSION_COLLAB_MCP_SERVER) continue;
    out[server.name] = server.transport === "stdio"
      ? { type: "stdio", command: server.command, args: [...server.args], ...(Object.keys(server.env).length ? { env: { ...server.env } } : {}) }
      : { type: "http", url: server.url, ...(Object.keys(server.headers).length ? { headers: { ...server.headers } } : {}) };
  }
  Object.assign(out, sessionCollabMcpServers(sessionTools));
  if (access) {
    out[CLAUDE_ASSISTANT_MCP_SERVER] = {
      type: "http",
      url: access.url,
      headers: { Authorization: `Bearer ${access.token}` },
      timeout: ASSISTANT_MCP_TIMEOUT_MS,
    } as McpHttpServerConfig;
  }
  return out;
}

/** How long an MCP config file may outlive a CLI that never reported in (see below). */
export const MCP_CONFIG_FILE_MAX_AGE_MS = 10 * 60_000;

/** Folder of the CLI's MCP config files, inside this instance's PPM folder. */
export function mcpConfigFileDir(): string {
  return join(getPpmDir(), "claude-mcp-config");
}

/**
 * Hand the CLI its MCP servers through a file rather than its command line.
 *
 * The SDK turns `mcpServers` into `--mcp-config <JSON>`, and a process's command line is readable
 * by every local account on Linux (`/proc/<pid>/cmdline` without `hidepid`) and listed by `ps`
 * on macOS. That JSON holds bearer tokens — the Assistant's, which reaches an endpoint mounted
 * before auth, and the design and tab-tools ones — plus whatever headers and env the user gave
 * their own MCP servers. `--mcp-config` takes a file path just as well, so the servers are written
 * to a file only this user can read and the path goes on the command line instead.
 *
 * Protection: on POSIX the file is 0600 in a 0700 folder. On Windows the mode bits are ignored;
 * the file inherits the ACL of the PPM folder under the user's profile, which grants the user,
 * SYSTEM and Administrators only — the same accounts that could already read the process.
 *
 * The CLI reads the file while parsing its arguments and keeps the servers in memory (checked:
 * after deleting the file, `reconnectMcpServer` and toggling a server still work), so `release`
 * deletes it as soon as the CLI has answered its first request. Should that answer never come,
 * the file goes after `MCP_CONFIG_FILE_MAX_AGE_MS`, and every new file sweeps older leftovers —
 * a server that died in between leaves nothing behind for long.
 *
 * In-process (`sdk`) servers cannot be serialised and never reach the command line; they stay.
 */
export function moveMcpServersToConfigFile<P extends { options?: Record<string, any> }>(
  params: P,
  dir: string = mcpConfigFileDir(),
): { params: P; release: () => void } {
  const servers = params.options?.mcpServers as Record<string, { type?: string }> | undefined;
  const inProcess: Record<string, unknown> = {};
  const external: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    (server?.type === "sdk" ? inProcess : external)[name] = server;
  }
  if (Object.keys(external).length === 0) return { params, release: () => {} };

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  sweepStaleMcpConfigFiles(dir);
  const path = join(dir, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ mcpServers: external }), { mode: 0o600, flag: "wx" });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    try { unlinkSync(path); } catch { /* already gone */ }
  };
  timer = setTimeout(release, MCP_CONFIG_FILE_MAX_AGE_MS);
  timer.unref?.();

  const { mcpServers: _moved, ...rest } = params.options!;
  const options = {
    ...rest,
    ...(Object.keys(inProcess).length > 0 && { mcpServers: inProcess }),
    extraArgs: { ...(rest.extraArgs ?? {}), "mcp-config": path },
  };
  return { params: { ...params, options }, release };
}

function sweepStaleMcpConfigFiles(dir: string): void {
  const cutoff = Date.now() - MCP_CONFIG_FILE_MAX_AGE_MS;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try { if (statSync(path).mtimeMs < cutoff) unlinkSync(path); } catch { /* raced with its own release */ }
  }
}

/**
 * Never asked about before they run: they open a tab for the user to look at, read the
 * project's terminals, or type a command that runs only when the user presses Enter.
 */
export const CLAUDE_TAB_TOOLS: readonly string[] = TAB_TOOLS.map((tool) => `mcp__${CLAUDE_TAB_TOOLS_MCP_SERVER}__${tool}`);

/**
 * The database tools' MCP server (`db_query`, `open_query`, `db_execute`) as the SDK's `http`
 * server config, while a saved connection is available to the AI chat; `{}` otherwise. The
 * timeout outlasts the user's time to approve a change and the change's own run.
 */
export function dbToolsMcpServers(access: DbToolsMcpAccess | null | undefined): Record<string, McpHttpServerConfig> {
  if (!access) return {};
  return {
    [CLAUDE_DB_TOOLS_MCP_SERVER]: {
      type: "http",
      url: access.url,
      headers: { Authorization: `Bearer ${access.token}` },
      timeout: DB_TOOLS_TIMEOUT_MS,
    },
  };
}

/**
 * Never asked about before they run: `db_query` only reads, `open_query` opens a tab, and
 * `db_execute` asks the user itself — with the SQL and PPM's password, which a generic Allow
 * prompt in front of it would only repeat without either.
 */
export const CLAUDE_DB_TOOLS: readonly string[] = DB_TOOLS.map((tool) => `mcp__${CLAUDE_DB_TOOLS_MCP_SERVER}__${tool}`);

/**
 * The session tools' MCP server (`create_session`, `send_to_session`, `session_status`) as the
 * SDK's `http` server config, while one of them is on; `{}` otherwise. The timeout is fixed at the
 * longest wait the settings allow (plus an approval and a margin): the CLI keeps the timeout it
 * started with, and the SDK enforces it as a hard wall-clock limit per call.
 */
export function sessionCollabMcpServers(access: SessionCollabMcpAccess | null | undefined): Record<string, McpHttpServerConfig> {
  if (!access) return {};
  return {
    [CLAUDE_SESSION_COLLAB_MCP_SERVER]: {
      type: "http",
      url: access.url,
      headers: { Authorization: `Bearer ${access.token}` },
      timeout: SESSION_COLLAB_TOOLS_TIMEOUT_MS,
    },
  };
}

/**
 * The extension toolsets' MCP server (`ppm-ext`) as the SDK's `http` server config, for a
 * session whose binding names toolsets; `{}` otherwise. The timeout outlasts the endpoint's own
 * ten-minute ceiling on one call, so the endpoint is the one that answers. It is never part of a
 * warm spare, and needs no masking for one: a bound session never matches a spare.
 */
export function extensionMcpServers(access: { url: string; token: string } | null | undefined): Record<string, McpHttpServerConfig> {
  if (!access) return {};
  return {
    [EXTENSION_MCP_SERVER]: {
      type: "http",
      url: access.url,
      headers: { Authorization: `Bearer ${access.token}` },
      timeout: EXTENSION_TOOL_CALL_TIMEOUT_MS + 30_000,
    },
  };
}

/**
 * Never asked about before they run: creating a session asks the user itself (unless they switched
 * that off), and messaging a session is what the user allowed by leaving the tools on — a send that
 * would reach more permissions, or run past the pair limit, asks them in PPM's own card.
 */
export const CLAUDE_SESSION_COLLAB_TOOLS: readonly string[] = SESSION_SERVER_TOOLS.map((tool) => `mcp__${CLAUDE_SESSION_COLLAB_MCP_SERVER}__${tool}`);

/**
 * Spawn options as `spawnFingerprint` should compare them: the tab, database and session tools' tokens
 * blanked. A warm spare is started before its session exists, and its token is minted for the session
 * id it is given then — the one the session's own turns mint — so the token says nothing
 * the session id (which the fingerprint already leaves out) does not.
 */
export function withSessionTokenMasked<T extends Record<string, unknown>>(options: T): T {
  const servers = options.mcpServers as Record<string, McpHttpServerConfig> | undefined;
  const names = [CLAUDE_TAB_TOOLS_MCP_SERVER, CLAUDE_DB_TOOLS_MCP_SERVER, CLAUDE_SESSION_COLLAB_MCP_SERVER].filter((name) => servers?.[name]);
  if (!servers || names.length === 0) return options;
  const masked = { ...servers };
  for (const name of names) masked[name] = { ...masked[name]!, headers: { Authorization: "<session>" } };
  return { ...options, mcpServers: masked };
}

/** Resolve per-call overrides against provider config. Per-call wins, else config, else omit. */
export function buildModelQueryOptions(
  opts: ModelQueryOverrides,
  config: ModelProviderConfig,
): ResolvedModelQueryOptions {
  const baseModel = opts.model ?? config.model;
  const use1m = opts.oneMContext ?? config.context_1m ?? false;
  const model =
    baseModel && use1m && !/\[1m\]$/i.test(baseModel) ? `${baseModel}[1m]` : baseModel;

  const effort = opts.effort ?? config.effort;
  if (effort != null && !VALID_EFFORT_VALUES.includes(effort as EffortValue)) {
    throw new Error(
      `invalid effort "${effort}" — must be one of: ${VALID_EFFORT_VALUES.join(", ")}`,
    );
  }

  const thinking = resolveThinkingConfig(opts.thinkingBudget ?? config.thinking_budget_tokens);

  const out: ResolvedModelQueryOptions = { use1m: !!use1m };
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (thinking) out.thinking = thinking;
  return out;
}
