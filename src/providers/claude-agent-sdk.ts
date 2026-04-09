import {
  query,
  listSessions as sdkListSessions,
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AIProvider,
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
  ModelOption,
} from "./provider.interface.ts";
import { configService } from "../services/config.service.ts";
import { mcpConfigService } from "../services/mcp-config.service.ts";
import { updateFromSdkEvent } from "../services/claude-usage.service.ts";
import { getSessionMapping, getSessionProjectPath, setSessionMapping, getSessionTitles } from "../services/db.service.ts";
import { accountSelector } from "../services/account-selector.service.ts";
import { accountService } from "../services/account.service.ts";
import { resolve } from "node:path";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const CLAUDE_PROJECTS_DIR = resolve(homedir(), ".claude/projects");

function getSdkSessionId(ppmId: string): string {
  return getSessionMapping(ppmId) ?? ppmId;
}

// ── Streaming Input: message channel for persistent query ──

interface MessageController {
  push(msg: any): void;
  done(): void;
}

function createMessageChannel(): {
  generator: AsyncGenerator<any, void, undefined>;
  controller: MessageController;
} {
  const queue: any[] = [];
  let resolve: ((msg: any) => void) | null = null;
  let isDone = false;

  async function* gen(): AsyncGenerator<any, void, undefined> {
    while (!isDone) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        const msg = await new Promise<any>((r) => { resolve = r; });
        if (!isDone) yield msg;
      }
    }
  }

  return {
    generator: gen(),
    controller: {
      push(msg: any) {
        if (isDone) return;
        if (resolve) {
          const r = resolve;
          resolve = null;
          r(msg);
        } else {
          queue.push(msg);
        }
      },
      done() {
        isDone = true;
        if (resolve) {
          const r = resolve;
          resolve = null;
          r(null); // Unblock pending promise; isDone prevents yield
        }
      },
    },
  };
}

/** Build a MessageParam with optional image content blocks */
function buildMessageParam(
  text: string,
  images?: Array<{ data: string; mediaType: string }>,
): { role: 'user'; content: string | any[] } {
  if (!images || images.length === 0) {
    return { role: 'user' as const, content: text };
  }
  const blocks: any[] = [];
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    });
  }
  if (text.trim()) {
    blocks.push({ type: 'text', text });
  }
  return { role: 'user' as const, content: blocks };
}

interface StreamingSession {
  meta: Session;
  query: any;
  controller: MessageController;
}

/**
 * Pending approval: canUseTool callback creates a promise,
 * yields an approval_request event, then awaits resolution from FE.
 */
interface PendingApproval {
  resolve: (result: { approved: boolean; data?: unknown }) => void;
}

/**
 * AI provider using @anthropic-ai/claude-agent-sdk.
 * Sessions are persisted by Claude Code itself (~/.claude/projects/).
 * Uses canUseTool callback for tool approvals and AskUserQuestion.
 */
export class ClaudeAgentSdkProvider implements AIProvider {
  id = "claude";
  name = "Claude";

  private activeSessions = new Map<string, Session>();
  private messageCount = new Map<string, number>();
  /** Pending approval promises keyed by requestId */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Active query objects for abort support */
  private activeQueries = new Map<string, { close: () => void }>();
  /** Fork source: ppmSessionId → sourceSessionId (used on first message to fork) */
  private forkSources = new Map<string, string>();
  /** Streaming sessions: persistent query + message channel per session */
  private streamingSessions = new Map<string, StreamingSession>();

  /** Auth-related env keys for diagnostic logging */
  private readonly AUTH_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];

  /**
   * Build env for SDK query.
   * Priority: PPM settings (accounts + base_url) > shell env > "" (block project .env).
   * Auth env vars are ALWAYS explicitly set so the SDK subprocess never falls back
   * to reading the project's .env file (which may contain unrelated API keys).
   */
  private buildQueryEnv(
    _projectPath: string | undefined,
    account: { id: string; accessToken: string } | null,
  ): Record<string, string | undefined> {
    const base: Record<string, string | undefined> = { ...process.env };

    // Settings base_url has highest priority
    const providerConfig = this.getProviderConfig();

    // Priority: settings api_key > account token > shell env > "" (blocks project .env)
    const settingsApiKey = providerConfig.api_key?.trim() || "";

    let resolvedApiKey: string;
    let resolvedOAuth: string;

    if (settingsApiKey) {
      // Settings api_key overrides everything — treat as direct API key
      resolvedApiKey = settingsApiKey;
      resolvedOAuth = "";
    } else if (account) {
      resolvedApiKey = account.accessToken.startsWith("sk-ant-oat") ? "" : account.accessToken;
      resolvedOAuth = account.accessToken.startsWith("sk-ant-oat") ? account.accessToken : "";
    } else {
      resolvedApiKey = process.env.ANTHROPIC_API_KEY ?? "";
      resolvedOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
    }

    // Detect self-referencing proxy: if shell env has ANTHROPIC_BASE_URL pointing to
    // PPM's own /proxy endpoint (e.g. from `export` in the same shell), the SDK subprocess
    // would call PPM's proxy instead of the real Anthropic API → infinite 401 loop.
    const shellBaseUrl = process.env.ANTHROPIC_BASE_URL ?? "";
    const isSelfProxy = shellBaseUrl.includes("/proxy");
    if (isSelfProxy && shellBaseUrl) {
      console.warn(`[sdk] Ignoring self-referencing ANTHROPIC_BASE_URL from shell: ${shellBaseUrl}`);
    }
    const resolvedBaseUrl = providerConfig.base_url
      || (isSelfProxy ? "" : shellBaseUrl)
      || "";
    // Also clear API key from shell if it was paired with the self-referencing proxy URL
    // (it's likely a PPM proxy token, not a real Anthropic key)
    if (isSelfProxy && !settingsApiKey && !account && process.env.ANTHROPIC_API_KEY) {
      resolvedApiKey = "";
      resolvedOAuth = "";
      console.warn(`[sdk] Clearing shell ANTHROPIC_API_KEY (paired with self-referencing proxy)`);
    }
    const resolvedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN ?? "";

    // Log resolved sources
    if (settingsApiKey) {
      console.log(`[sdk] Auth from settings api_key (length=${settingsApiKey.length})`);
    } else if (account) {
      console.log(`[sdk] Auth from PPM account (${account.accessToken.startsWith("sk-ant-oat") ? "OAuth" : "API key"})`);
    } else if (process.env.ANTHROPIC_API_KEY && !isSelfProxy) {
      console.log(`[sdk] ANTHROPIC_API_KEY from shell env (length=${process.env.ANTHROPIC_API_KEY.length})`);
    }
    if (providerConfig.base_url) {
      console.log(`[sdk] ANTHROPIC_BASE_URL from settings: ${providerConfig.base_url}`);
    } else if (shellBaseUrl && !isSelfProxy) {
      console.log(`[sdk] ANTHROPIC_BASE_URL from shell env: ${shellBaseUrl}`);
    }

    // Enable experimental agent teams if toggled on in provider settings
    const agentTeamsEnv = providerConfig.agent_teams
      ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", CLAUDE_CODE_ENABLE_TASKS: "1" }
      : {};

    return {
      ...base,
      ANTHROPIC_API_KEY: resolvedApiKey,
      CLAUDE_CODE_OAUTH_TOKEN: resolvedOAuth,
      ANTHROPIC_BASE_URL: resolvedBaseUrl,
      ANTHROPIC_AUTH_TOKEN: resolvedAuthToken,
      ...agentTeamsEnv,
    };
  }

  /**
   * Parse SDK result event to detect 429 or 401.
   * Only detects pre-stream errors (result event on first response).
   */
  private detectResultErrorCode(event: unknown): 429 | 401 | null {
    if (!event || typeof event !== "object") return null;
    const e = event as Record<string, unknown>;
    if (e.type === "result" && e.subtype === "error_during_execution") {
      // SDK uses `errors: string[]` array for error details
      const errorsArr = Array.isArray(e.errors) ? (e.errors as string[]).join(" ") : "";
      const msg = errorsArr || String(e.error ?? "");
      if (msg.includes("429") || msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("overloaded")) return 429;
      if (msg.includes("401") || msg.toLowerCase().includes("unauthorized") || msg.toLowerCase().includes("invalid api key")) return 401;
    }
    return null;
  }

  /** Extract text content from an SDK assistant message */
  private extractAssistantText(msg: unknown): string {
    const content = (msg as any)?.message?.content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((b: any) => b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
  }

  /** Read current provider config from yaml (fresh each call) */
  private getProviderConfig(): Partial<import("../types/config.ts").AIProviderConfig> {
    const ai = configService.get("ai");
    const providerId = ai.default_provider ?? "claude";
    return ai.providers[providerId] ?? {};
  }

  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    const meta: Session = {
      id,
      providerId: this.id,
      title: config.title ?? "New Chat",
      projectName: config.projectName,
      projectPath: config.projectPath,
      createdAt: new Date().toISOString(),
    };
    this.activeSessions.set(id, meta);
    this.messageCount.set(id, 0);
    // Pre-persist mapping so project_path survives server restarts
    setSessionMapping(id, id, config.projectName, config.projectPath);
    return meta;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const existing = this.activeSessions.get(sessionId);
    if (existing) return existing;

    // Check if we have a mapped SDK session ID (from a previous query)
    const mappedSdkId = getSdkSessionId(sessionId);
    // Restore project_path from DB so resumed sessions can find JSONL
    const dbProjectPath = getSessionProjectPath(sessionId) ?? undefined;

    // Try targeted lookup first (searches all project dirs), then fall back to list scan
    try {
      const lookupId = mappedSdkId ?? sessionId;
      const info = await sdkGetSessionInfo(lookupId, { dir: dbProjectPath });
      if (!info && mappedSdkId) {
        // Try the original PPM session ID as well
        const info2 = await sdkGetSessionInfo(sessionId, { dir: dbProjectPath });
        if (info2) {
          const meta: Session = {
            id: sessionId,
            providerId: this.id,
            title: info2.customTitle ?? info2.summary ?? "Resumed Chat",
            projectPath: dbProjectPath,
            createdAt: new Date(info2.lastModified).toISOString(),
          };
          this.activeSessions.set(sessionId, meta);
          this.messageCount.set(sessionId, 1);
          return meta;
        }
      }
      if (info) {
        const meta: Session = {
          id: sessionId,
          providerId: this.id,
          title: info.customTitle ?? info.summary ?? "Resumed Chat",
          projectPath: dbProjectPath,
          createdAt: new Date(info.lastModified).toISOString(),
        };
        this.activeSessions.set(sessionId, meta);
        this.messageCount.set(sessionId, 1);
        return meta;
      }
    } catch {
      // SDK not available
    }

    // Session not found in SDK list — it may still have a JSONL on disk
    // (sdkListSessions may not search the correct project directory).
    // Use messageCount=1 so sendMessage uses --resume instead of --session-id.
    // --resume gracefully fails if no JSONL exists, while --session-id crashes
    // when a JSONL file for the same ID is already present on disk.
    const meta: Session = {
      id: sessionId,
      providerId: this.id,
      title: "Resumed Chat",
      projectPath: dbProjectPath,
      createdAt: new Date().toISOString(),
    };
    this.activeSessions.set(sessionId, meta);
    this.messageCount.set(sessionId, 1);
    return meta;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.listSessionsByDir();
  }

  async listSessionsByDir(dir?: string, opts?: { limit?: number; offset?: number }): Promise<SessionInfo[]> {
    try {
      const limit = opts?.limit ?? 50;
      const offset = opts?.offset ?? 0;
      const sdkSessions = await sdkListSessions({ dir, limit, offset });
      // Overlay DB titles (user-set) over SDK titles
      const ids = sdkSessions.map((s) => s.sessionId);
      const dbTitles = getSessionTitles(ids);
      return sdkSessions.map((s) => ({
        id: s.sessionId,
        providerId: this.id,
        title: dbTitles[s.sessionId] ?? s.customTitle ?? s.summary ?? s.firstPrompt ?? "Chat",
        createdAt: new Date(s.lastModified).toISOString(),
        updatedAt: new Date(s.lastModified).toISOString(),
      }));
    } catch {
      return Array.from(this.activeSessions.values()).map((s) => ({
        id: s.id,
        providerId: s.providerId,
        title: s.title,
        projectName: s.projectName,
        createdAt: s.createdAt,
      }));
    }
  }

  async getSessionInfoById(sessionId: string, dir?: string): Promise<SessionInfo | null> {
    try {
      const info = await sdkGetSessionInfo(sessionId, { dir });
      if (!info) return null;
      const dbTitles = getSessionTitles([info.sessionId]);
      return {
        id: info.sessionId,
        providerId: this.id,
        title: dbTitles[info.sessionId] ?? info.customTitle ?? info.summary ?? info.firstPrompt ?? "Chat",
        createdAt: new Date(info.lastModified).toISOString(),
        updatedAt: new Date(info.lastModified).toISOString(),
      };
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.closeStreamingSession(sessionId);
    this.activeSessions.delete(sessionId);
    this.messageCount.delete(sessionId);
    this.pendingApprovals.delete(sessionId);
    this.forkSources.delete(sessionId);

    // Best-effort: delete JSONL from ~/.claude/projects/
    const sdkId = getSessionMapping(sessionId) ?? sessionId;
    try {
      if (existsSync(CLAUDE_PROJECTS_DIR)) {
        const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
        for (const dir of projectDirs) {
          if (dir.includes("..") || dir.includes("/")) continue; // safety
          const jsonlPath = resolve(CLAUDE_PROJECTS_DIR, dir, `${sdkId}.jsonl`);
          if (existsSync(jsonlPath)) { unlinkSync(jsonlPath); break; }
        }
      }
    } catch { /* best-effort */ }
  }

  /**
   * Ensure a session has projectPath set (for skills/settings support).
   * Called by WS handler to backfill projectPath on resumed sessions.
   */
  ensureProjectPath(sessionId: string, projectPath: string): void {
    const meta = this.activeSessions.get(sessionId);
    if (meta && !meta.projectPath) {
      meta.projectPath = projectPath;
    }
  }

  /** Register a fork source — when this session sends its first message, it will fork from sourceId */
  setForkSource(sessionId: string, sourceSessionId: string): void {
    this.forkSources.set(sessionId, sourceSessionId);
  }

  /** Fork a session at a specific message using SDK forkSession() */
  async forkAtMessage(
    sessionId: string,
    messageId: string,
    opts?: { title?: string; dir?: string },
  ): Promise<{ sessionId: string }> {
    const sdkId = getSessionMapping(sessionId) ?? sessionId;
    // Dynamic import: Bun's ESM linker fails to resolve forkSession as a static named export
    // in certain test configurations. Lazy import avoids the module linking issue.
    const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
    const result = await forkSession(sdkId, {
      upToMessageId: messageId,
      title: opts?.title,
      dir: opts?.dir,
    });
    return { sessionId: result.sessionId };
  }

  /** Mark session as resumed so next sendMessage uses resume path */
  markAsResumed(sessionId: string): void {
    this.messageCount.set(sessionId, 1);
  }

  async listModels(): Promise<ModelOption[]> {
    return [
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ];
  }

  /**
   * Resolve a pending approval from FE (tool approval or AskUserQuestion answer).
   * Called by WS handler when client sends approval_response.
   */
  resolveApproval(requestId: string, approved: boolean, data?: unknown): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending) {
      pending.resolve({ approved, data });
      this.pendingApprovals.delete(requestId);
    }
  }

  /**
   * Push a follow-up message into an existing streaming session's generator.
   * Called by WS handler for follow-up messages (Phase 2).
   */
  pushMessage(sessionId: string, content: string, opts?: { priority?: 'now' | 'next' | 'later'; images?: Array<{ data: string; mediaType: string }> }): void {
    const ss = this.streamingSessions.get(sessionId);
    if (!ss) {
      console.warn(`[sdk] pushMessage: no streaming session for ${sessionId}`);
      return;
    }
    const msgContent = buildMessageParam(content, opts?.images);
    ss.controller.push({
      type: 'user',
      message: msgContent,
      parent_tool_use_id: null,
      session_id: sessionId,
      priority: opts?.priority ?? 'next',
    });
    console.log(`[sdk] pushMessage: session=${sessionId} priority=${opts?.priority ?? 'next'}`);
  }

  /** Close a streaming session — generator + query cleanup */
  closeStreamingSession(sessionId: string): void {
    const ss = this.streamingSessions.get(sessionId);
    if (ss) {
      ss.controller.done();
      ss.query.close();
      this.streamingSessions.delete(sessionId);
      console.log(`[sdk] closeStreamingSession: session=${sessionId}`);
    }
  }

  /** Check if a streaming session is active for a given session ID */
  hasStreamingSession(sessionId: string): boolean {
    return this.streamingSessions.has(sessionId);
  }

  async *sendMessage(
    sessionId: string,
    message: string,
    opts?: import("./provider.interface.ts").SendMessageOpts & { forkSession?: boolean; priority?: 'now' | 'next' | 'later'; images?: Array<{ data: string; mediaType: string }> },
  ): AsyncIterable<ChatEvent> {
    // Follow-up: push into existing streaming session, yield nothing
    const existingStream = this.streamingSessions.get(sessionId);
    if (existingStream) {
      const msgContent = buildMessageParam(message, opts?.images);
      existingStream.controller.push({
        type: 'user',
        message: msgContent,
        parent_tool_use_id: null,
        session_id: sessionId,
        priority: opts?.priority ?? 'next',
      });
      console.log(`[sdk] sendMessage follow-up: session=${sessionId} pushed to generator`);
      return; // Events flow through first-message's consumer loop
    }

    if (!this.activeSessions.has(sessionId)) {
      await this.resumeSession(sessionId);
    }
    const meta = this.activeSessions.get(sessionId)!;

    if (meta.title === "New Chat") {
      meta.title = message.slice(0, 50) + (message.length > 50 ? "..." : "");
    }

    const count = this.messageCount.get(sessionId) ?? 0;
    const isFirstMessage = count === 0;
    this.messageCount.set(sessionId, count + 1);

    // Check if this session should fork from another
    const forkSourceId = this.forkSources.get(sessionId);
    const shouldFork = !!forkSourceId && isFirstMessage;
    if (forkSourceId) this.forkSources.delete(sessionId);

    // Resolve permission mode early — canUseTool needs isBypass
    const providerConfig = this.getProviderConfig();
    const permissionMode = opts?.permissionMode || providerConfig.permission_mode || "bypassPermissions";
    const isBypass = permissionMode === "bypassPermissions";
    const systemPromptOpt = providerConfig.system_prompt
      ? { type: "custom" as const, value: providerConfig.system_prompt }
      : { type: "preset" as const, preset: "claude_code" as const };

    // Build allowedTools based on permission mode.
    // SDK auto-approves everything in allowedTools (skips canUseTool callback).
    // In non-bypass modes, only pre-approve read-only tools so write/execute tools
    // go through the permission evaluation chain → canUseTool callback.
    const readOnlyTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "ToolSearch"];
    const writeTools = ["Write", "Edit", "Bash", "Agent", "Skill", "TodoWrite", "AskUserQuestion"];
    const teamTools = providerConfig.agent_teams
      ? ["TeamCreate", "TeamDelete", "SendMessage", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]
      : [];
    const mcpTools = ["mcp__*"];
    const allowedTools = isBypass
      ? [...readOnlyTools, ...writeTools, ...teamTools, ...mcpTools]
      : [...readOnlyTools, ...mcpTools];

    /**
     * Approval events to yield from the generator.
     * PreToolUse hook pushes events here; the main loop yields them.
     */
    const approvalEvents: ChatEvent[] = [];
    let approvalNotify: (() => void) | undefined;

    /**
     * Helper: send approval request to FE and wait for response.
     */
    const waitForApproval = (toolName: string, input: unknown): Promise<{ approved: boolean; data?: unknown }> => {
      const requestId = crypto.randomUUID();
      const APPROVAL_TIMEOUT_MS = 5 * 60_000;
      const promise = new Promise<{ approved: boolean; data?: unknown }>((resolve) => {
        this.pendingApprovals.set(requestId, { resolve });
        setTimeout(() => {
          if (this.pendingApprovals.has(requestId)) {
            this.pendingApprovals.delete(requestId);
            resolve({ approved: false });
          }
        }, APPROVAL_TIMEOUT_MS);
      });
      approvalEvents.push({ type: "approval_request", requestId, tool: toolName, input });
      approvalNotify?.();
      return promise;
    };

    /**
     * canUseTool: handles AskUserQuestion (always surfaces to FE regardless of mode).
     * Tool permission for Write/Edit/Bash is handled by the PreToolUse hook below.
     */
    const canUseTool = async (toolName: string, input: unknown) => {
      console.log(`[sdk] canUseTool called: tool=${toolName} permissionMode=${permissionMode}`);
      if (toolName === "AskUserQuestion") {
        const result = await waitForApproval(toolName, input);
        if (result.approved && result.data) {
          return {
            behavior: "allow" as const,
            updatedInput: { ...(input as Record<string, unknown>), answers: result.data },
          };
        }
        return { behavior: "deny" as const, message: "User skipped the question" };
      }
      return { behavior: "allow" as const, updatedInput: input };
    };

    /**
     * PreToolUse hook: runs FIRST in SDK evaluation order (Hooks → Deny → PermMode → Allow → canUseTool).
     * User settings hooks (scout-block, etc.) return exit 0 → SDK treats as "allow", preventing canUseTool.
     * This in-process hook handles permission mode decisions before external hooks auto-approve.
     */
    const preToolUseHook = async (hookInput: any) => {
      const toolName = hookInput?.tool_name as string | undefined;
      if (!toolName) return {};
      console.log(`[sdk] preToolUseHook: tool=${toolName} permissionMode=${permissionMode} isBypass=${isBypass}`);

      // Bypass mode: allow everything
      if (isBypass) return {};

      // Read-only tools: always allow
      if (readOnlyTools.includes(toolName)) return {};

      // AskUserQuestion: handled by canUseTool callback
      if (toolName === "AskUserQuestion") return {};

      // Non-bypass mode: ask FE for approval on write/execute tools
      const result = await waitForApproval(toolName, hookInput?.tool_input);
      if (result.approved) {
        return { hookSpecificOutput: { permissionDecision: "allow" } };
      }
      return { hookSpecificOutput: { permissionDecision: "deny", message: "User denied tool execution" } };
    };

    // Hooks config: add our permission hook for non-bypass modes
    const permissionHooks = isBypass ? undefined : {
      PreToolUse: [{
        matcher: ".*",  // Match all tools — our hook checks internally
        hooks: [preToolUseHook],
        timeout: 300,  // 5min for user approval
      }],
    };

    let assistantContent = "";
    let resultSubtype: string | undefined;
    let resultNumTurns: number | undefined;
    let resultContextWindowPct: number | undefined;
    let yieldedDone = false;
    try {
      // Resolve SDK's actual session ID for resume (may differ from PPM's UUID)
      // For fork: use the source session's SDK id
      const sdkId = shouldFork ? getSdkSessionId(forkSourceId!) : getSdkSessionId(sessionId);
      // Fallback cwd: SDK needs a valid working directory even when no project is selected.
      // On Windows daemons, undefined cwd can cause the subprocess to fail silently.
      // Resolve path and validate existence — invalid cwd causes spawn to hang on Windows.
      const rawCwd = meta.projectPath || homedir();
      const effectiveCwd = existsSync(rawCwd) ? rawCwd : homedir();

      // Account-based auth injection (multi-account mode)
      // Fallback to existing env (ANTHROPIC_API_KEY) when no accounts configured.
      const accountsEnabled = accountSelector.isEnabled();
      let account = accountsEnabled ? accountSelector.next() : null;
      if (accountsEnabled && !account) {
        // All accounts in DB but none usable
        const reason = accountSelector.lastFailReason;
        const hint = reason === "all_decrypt_failed"
          ? "Account tokens were encrypted with a different machine key. Re-add your accounts in Settings, or copy ~/.ppm/account.key from the original machine."
          : "All accounts are disabled or in cooldown. Check Settings → Accounts.";
        console.error(`[sdk] session=${sessionId} account auth failed (${reason}): ${hint}`);
        yield { type: "error" as const, message: `Authentication failed: ${hint}` };
        yield { type: "done" as const, sessionId, resultSubtype: "error_auth" };
        return;
      }
      // Pre-flight: ensure OAuth token is fresh before sending to SDK
      if (account) {
        const nowS = Math.floor(Date.now() / 1000);
        const expiresIn = account.expiresAt ? account.expiresAt - nowS : null;
        console.log(`[sdk] Using account ${account.id} (${account.email ?? "no-email"}) token_expires_in=${expiresIn}s`);
        const fresh = await accountService.ensureFreshToken(account.id);
        if (fresh) {
          account = fresh;
        }
        yield { type: "account_info" as const, accountId: account.id, accountLabel: account.label ?? account.email ?? "Unknown" };
      }
      const queryEnv = this.buildQueryEnv(meta.projectPath, account);

      // Pre-flight: warn if no credentials at all (avoids 2-minute silent timeout)
      if (!account) {
        const hasApiKey = !!(queryEnv.ANTHROPIC_API_KEY || queryEnv.CLAUDE_CODE_OAUTH_TOKEN);
        if (!hasApiKey) {
          console.warn(`[sdk] session=${sessionId} no account and no API key in env — Claude CLI will use its own auth (if any)`);
        }
      }
      console.log(`[sdk] query: session=${sessionId} sdkId=${sdkId} isFirst=${isFirstMessage} fork=${shouldFork} cwd=${effectiveCwd} platform=${process.platform} accountMode=${!!account} permissionMode=${permissionMode} isBypass=${isBypass}`);

      // Read MCP servers from PPM DB (fresh per query — user may add/remove between chats)
      const mcpServers = mcpConfigService.list();
      const hasMcp = Object.keys(mcpServers).length > 0;

      // Buffer subprocess stderr for crash diagnostics
      let stderrBuffer = "";
      const stderrCallback = (chunk: string) => {
        stderrBuffer += chunk;
        // Keep only last 2KB to avoid unbounded growth
        if (stderrBuffer.length > 2048) stderrBuffer = stderrBuffer.slice(-2048);
      };

      const queryOptions: Record<string, any> = {
        // On Windows, child_process.spawn("bun") fails with ENOENT — force node
        ...(process.platform === "win32" && { executable: "node" }),
        sessionId: isFirstMessage && !shouldFork ? sessionId : undefined,
        resume: (isFirstMessage && !shouldFork) ? undefined : sdkId,
        ...(shouldFork && { forkSession: true }),
        cwd: effectiveCwd,
        systemPrompt: systemPromptOpt,
        settingSources: ["user", "project"],
        env: queryEnv,
        settings: { permissions: { allow: [], deny: [] } },
        allowedTools,
        ...(hasMcp && { mcpServers }),
        permissionMode,
        allowDangerouslySkipPermissions: isBypass,
        ...(providerConfig.model && { model: providerConfig.model }),
        ...(providerConfig.effort && { effort: providerConfig.effort }),
        maxTurns: providerConfig.max_turns ?? 1000,
        ...(providerConfig.max_budget_usd && { maxBudgetUsd: providerConfig.max_budget_usd }),
        ...(providerConfig.thinking_budget_tokens != null && {
          maxThinkingTokens: providerConfig.thinking_budget_tokens,
        }),
        includePartialMessages: true,
        stderr: stderrCallback,
      };

      // Crash retry: if subprocess exits with non-zero code before producing events,
      // clean up and retry once with a fresh query before surfacing the error.
      const MAX_CRASH_RETRIES = 1;
      let crashRetryCount = 0;

      crashRetryLoop: for (;;) {
      try {
      // Streaming input: create message channel and persistent query
      const firstMsg = {
        type: 'user' as const,
        message: buildMessageParam(message),
        parent_tool_use_id: null,
        session_id: sessionId,
      };

      const { generator: streamGen, controller: initialCtrl } = createMessageChannel();
      initialCtrl.push(firstMsg);

      const initialQuery = query({
        prompt: streamGen,
        options: {
          ...queryOptions,
          ...(permissionHooks && { hooks: permissionHooks }),
          canUseTool,
        } as any,
      });
      this.streamingSessions.set(sessionId, { meta, query: initialQuery, controller: initialCtrl });
      this.activeQueries.set(sessionId, initialQuery);
      let eventSource: AsyncIterable<any> = initialQuery;

      // Helper: close the CURRENT streaming session (not stale closure refs).
      // All retry paths must use this instead of closing captured variables directly.
      const closeCurrentStream = () => {
        const ss = this.streamingSessions.get(sessionId);
        if (ss) {
          ss.controller.done();
          ss.query.close();
        }
      };

      let lastPartialText = "";
      /** Number of tool_use blocks pending results (top-level tools only, not subagent children) */
      let pendingToolCount = 0;

      // Retry logic: if SDK returns error_during_execution with 0 turns on first event,
      // it's a transient subprocess failure — retry once before surfacing the error.
      // Also handles authentication_failed by refreshing OAuth token and retrying.
      const MAX_RETRIES = 1;
      const MAX_RATE_LIMIT_RETRIES = 3;
      const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000]; // 15s, 30s, 60s
      let retryCount = 0;
      let rateLimitRetryCount = 0;
      let authRetried = false;
      /** True after the first init event maps ppmId → sdkId. Prevents retry init events from overwriting the mapping. */
      let initMappingDone = false;

      let hadAnyEvents = false;
      retryLoop: while (true) {
      let sdkEventCount = 0;
      for await (const msg of eventSource) {
        sdkEventCount++;
        hadAnyEvents = true;
        if (sdkEventCount === 1) {
          console.log(`[sdk] first event received: type=${(msg as any).type} subtype=${(msg as any).subtype ?? "none"}`);
          // Detect immediate failure: first event is a result with error + 0 turns
          if ((msg as any).type === "result" && (msg as any).subtype === "error_during_execution" && ((msg as any).num_turns ?? 0) === 0 && retryCount < MAX_RETRIES) {
            retryCount++;
            console.warn(`[sdk] transient error on first event — retrying (attempt ${retryCount}/${MAX_RETRIES})`);
            // Close current streaming session (uses streamingSessions, not stale closure refs)
            closeCurrentStream();
            const { generator: retryGen, controller: retryCtrl } = createMessageChannel();
            retryCtrl.push(firstMsg);
            const retryOpts = { ...queryOptions, sessionId: undefined, resume: undefined };
            const rq = query({
              prompt: retryGen,
              options: { ...retryOpts, ...(permissionHooks && { hooks: permissionHooks }), canUseTool } as any,
            });
            this.streamingSessions.set(sessionId, { meta, query: rq, controller: retryCtrl });
            this.activeQueries.set(sessionId, rq);
            eventSource = rq;
            continue retryLoop;
          }
        }
        // Extract parent_tool_use_id from SDK message (present on subagent-scoped messages)
        const parentId = (msg as any).parent_tool_use_id as string | undefined;

        // Yield any queued approval events
        while (approvalEvents.length > 0) {
          yield approvalEvents.shift()!;
        }

        // Log all system events for debugging SDK lifecycle
        if (msg.type === "system") {
          const subtype = (msg as any).subtype ?? "none";
          console.log(`[sdk] session=${sessionId} system: subtype=${subtype} ${JSON.stringify(msg).slice(0, 500)}`);

          // Capture SDK session metadata from init message
          if (subtype === "init") {
            const initMsg = msg as any;
            if (initMsg.session_id && initMsg.session_id !== sessionId) {
              // Only update sdk_id mapping once per session lifecycle.
              // Retries (auth refresh, rate limit) create new SDK queries that
              // emit fresh init events — overwriting would orphan the original JSONL.
              if (!initMappingDone) {
                const existingSdkId = getSessionMapping(sessionId);
                const isFirstMapping = existingSdkId === null || existingSdkId === sessionId;
                if (isFirstMapping) {
                  setSessionMapping(sessionId, initMsg.session_id, meta.projectName, meta.projectPath);
                  initMappingDone = true;
                } else {
                  // Already mapped to a real SDK id from a previous conversation
                  initMappingDone = true;
                  console.log(`[sdk] session=${sessionId} preserving existing mapping → ${existingSdkId}`);
                }
              } else {
                console.log(`[sdk] session=${sessionId} ignoring retry init sdk_id=${initMsg.session_id} (mapping already set)`);
              }
              // Only create activeSessions alias for first-time SDK id mapping.
              // Retry init events create phantom entries that pollute the map.
              if (isFirstMessage) {
                const oldMeta = this.activeSessions.get(sessionId);
                if (oldMeta) {
                  this.activeSessions.set(initMsg.session_id, { ...oldMeta, id: initMsg.session_id });
                }
              }
            }
          }

          // Detect compacting status
          if (subtype === "status") {
            const status = (msg as any).status;
            if (status === "compacting") {
              console.log(`[sdk] session=${sessionId} COMPACTING`);
              yield { type: "system" as const, subtype: "compacting" } as ChatEvent;
              continue;
            }
          }

          // Detect compact boundary (compact finished, messages replaced in JSONL)
          if (subtype === "compact_boundary") {
            const meta = (msg as any).compact_metadata;
            console.log(`[sdk] session=${sessionId} COMPACT_BOUNDARY trigger=${meta?.trigger} pre_tokens=${meta?.pre_tokens}`);
            yield { type: "system" as const, subtype: "compact_done" } as ChatEvent;
            continue;
          }

          // Intercept SDK's internal api_retry with 401 — the SDK will retry up to 10 times
          // with exponential backoff using the same expired token, wasting 2+ minutes.
          // Instead, refresh the OAuth token immediately and restart the query.
          if (subtype === "api_retry" && (msg as any).error_status === 401 && account && !authRetried) {
            authRetried = true;
            try {
              // refreshAccessToken has mutex + skip-if-fresh: if another session already
              // refreshed, it returns immediately without calling OAuth again.
              await accountService.refreshAccessToken(account.id, false);
              const refreshedAccount = accountService.getWithTokens(account.id);
              if (refreshedAccount) {
                const label = refreshedAccount.label ?? refreshedAccount.email ?? "Unknown";
                console.log(`[sdk] session=${sessionId} intercepted api_retry 401 — refreshing token for ${account.id} (${label})`);
                yield { type: "account_retry" as const, reason: "Token refreshed", accountId: refreshedAccount.id, accountLabel: label };
                const retryEnv = this.buildQueryEnv(meta.projectPath, refreshedAccount);
                closeCurrentStream();
                const { generator: earlyAuthGen, controller: earlyAuthCtrl } = createMessageChannel();
                const currentSdkId = getSessionMapping(sessionId);
                const canResume = !!currentSdkId;
                if (!canResume) earlyAuthCtrl.push(firstMsg);
                const retryOpts = { ...queryOptions, sessionId: undefined, resume: canResume ? currentSdkId : undefined, env: retryEnv };
                const rq = query({
                  prompt: earlyAuthGen,
                  options: { ...retryOpts, ...(permissionHooks && { hooks: permissionHooks }), canUseTool } as any,
                });
                this.streamingSessions.set(sessionId, { meta, query: rq, controller: earlyAuthCtrl });
                this.activeQueries.set(sessionId, rq);
                eventSource = rq;
                continue retryLoop;
              }
            } catch (refreshErr) {
              console.error(`[sdk] session=${sessionId} early OAuth refresh failed:`, refreshErr);
              accountSelector.onAuthError(account.id);
              // Refresh failed (e.g. temporary account with no refresh token).
              // Abort the current query immediately and try switching to a different account.
              const nextAcc = accountSelector.next();
              if (nextAcc && nextAcc.id !== account.id) {
                account = nextAcc;
                const label = nextAcc.label ?? nextAcc.email ?? "Unknown";
                console.log(`[sdk] session=${sessionId} refresh failed — switching to ${nextAcc.id} (${label})`);
                yield { type: "account_retry" as const, reason: "Switching account", accountId: nextAcc.id, accountLabel: label };
                const switchEnv = this.buildQueryEnv(meta.projectPath, nextAcc);
                closeCurrentStream();
                const { generator: switchGen, controller: switchCtrl } = createMessageChannel();
                const currentSdkId = getSessionMapping(sessionId);
                const canResume = !!currentSdkId;
                if (!canResume) switchCtrl.push(firstMsg);
                const retryOpts = { ...queryOptions, sessionId: undefined, resume: canResume ? currentSdkId : undefined, env: switchEnv };
                const rq = query({
                  prompt: switchGen,
                  options: { ...retryOpts, ...(permissionHooks && { hooks: permissionHooks }), canUseTool } as any,
                });
                this.streamingSessions.set(sessionId, { meta, query: rq, controller: switchCtrl });
                this.activeQueries.set(sessionId, rq);
                eventSource = rq;
                continue retryLoop;
              }
              // No other account available — let SDK continue and eventually emit error
            }
          }

          // Yield system events so streaming loop can transition phases
          // (e.g. connecting → thinking when hooks/init arrive)
          yield { type: "system" as any, subtype } as any;
          continue;
        }

        // Handle `user` messages — they contain tool_result blocks.
        // Top-level: e.g. after Agent finishes. Child: subagent internal tool results.
        if ((msg as any).type === "user") {
          const userContent = (msg as any).message?.content;
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block.type === "tool_result") {
                const output = block.content ?? block.output ?? "";
                yield {
                  type: "tool_result" as const,
                  output: typeof output === "string" ? output : JSON.stringify(output),
                  isError: !!block.is_error,
                  toolUseId: block.tool_use_id as string | undefined,
                  ...(parentId && { parentToolUseId: parentId }),
                };
                if (!parentId && pendingToolCount > 0) pendingToolCount--;
              }
            }
          }
          continue;
        }

        // When top-level tools were pending and a new TOP-LEVEL message arrives,
        // the SDK has finished executing tools. Fetch tool_results from session history.
        // Skip this for child messages (parentId set) — subagent internals don't mean parent tools finished.
        if (pendingToolCount > 0 && !parentId && (msg.type === "assistant" || (msg as any).type === "partial" || (msg as any).type === "stream_event")) {
          try {
            const sessionMsgs = await getSessionMessages(sdkId);
            // Find the last user message — it contains tool_result blocks
            const lastUserMsg = [...sessionMsgs].reverse().find(
              (m: any) => m.type === "user",
            );
            const userContent = (lastUserMsg as any)?.message?.content;
            if (Array.isArray(userContent)) {
              for (const block of userContent) {
                if (block.type === "tool_result") {
                  const output = block.content ?? block.output ?? "";
                  yield {
                    type: "tool_result" as const,
                    output: typeof output === "string" ? output : JSON.stringify(output),
                    isError: !!block.is_error,
                    toolUseId: block.tool_use_id as string | undefined,
                  };
                }
              }
            }
          } catch {
            // Session history unavailable — skip tool_results
          }
          pendingToolCount = 0;
        }

        // Partial assistant message — streaming text deltas
        if ((msg as any).type === "partial" || (msg as any).type === "stream_event") {
          const partial = msg as any;
          // Handle stream_event (raw API events) for text deltas
          if ((msg as any).type === "stream_event") {
            const event = partial.event;
            if (event?.type === "content_block_delta") {
              if (event.delta?.type === "text_delta") {
                const text = event.delta.text ?? "";
                if (text) {
                  lastPartialText += text;
                  yield { type: "text", content: text, ...(parentId && { parentToolUseId: parentId }) };
                }
              } else if (event.delta?.type === "thinking_delta") {
                const thinking = event.delta.thinking ?? "";
                if (thinking) {
                  yield { type: "thinking", content: thinking, ...(parentId && { parentToolUseId: parentId }) } as any;
                }
              }
            }
            continue;
          }
          // Handle legacy "partial" type
          const content = partial.message?.content;
          if (Array.isArray(content)) {
            let fullText = "";
            for (const block of content) {
              if (block.type === "text") fullText += block.text ?? "";
            }
            if (fullText.length > lastPartialText.length) {
              const delta = fullText.slice(lastPartialText.length);
              lastPartialText = fullText;
              yield { type: "text", content: delta, ...(parentId && { parentToolUseId: parentId }) };
            }
          }
          continue;
        }

        // Full assistant message
        if (msg.type === "assistant") {
          // SDK assistant messages can carry an error field for auth/billing/rate-limit failures
          let assistantError = (msg as any).error as string | undefined;

          // SDK sometimes returns auth errors as text content without setting error field.
          // Detect 401 pattern in text: "Failed to authenticate. API Error: 401 ..."
          if (!assistantError) {
            const textContent = this.extractAssistantText(msg);
            if (textContent && /API Error:\s*401\b.*authentication_error/i.test(textContent)) {
              assistantError = "authentication_failed";
              console.warn(`[sdk] session=${sessionId} detected 401 in assistant text content — treating as auth error`);
            }
          }

          if (assistantError) {
            // Dump full SDK message for debugging
            console.error(`[sdk] session=${sessionId} cwd=${effectiveCwd} assistant error: ${assistantError} (isFirst=${isFirstMessage} retry=${retryCount})`);
            console.error(`[sdk] assistant message dump: ${JSON.stringify(msg).slice(0, 2000)}`);

            // OAuth token expired — refresh and retry once before showing error
            if (assistantError === "authentication_failed" && account && !authRetried) {
              authRetried = true;
              try {
                // refreshAccessToken has mutex + skip-if-fresh: if another session already
                // refreshed, it returns immediately without calling OAuth again.
                await accountService.refreshAccessToken(account.id, false);
                const refreshedAccount = accountService.getWithTokens(account.id);
                if (refreshedAccount) {
                  const label = refreshedAccount.label ?? refreshedAccount.email ?? "Unknown";
                  console.log(`[sdk] session=${sessionId} OAuth token refreshed for ${account.id} (${label}) — retrying`);
                  yield { type: "account_retry" as const, reason: "Token refreshed", accountId: refreshedAccount.id, accountLabel: label };
                  const retryEnv = this.buildQueryEnv(meta.projectPath, refreshedAccount);
                  // Close failed query and old channel, create new channel + query with refreshed token.
                  // Re-resolve sdkId: the init event may have mapped ppmId → real SDK session_id
                  // after sdkId was originally resolved. Using the stale value would try to
                  // resume a non-existent session, causing the SDK to hang forever.
                  closeCurrentStream();
                  const { generator: authRetryGen, controller: authRetryCtrl } = createMessageChannel();
                  const currentSdkId = getSessionMapping(sessionId);
                  const canResume = !!currentSdkId;
                  if (!canResume) authRetryCtrl.push(firstMsg);
                  const retryOpts = { ...queryOptions, sessionId: undefined, resume: canResume ? currentSdkId : undefined, env: retryEnv };
                  const rq = query({
                    prompt: authRetryGen,
                    options: { ...retryOpts, ...(permissionHooks && { hooks: permissionHooks }), canUseTool } as any,
                  });
                  this.streamingSessions.set(sessionId, { meta, query: rq, controller: authRetryCtrl });
                  this.activeQueries.set(sessionId, rq);
                  eventSource = rq;
                  continue retryLoop;
                }
              } catch (refreshErr) {
                console.error(`[sdk] session=${sessionId} OAuth refresh failed:`, refreshErr);
                accountSelector.onAuthError(account.id);
              }
            }

            // Auth failed permanently after retry — cooldown account and break loop.
            // SDK doesn't send a result event after auth errors in streaming mode,
            // so the streaming session would stay alive with broken credentials forever.
            // Breaking here lets the finally block tear down the session, so the next
            // user message creates a fresh session with a different account.
            if (assistantError === "authentication_failed" && account && authRetried) {
              accountSelector.onAuthError(account.id);
              console.warn(`[sdk] session=${sessionId} auth permanently failed — tearing down streaming session`);
              yield { type: "error", message: "API authentication failed. Check your account credentials in Settings → Accounts." };
              break;
            }

            // Rate limit — auto-retry with exponential backoff, switching account if possible
            if ((assistantError === "rate_limit" || assistantError === "server_error") && rateLimitRetryCount < MAX_RATE_LIMIT_RETRIES) {
              const backoff = RATE_LIMIT_BACKOFF_MS[rateLimitRetryCount] ?? 60_000;
              rateLimitRetryCount++;
              if (account) accountSelector.onRateLimit(account.id);

              // Try to switch to a different account
              const nextAccount = accountSelector.next();
              if (nextAccount && account && nextAccount.id !== account.id) {
                account = nextAccount;
                const label = nextAccount.label ?? nextAccount.email ?? "Unknown";
                console.warn(`[sdk] session=${sessionId} rate limited — switching to account ${nextAccount.id} (${label}), retrying in ${backoff / 1000}s (attempt ${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})`);
                yield { type: "account_retry" as const, reason: `Rate limited — switching account`, accountId: nextAccount.id, accountLabel: label };
              } else {
                console.warn(`[sdk] session=${sessionId} rate limited — retrying in ${backoff / 1000}s (attempt ${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})`);
              }
              yield { type: "error", message: `Rate limited. Auto-retrying in ${backoff / 1000}s... (${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})` };
              await new Promise((r) => setTimeout(r, backoff));
              // Close current streaming session and recreate with (potentially new) account env.
              // Re-resolve sdkId to pick up init-event mapping (see auth retry comment).
              closeCurrentStream();
              const rlRetryEnv = this.buildQueryEnv(meta.projectPath, account);
              const { generator: rlRetryGen, controller: rlRetryCtrl } = createMessageChannel();
              const rlCurrentSdkId = getSessionMapping(sessionId);
              const rlCanResume = !!rlCurrentSdkId;
              if (!rlCanResume) rlRetryCtrl.push(firstMsg);
              const retryOpts = { ...queryOptions, sessionId: undefined, resume: rlCanResume ? rlCurrentSdkId : undefined, env: rlRetryEnv };
              const rq = query({
                prompt: rlRetryGen,
                options: { ...retryOpts, ...(permissionHooks && { hooks: permissionHooks }), canUseTool } as any,
              });
              this.streamingSessions.set(sessionId, { meta, query: rq, controller: rlRetryCtrl });
              this.activeQueries.set(sessionId, rq);
              eventSource = rq;
              continue retryLoop;
            }

            const errorHints: Record<string, string> = {
              authentication_failed: "API authentication failed. Check your account credentials in Settings → Accounts.",
              billing_error: "Billing error on this account. Check your subscription status.",
              rate_limit: `Rate limited by the API. Retried ${MAX_RATE_LIMIT_RETRIES} times without success.`,
              invalid_request: "Invalid request sent to the API.",
              server_error: `Anthropic API server error. Retried ${MAX_RATE_LIMIT_RETRIES} times without success.`,
              unknown: `API error in project "${effectiveCwd}". Debug:\n1. Run: \`cd ${effectiveCwd} && claude -p "hi"\`\n2. Check env: \`echo $ANTHROPIC_API_KEY $ANTHROPIC_BASE_URL\` — stale/invalid keys cause this\n3. Try: \`ANTHROPIC_API_KEY="" ANTHROPIC_BASE_URL="" claude -p "hi"\`\n4. Refresh auth: \`claude login\``,
            };
            const hint = errorHints[assistantError] ?? `API error: ${assistantError}`;
            yield { type: "error", message: hint };
            // Skip emitting the raw 401 error as text content — already shown as error event
            continue;
          }
          const content = (msg as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                if (block.text.length > lastPartialText.length) {
                  yield { type: "text", content: block.text.slice(lastPartialText.length), ...(parentId && { parentToolUseId: parentId }) };
                } else if (lastPartialText.length === 0) {
                  yield { type: "text", content: block.text, ...(parentId && { parentToolUseId: parentId }) };
                }
                assistantContent += block.text;
                lastPartialText = "";
              } else if (block.type === "tool_use") {
                // Only track pending count for top-level tools (not subagent children).
                // Child tools are executed internally by the SDK subagent — their results
                // stream as child messages and don't need the pendingToolCount flush mechanism.
                if (!parentId) {
                  pendingToolCount++;
                }
                yield {
                  type: "tool_use",
                  tool: block.name ?? "unknown",
                  input: block.input ?? {},
                  toolUseId: block.id as string | undefined,
                  ...(parentId && { parentToolUseId: parentId }),
                };
              }
            }
          }
          continue;
        }

        // Rate limit event — write to shared usage cache (REST endpoint serves it)
        if ((msg as any).type === "rate_limit_event") {
          const info = (msg as any).rate_limit_info;
          if (info) {
            const rateLimitType = info.rateLimitType as string | undefined;
            const utilization = info.utilization as number | undefined;
            if (rateLimitType && utilization != null) {
              updateFromSdkEvent(rateLimitType, utilization);
            }
          }
          continue;
        }

        if (msg.type === "result") {
          // Account error detection — only act on pre-stream 429/401
          if (account) {
            const errCode = this.detectResultErrorCode(msg);
            if (errCode === 429) {
              accountSelector.onRateLimit(account.id);
              // Auto-retry with backoff for result-level 429, switching account if possible
              if (rateLimitRetryCount < MAX_RATE_LIMIT_RETRIES) {
                const backoff = RATE_LIMIT_BACKOFF_MS[rateLimitRetryCount] ?? 60_000;
                rateLimitRetryCount++;

                // Try to switch to a different account
                const nextAccount = accountSelector.next();
                if (nextAccount && nextAccount.id !== account.id) {
                  account = nextAccount;
                  const label = nextAccount.label ?? nextAccount.email ?? "Unknown";
                  console.warn(`[sdk] session=${sessionId} result 429 — switching to account ${nextAccount.id} (${label}), retrying in ${backoff / 1000}s (attempt ${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})`);
                  yield { type: "account_retry" as const, reason: `Rate limited — switching account`, accountId: nextAccount.id, accountLabel: label };
                } else {
                  console.warn(`[sdk] session=${sessionId} result 429 — retrying in ${backoff / 1000}s (attempt ${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})`);
                }
                yield { type: "error", message: `Rate limited. Auto-retrying in ${backoff / 1000}s... (${rateLimitRetryCount}/${MAX_RATE_LIMIT_RETRIES})` };
                await new Promise((r) => setTimeout(r, backoff));
                // Re-resolve sdkId to pick up init-event mapping (see auth retry comment).
                closeCurrentStream();
                const rlRetryEnv = this.buildQueryEnv(meta.projectPath, account);
                const { generator: rlRetryGen, controller: rlRetryCtrl } = createMessageChannel();
                const rlCurrentSdkId2 = getSessionMapping(sessionId);
                const rlCanResume2 = !!rlCurrentSdkId2;
                if (!rlCanResume2) rlRetryCtrl.push(firstMsg);
                const retryOpts = { ...queryOptions, sessionId: undefined, resume: rlCanResume2 ? rlCurrentSdkId2 : undefined, env: rlRetryEnv };
                const rq = query({
                  prompt: rlRetryGen,
                  options: { ...retryOpts, ...(permissionHooks && { hooks: permissionHooks }), canUseTool } as any,
                });
                this.streamingSessions.set(sessionId, { meta, query: rq, controller: rlRetryCtrl });
                this.activeQueries.set(sessionId, rq);
                eventSource = rq;
                continue retryLoop;
              }
              yield { type: "error", message: `Rate limited. Retried ${MAX_RATE_LIMIT_RETRIES} times without success.` };
              continue;
            } else if (errCode === 401) {
              // Refresh token and retry — resume existing SDK session to preserve context
              if (!authRetried) {
                authRetried = true;
                try {
                  // refreshAccessToken has mutex + skip-if-fresh: if another session already
                  // refreshed, it returns immediately without calling OAuth again.
                  await accountService.refreshAccessToken(account.id, false);
                  const refreshedAccount = accountService.getWithTokens(account.id);
                  if (refreshedAccount) {
                    const label = refreshedAccount.label ?? refreshedAccount.email ?? "Unknown";
                    console.log(`[sdk] 401 in result on account ${account.id} (${label}) — token refreshed, retrying`);
                    yield { type: "account_retry" as const, reason: "Token refreshed", accountId: refreshedAccount.id, accountLabel: label };
                    // Re-resolve sdkId to pick up init-event mapping (see auth retry comment).
                    closeCurrentStream();
                    const retryEnv = this.buildQueryEnv(meta.projectPath, refreshedAccount);
                    const { generator: authRetryGen2, controller: authRetryCtrl2 } = createMessageChannel();
                    const authCurrentSdkId2 = getSessionMapping(sessionId);
                    const authCanResume2 = !!authCurrentSdkId2;
                    if (!authCanResume2) authRetryCtrl2.push(firstMsg);
                    const retryOpts = { ...queryOptions, sessionId: undefined, resume: authCanResume2 ? authCurrentSdkId2 : undefined, env: retryEnv };
                    const rq = query({
                      prompt: authRetryGen2,
                      options: { ...retryOpts, ...(permissionHooks && { hooks: permissionHooks }), canUseTool } as any,
                    });
                    this.streamingSessions.set(sessionId, { meta, query: rq, controller: authRetryCtrl2 });
                    this.activeQueries.set(sessionId, rq);
                    eventSource = rq;
                    continue retryLoop;
                  }
                } catch {
                  accountSelector.onAuthError(account.id);
                }
              } else {
                accountSelector.onAuthError(account.id);
              }
            } else {
              accountSelector.onSuccess(account.id);
            }
          }

          // Flush any remaining pending tool_results before finishing
          if (pendingToolCount > 0) {
            try {
              const sessionMsgs = await getSessionMessages(sdkId);
              const lastUserMsg = [...sessionMsgs].reverse().find(
                (m: any) => m.type === "user",
              );
              const userContent = (lastUserMsg as any)?.message?.content;
              if (Array.isArray(userContent)) {
                for (const block of userContent) {
                  if (block.type === "tool_result") {
                    const output = block.content ?? block.output ?? "";
                    yield {
                      type: "tool_result" as const,
                      output: typeof output === "string" ? output : JSON.stringify(output),
                      isError: !!block.is_error,
                      toolUseId: block.tool_use_id as string | undefined,
                    };
                  }
                }
              }
            } catch {}
            pendingToolCount = 0;
          }

          const result = msg as any;
          const subtype = result.subtype as string | undefined;

          // Write cost to shared usage cache
          if (result.total_cost_usd != null) {
            updateFromSdkEvent(undefined, undefined, result.total_cost_usd);
          }

          // Surface non-success subtypes as errors so FE can display them
          // But suppress abort errors — user-initiated cancel is not a real error
          if (subtype && subtype !== "success") {
            const errorsArr0 = Array.isArray(result.errors) ? result.errors : [];
            const abortDetail = errorsArr0.join(" ") + " " + (typeof result.error === "string" ? result.error : "");
            if (subtype === "error_during_execution" && /abort|request was aborted/i.test(abortDetail)) {
              console.log(`[sdk] session=${sessionId} suppressing abort error (user-initiated cancel)`);
              resultSubtype = subtype;
              resultNumTurns = result.num_turns as number | undefined;
              break;
            }
            // SDK error results use `errors: string[]` array (not singular `error`)
            const errorsArr = Array.isArray(result.errors) ? result.errors : [];
            const sdkDetail = errorsArr.length > 0
              ? errorsArr.join("\n")
              : (typeof result.error === "string" ? result.error : "");
            // Log full result for debugging (truncated at 2000 chars)
            console.error(`[sdk] result error: subtype=${subtype} turns=${result.num_turns ?? 0} detail=${sdkDetail || "(none)"}`);
            console.error(`[sdk] result full dump: ${JSON.stringify(result).slice(0, 2000)}`);
            const errorMessages: Record<string, string> = {
              error_max_turns: "Agent reached maximum turn limit.",
              error_max_budget_usd: "Agent reached budget limit.",
              error_during_execution: "Agent encountered an error during execution.",
            };
            const baseMsg = errorMessages[subtype] ?? `Agent stopped: ${subtype}`;
            // Add specific hints for common network/auth errors
            const detailLower = sdkDetail.toLowerCase();
            let hint = "";
            if (detailLower.includes("connectionrefused") || detailLower.includes("connection refused") || detailLower.includes("econnrefused")) {
              hint = "\n\nHint: Cannot reach Anthropic API. If running in WSL, check DNS/proxy settings (e.g. `curl -s https://api.anthropic.com` from WSL terminal).";
            } else if (detailLower.includes("unable to connect")) {
              hint = "\n\nHint: Network connectivity issue. Check your internet connection and firewall/proxy settings.";
            } else if (detailLower.includes("401") || detailLower.includes("unauthorized") || detailLower.includes("invalid api key")) {
              hint = "\n\nHint: Authentication failed. Try re-adding your account in Settings → Accounts.";
            }
            const fullMsg = sdkDetail ? `${baseMsg}\n${sdkDetail}${hint}` : baseMsg;
            yield {
              type: "error",
              message: fullMsg,
            };
          }

          // Detect empty/suspicious success — SDK returned "success" but no real assistant content
          if ((!subtype || subtype === "success") && (result.num_turns ?? 0) === 0 && !assistantContent) {
            // SDK success result has `result: string` containing final text
            const resultText = typeof result.result === "string" ? result.result : "";
            console.warn(`[sdk] session=${sessionId} result success but 0 turns, no assistant content, result="${resultText.slice(0, 200)}"`);
            console.warn(`[sdk] result dump: ${JSON.stringify(result).slice(0, 2000)}`);
            const hint = resultText
              ? `Claude returned: "${resultText}"\nThis may indicate a session or connection issue. Try creating a new chat session.`
              : "Claude returned no response (0 turns). This usually means the API connection failed silently. Check that `claude` CLI works in your terminal, or try creating a new chat session.";
            yield { type: "error", message: hint };
          }

          // Store subtype and numTurns for the done event
          resultSubtype = subtype;
          resultNumTurns = result.num_turns as number | undefined;

          // Extract context window usage from modelUsage
          const modelUsage = (result.modelUsage ?? result.model_usage) as Record<string, any> | undefined;
          if (modelUsage) {
            for (const usage of Object.values(modelUsage)) {
              const cw = usage.contextWindow ?? 0;
              if (cw > 0) {
                const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
                resultContextWindowPct = Math.min(Math.round((total / cw) * 100), 100);
                break;
              }
            }
          }

          // Streaming input: yield done for this turn, then continue for next turn
          yieldedDone = true;
          yield {
            type: "done",
            sessionId,
            resultSubtype: resultSubtype as any,
            numTurns: resultNumTurns,
            contextWindowPct: resultContextWindowPct,
          };

          // Reset per-turn state for next turn
          lastPartialText = "";
          pendingToolCount = 0;
          assistantContent = "";
          resultSubtype = undefined;
          resultNumTurns = undefined;
          resultContextWindowPct = undefined;
          sdkEventCount = 0;
          continue; // Wait for next turn from generator
        }
      }

      // Yield remaining approval events
      while (approvalEvents.length > 0) {
        yield approvalEvents.shift()!;
      }

      if (!hadAnyEvents) {
        yield { type: "error", message: "Claude did not respond. Check that 'claude' CLI works in your terminal." };
      }
      break; // Exit retryLoop — normal completion
      } // end retryLoop
      break crashRetryLoop; // Normal completion — exit crash retry loop
    } catch (crashErr) {
      const crashMsg = (crashErr as Error).message ?? String(crashErr);
      const stderrInfo = stderrBuffer.trim() ? ` stderr: ${stderrBuffer.trim().slice(-500)}` : "";
      console.error(`[sdk] session=${sessionId} cwd=${meta.projectPath} error: ${crashMsg}${stderrInfo}`);

      // Clean up crashed subprocess before retry or error
      this.activeQueries.delete(sessionId);
      const ss = this.streamingSessions.get(sessionId);
      if (ss) { ss.controller.done(); ss.query.close(); this.streamingSessions.delete(sessionId); }
      console.log(`[sdk] session=${sessionId} streaming session ended`);

      if (crashMsg.includes("abort") || crashMsg.includes("closed")) {
        // User-initiated abort or WS closed — nothing to report
      } else if (crashMsg.includes("exited with code") && crashRetryCount < MAX_CRASH_RETRIES) {
        // Subprocess crashed — auto-retry once before surfacing the error
        crashRetryCount++;
        console.warn(`[sdk] session=${sessionId} subprocess crashed: ${crashMsg} — auto-retrying (attempt ${crashRetryCount}/${MAX_CRASH_RETRIES})${stderrInfo}`);
        stderrBuffer = ""; // Reset for retry
        await new Promise((r) => setTimeout(r, 1000));
        continue crashRetryLoop;
      } else if (crashMsg.includes("exited with code")) {
        console.warn(`[sdk] session=${sessionId} subprocess crashed after retry: ${crashMsg}${stderrInfo}`);
        const userHint = stderrInfo ? ` (${stderrBuffer.trim().slice(-200)})` : "";
        yield { type: "error", message: `SDK subprocess crashed.${userHint} Send another message to auto-recover.` };
      } else {
        yield { type: "error", message: `SDK error: ${crashMsg}` };
      }
      break crashRetryLoop; // Exit after error handling (non-retryable)
    }
    } // end crashRetryLoop

    } catch (outerErr) {
      // Setup errors (account auth, env) — not retryable
      const msg = (outerErr as Error).message ?? String(outerErr);
      console.error(`[sdk] session=${sessionId} setup error: ${msg}`);
      yield { type: "error", message: `SDK error: ${msg}` };
    } finally {
      // Final cleanup — ensure no leaked streaming session
      this.activeQueries.delete(sessionId);
      const ss = this.streamingSessions.get(sessionId);
      if (ss) { ss.controller.done(); ss.query.close(); this.streamingSessions.delete(sessionId); }
    }

    // Final done event when query ends (crash, close, generator done)
    // Skip if we already yielded done from the result handler (avoid duplicate)
    if (!yieldedDone) {
      yield {
        type: "done",
        sessionId,
        resultSubtype: resultSubtype as any,
        numTurns: resultNumTurns,
        contextWindowPct: resultContextWindowPct,
      };
    }
  }


  /** Abort and fully teardown the streaming session — user must resume to continue */
  abortQuery(sessionId: string): void {
    const ss = this.streamingSessions.get(sessionId);
    if (ss) {
      // Signal generator to end, then close the query (kills bun subprocess)
      ss.controller.done();
      ss.query.close();
      this.streamingSessions.delete(sessionId);
      this.activeQueries.delete(sessionId);
      console.log(`[sdk] abortQuery: closed streaming session=${sessionId}`);
      return;
    }
    // Non-streaming fallback
    const q = this.activeQueries.get(sessionId);
    if (q) {
      q.close();
      this.activeQueries.delete(sessionId);
    }
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    try {
      const sdkId = getSdkSessionId(sessionId);
      const messages = await getSessionMessages(sdkId);
      const parsed = messages.map((msg) => parseSessionMessage(msg));

      // Merge tool_result user messages into the preceding assistant message
      const merged: ChatMessage[] = [];
      for (const msg of parsed) {
        if (msg.events?.length && msg.events.every((e) => e.type === "tool_result")) {
          // This is a tool_result-only message — append events to last assistant
          const lastAssistant = [...merged].reverse().find((m) => m.role === "assistant");
          if (lastAssistant?.events) {
            lastAssistant.events.push(...msg.events);
            continue;
          }
        }
        merged.push(msg);
      }

      // Nest child events under their parent Agent/Task tool_use's children array
      for (const msg of merged) {
        if (!msg.events) continue;
        nestChildEvents(msg.events);
      }

      return merged.filter(
        (msg) => msg.content.trim().length > 0 || (msg.events && msg.events.length > 0),
      );
    } catch {
      return [];
    }
  }
}

/** Parse SDK SessionMessage into ChatMessage with events for tool_use blocks */
function parseSessionMessage(msg: { uuid: string; type: string; message: unknown; parent_tool_use_id?: string | null }): ChatMessage {
  const message = msg.message as Record<string, unknown> | undefined;
  const role = msg.type as "user" | "assistant";
  const parentId = (msg as any).parent_tool_use_id as string | undefined;

  // Parse content blocks for both user and assistant messages
  const events: ChatEvent[] = [];
  let textContent = "";

  if (message && Array.isArray(message.content)) {
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        const cleaned = role === "assistant" ? stripTeammateXml(block.text) : block.text;
        textContent += cleaned;
        if (role === "assistant" && cleaned) {
          events.push({ type: "text", content: cleaned, ...(parentId && { parentToolUseId: parentId }) });
        }
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool_use",
          tool: (block.name as string) ?? "unknown",
          input: block.input ?? {},
          toolUseId: block.id as string | undefined,
          ...(parentId && { parentToolUseId: parentId }),
        });
      } else if (block.type === "tool_result") {
        const output = block.content ?? block.output ?? "";
        events.push({
          type: "tool_result",
          output: typeof output === "string" ? output : JSON.stringify(output),
          isError: !!(block as Record<string, unknown>).is_error,
          toolUseId: block.tool_use_id as string | undefined,
          ...(parentId && { parentToolUseId: parentId }),
        });
      }
    }
  } else {
    textContent = extractText(message);
  }

  // SDK-generated user messages carry system text (tool_result blocks,
  // <teammate-message> XML, <task-notification> XML) — not actual user input.
  // Clear so they don't render as user bubbles.
  if (role === "user" && (events.some((e) => e.type === "tool_result") || textContent.includes("<teammate-message"))) {
    textContent = "";
  }

  return {
    id: msg.uuid,
    role,
    content: textContent,
    events: events.length > 0 ? events : undefined,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Move events with parentToolUseId into their parent Agent/Task tool_use's children array.
 * Mutates the array in-place: child events are removed from the top level and pushed into parent.children.
 */
function nestChildEvents(events: ChatEvent[]): void {
  // Build map of Agent/Task tool_use events by toolUseId
  const parentMap = new Map<string, ChatEvent & { type: "tool_use" }>();
  for (const ev of events) {
    if (ev.type === "tool_use" && (ev.tool === "Agent" || ev.tool === "Task") && ev.toolUseId) {
      parentMap.set(ev.toolUseId, ev);
    }
  }
  if (parentMap.size === 0) return;

  // Collect indices of child events to remove
  const childIndices: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const pid = (ev as any).parentToolUseId as string | undefined;
    if (!pid) continue;
    const parent = parentMap.get(pid);
    if (parent) {
      if (!parent.children) parent.children = [];
      parent.children.push(ev);
      childIndices.push(i);
    }
  }

  // Remove children from flat array (reverse order to keep indices valid)
  for (let i = childIndices.length - 1; i >= 0; i--) {
    events.splice(childIndices[i]!, 1);
  }
}

/** Extract plain text from message payload */
function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as Record<string, unknown>;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

/** Strip SDK teammate-message XML tags from assistant text */
const TEAMMATE_MSG_RE = /<teammate-message[^>]*>[\s\S]*?<\/teammate-message>/g;
function stripTeammateXml(text: string): string {
  if (!text.includes("<teammate-message")) return text;
  return text.replace(TEAMMATE_MSG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}
