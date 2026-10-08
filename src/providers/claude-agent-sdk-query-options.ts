// Pure resolution of the model / effort / thinking query options for the Claude
// Agent SDK. Extracted so the effort enum guard is unit-testable in isolation.
//
// Effort enum is enforced here as defense-in-depth: the CLI rejects any value
// outside this set and crashes the subprocess (notably "extra" — the app UI
// label "Extra" must map to "xhigh" before reaching this layer).

import { isAbsolute, resolve } from "node:path";
import type { McpHttpServerConfig, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_DESIGN_MCP_SERVER, DESIGN_CHECK_TOOL_TIMEOUT_MS, type DesignMcpAccess,
} from "../services/design/mcp/design-mcp-tool.ts";
import {
  CLAUDE_OPEN_FILE_TOOL, CLAUDE_OPEN_PREVIEW_TOOL, CLAUDE_TAB_TOOLS_MCP_SERVER, TAB_TOOLS_TIMEOUT_MS, type TabToolsMcpAccess,
} from "../services/tab-tools-mcp/tab-tools-mcp-tool.ts";
import { CLAUDE_DB_TOOLS_MCP_SERVER, DB_TOOLS, DB_TOOLS_TIMEOUT_MS, type DbToolsMcpAccess } from "../services/db-ai-tools/db-ai-tools-tool.ts";

export const VALID_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortValue = (typeof VALID_EFFORT_VALUES)[number];

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
 * write) must not do.
 */
export const READ_ONLY_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "ToolSearch"];

export function allowedToolsFor(p: {
  isBypass: boolean;
  agentTeams?: boolean;
  designPolicy?: boolean;
  designCheckTool?: string | null;
}): string[] {
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
 * (`system_prompt`) and a design session's instruction block.
 *
 * Both are appended to the preset, never used as a replacing `custom` prompt: the setting
 * is labelled as *additional* instructions, and replacing Claude Code's prompt would drop
 * its tool-use guidance. Computed on every turn, so nothing depends on the SDK recording
 * the prompt on the session's first request.
 */
export function buildSystemPromptOption(
  additional?: string,
  design?: string,
): PresetSystemPromptOption {
  const parts = [additional, design]
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
 */
export function buildToolHooks(p: { isBypass: boolean; preToolUse: ToolHook; fileWrite: ToolHook; shellCommand: ToolHook }) {
  const shell = { matcher: SHELL_TOOLS_MATCHER, hooks: [p.shellCommand] };
  const fileWrite = { matcher: FILE_WRITE_TOOLS_MATCHER, hooks: [p.fileWrite] };
  return {
    PreToolUse: p.isBypass
      ? [fileWrite, shell]
      : [{ matcher: ".*", hooks: [thenCapture(p.preToolUse, p.shellCommand, p.fileWrite)] }],
    PostToolUse: [shell, fileWrite],
    PostToolUseFailure: [shell, fileWrite],
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
 * The tab-tools MCP server (`open_file`, `open_preview`) as the SDK's `http` server config,
 * while the user has the tools on; `{}` otherwise. The token travels in the header.
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

/** They only open a tab for the user to look at, so they never ask first. */
export const CLAUDE_TAB_TOOLS: readonly string[] = [CLAUDE_OPEN_FILE_TOOL, CLAUDE_OPEN_PREVIEW_TOOL];

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
 * Spawn options as `spawnFingerprint` should compare them: the tab and database tools' tokens
 * blanked. A warm spare is started before its session exists, and its token is minted for the session
 * id it is given then — the one the session's own turns mint — so the token says nothing
 * the session id (which the fingerprint already leaves out) does not.
 */
export function withSessionTokenMasked<T extends Record<string, unknown>>(options: T): T {
  const servers = options.mcpServers as Record<string, McpHttpServerConfig> | undefined;
  const names = [CLAUDE_TAB_TOOLS_MCP_SERVER, CLAUDE_DB_TOOLS_MCP_SERVER].filter((name) => servers?.[name]);
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
