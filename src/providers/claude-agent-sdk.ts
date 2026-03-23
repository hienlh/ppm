import {
  query,
  listSessions as sdkListSessions,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AIProvider,
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
} from "./provider.interface.ts";
import { configService } from "../services/config.service.ts";
import { updateFromSdkEvent } from "../services/claude-usage.service.ts";
import { getSessionMapping, setSessionMapping } from "../services/db.service.ts";
import { accountSelector } from "../services/account-selector.service.ts";
import { accountService } from "../services/account.service.ts";
import { resolve } from "node:path";
import { homedir } from "node:os";

function getSdkSessionId(ppmId: string): string {
  return getSessionMapping(ppmId) ?? ppmId;
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

    // Resolve each auth var: settings > shell env > "" (blocks project .env)
    const resolvedApiKey = account
      ? (account.accessToken.startsWith("sk-ant-oat") ? "" : account.accessToken)
      : (process.env.ANTHROPIC_API_KEY ?? "");
    const resolvedOAuth = account
      ? (account.accessToken.startsWith("sk-ant-oat") ? account.accessToken : "")
      : (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "");
    const resolvedBaseUrl = providerConfig.base_url
      || process.env.ANTHROPIC_BASE_URL
      || "";
    const resolvedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN ?? "";

    // Log resolved sources
    if (account) {
      console.log(`[sdk] Auth from PPM account (${account.accessToken.startsWith("sk-ant-oat") ? "OAuth" : "API key"})`);
    } else if (process.env.ANTHROPIC_API_KEY) {
      console.log(`[sdk] ANTHROPIC_API_KEY from shell env (length=${process.env.ANTHROPIC_API_KEY.length})`);
    }
    if (providerConfig.base_url) {
      console.log(`[sdk] ANTHROPIC_BASE_URL from settings: ${providerConfig.base_url}`);
    } else if (process.env.ANTHROPIC_BASE_URL) {
      console.log(`[sdk] ANTHROPIC_BASE_URL from shell env: ${process.env.ANTHROPIC_BASE_URL}`);
    }

    return {
      ...base,
      ANTHROPIC_API_KEY: resolvedApiKey,
      CLAUDE_CODE_OAUTH_TOKEN: resolvedOAuth,
      ANTHROPIC_BASE_URL: resolvedBaseUrl,
      ANTHROPIC_AUTH_TOKEN: resolvedAuthToken,
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

  /**
   * Direct CLI fallback for Windows — spawns `claude -p` with stream-json output.
   * Workaround for Bun + Windows SDK subprocess pipe buffering issue.
   * Returns an async generator yielding the same event types as SDK query().
   *
   * TODO: Remove this fallback when TypeScript SDK fixes Windows stdin pipe buffering.
   * Tracking issues:
   *   - Python SDK #208 (FIXED): https://github.com/anthropics/claude-agent-sdk-python/issues/208
   *     Fix: stdin drain() after writes — TypeScript SDK lacks equivalent fix.
   *   - TS SDK #44 (OPEN): https://github.com/anthropics/claude-agent-sdk-typescript/issues/44
   *     query() yields zero events for 3+ minutes on Windows.
   *   - TS SDK #64 (OPEN): https://github.com/anthropics/claude-agent-sdk-typescript/issues/64
   *     Bash tool hangs on empty output — related pipe/EOF handling issue.
   * When these are resolved, switch back to SDK query() by removing the
   * `useDirectCli` branch in sendMessage() and deleting this method.
   */
  private async *queryDirectCli(opts: {
    prompt: string;
    cwd: string;
    sessionId: string;
    resumeSessionId?: string;
    env: Record<string, string | undefined>;
    providerConfig: Partial<import("../types/config.ts").AIProviderConfig>;
  }): AsyncGenerator<any> {
    const args = ["-p", opts.prompt, "--verbose", "--output-format", "stream-json"];

    // Session management — resume if caller confirmed a valid session ID
    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    // Config-driven options
    if (opts.providerConfig.model) args.push("--model", opts.providerConfig.model);
    const maxTurns = opts.providerConfig.max_turns ?? 100;
    args.push("--max-turns", String(maxTurns));
    if (opts.providerConfig.effort) args.push("--effort", opts.providerConfig.effort);

    // Permission mode
    args.push("--permission-mode", opts.providerConfig.permission_mode ?? "bypassPermissions");
    if ((opts.providerConfig.permission_mode ?? "bypassPermissions") === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }

    // System prompt — CLI uses --append-system-prompt flag
    if (opts.providerConfig.system_prompt) {
      args.push("--append-system-prompt", opts.providerConfig.system_prompt);
    }

    // On Windows, `claude` is a .cmd wrapper (npm global) — Bun.spawn can't resolve .cmd
    // files directly. Use `cmd /c` to let the Windows shell find it via PATH.
    const cmd = process.platform === "win32"
      ? ["cmd", "/c", "claude", ...args]
      : ["claude", ...args];
    console.log(`[sdk-cli] spawning: ${cmd.slice(0, 7).join(" ")}... cwd=${opts.cwd}`);

    const proc = Bun.spawn({
      cmd,
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env as Record<string, string>,
    });

    // Store proc for abort support
    const abortHandle = { close: () => { try { proc.kill(); } catch {} } };
    this.activeQueries.set(opts.sessionId, abortHandle as any);

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep incomplete last line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            // CLI stream-json doesn't emit per-token stream_event deltas — it sends
            // complete assistant messages. Synthesize stream_event deltas so the FE
            // gets a smooth streaming experience (same as SDK with includePartialMessages).
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  // Emit text in ~30-char chunks as synthetic stream_event deltas
                  const text = block.text as string;
                  const CHUNK = 30;
                  for (let i = 0; i < text.length; i += CHUNK) {
                    yield {
                      type: "stream_event",
                      event: {
                        type: "content_block_delta",
                        delta: { type: "text_delta", text: text.slice(i, i + CHUNK) },
                      },
                    };
                  }
                } else if (block.type === "thinking" && block.thinking) {
                  yield {
                    type: "stream_event",
                    event: {
                      type: "content_block_delta",
                      delta: { type: "thinking_delta", thinking: block.thinking },
                    },
                  };
                }
              }
            }
            // Always yield the original event too (for init, result, rate_limit, etc.)
            yield event;
          } catch {
            // Skip non-JSON lines (e.g. progress indicators)
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try { yield JSON.parse(buffer.trim()); } catch {}
      }

      // Wait for process to exit
      const exitCode = await proc.exited;
      console.log(`[sdk-cli] process exited: code=${exitCode}`);

      // Read all stderr and surface error to frontend
      if (exitCode !== 0) {
        try {
          const errReader = proc.stderr.getReader();
          const stderrDecoder = new TextDecoder();
          const errParts: string[] = [];
          while (true) {
            const { done, value } = await errReader.read();
            if (done) break;
            if (value) errParts.push(stderrDecoder.decode(value, { stream: true }));
          }
          const fullStderr = errParts.join("").trim();
          if (fullStderr) {
            // Actual error is at the END (minified source dump comes first)
            console.error(`[sdk-cli] stderr (last 1500): ${fullStderr.slice(-1500)}`);
            // Extract meaningful error line (e.g. "Error: ...", "TypeError: ...")
            const errMatch = fullStderr.match(/\b(?:Error|TypeError|SyntaxError|ReferenceError|RangeError):\s*.+/);
            const errorMsg = errMatch ? errMatch[0].slice(0, 500) : fullStderr.slice(-300);
            yield {
              type: "result",
              subtype: "error_during_execution",
              error: `CLI exited with code ${exitCode}: ${errorMsg}`,
            };
          }
        } catch {}
      }
    } finally {
      this.activeQueries.delete(opts.sessionId);
      try { proc.kill(); } catch {}
    }
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
    return meta;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const existing = this.activeSessions.get(sessionId);
    if (existing) return existing;

    // Check if we have a mapped SDK session ID (from a previous query)
    const mappedSdkId = getSdkSessionId(sessionId);

    try {
      const sdkSessions = await sdkListSessions({ limit: 100 });
      const found = sdkSessions.find(
        (s) => s.sessionId === sessionId || s.sessionId === mappedSdkId,
      );
      if (found) {
        const meta: Session = {
          id: sessionId,
          providerId: this.id,
          title: found.customTitle ?? found.summary ?? "Resumed Chat",
          createdAt: new Date(found.lastModified).toISOString(),
        };
        this.activeSessions.set(sessionId, meta);
        this.messageCount.set(sessionId, 1);
        return meta;
      }
    } catch {
      // SDK not available
    }

    // Session not found in SDK history — treat as new so first message
    // creates a fresh SDK session instead of trying to resume.
    const meta: Session = {
      id: sessionId,
      providerId: this.id,
      title: "Resumed Chat",
      createdAt: new Date().toISOString(),
    };
    this.activeSessions.set(sessionId, meta);
    this.messageCount.set(sessionId, 0);
    return meta;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.listSessionsByDir();
  }

  async listSessionsByDir(dir?: string): Promise<SessionInfo[]> {
    try {
      const sdkSessions = await sdkListSessions({ dir, limit: 50 });
      return sdkSessions.map((s) => ({
        id: s.sessionId,
        providerId: this.id,
        title: s.customTitle ?? s.summary ?? s.firstPrompt ?? "Chat",
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

  async deleteSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    this.messageCount.delete(sessionId);
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

  async *sendMessage(
    sessionId: string,
    message: string,
    opts?: import("./provider.interface.ts").SendMessageOpts & { forkSession?: boolean },
  ): AsyncIterable<ChatEvent> {
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
    const allowedTools = isBypass
      ? [...readOnlyTools, ...writeTools]
      : readOnlyTools;

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
    try {
      // Resolve SDK's actual session ID for resume (may differ from PPM's UUID)
      // For fork: use the source session's SDK id
      const sdkId = shouldFork ? getSdkSessionId(forkSourceId!) : getSdkSessionId(sessionId);
      // Fallback cwd: SDK needs a valid working directory even when no project is selected.
      // On Windows daemons, undefined cwd can cause the subprocess to fail silently.
      const effectiveCwd = meta.projectPath || homedir();

      // Account-based auth injection (multi-account mode)
      // Fallback to existing env (ANTHROPIC_API_KEY) when no accounts configured.
      const accountsEnabled = accountSelector.isEnabled();
      const account = accountsEnabled ? accountSelector.next() : null;
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
      if (account) {
        console.log(`[sdk] Using account ${account.id} (${account.email ?? "no-email"})`);
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

      // TODO: Remove when TS SDK fixes Windows stdin pipe buffering (see queryDirectCli() JSDoc for tracking issues)
      // On Windows, SDK query() hangs because Bun subprocess stdin pipe never flushes to child process.
      const useDirectCli = process.platform === "win32";
      let eventSource: AsyncIterable<any>;

      if (useDirectCli) {
        // Determine resumeSessionId for CLI --resume flag:
        // 1. Explicit mapping exists (sdkId !== sessionId) → use mapped SDK ID
        // 2. No mapping but session has messages on disk → session was created with PPM UUID, resume it
        // 3. No mapping, no messages → truly new session, don't resume
        let resumeSessionId: string | undefined;
        if (sdkId !== sessionId) {
          resumeSessionId = sdkId;
        } else if (!isFirstMessage) {
          try {
            const existingMsgs = await getSessionMessages(sessionId);
            if (existingMsgs.length > 0) {
              resumeSessionId = sessionId;
              setSessionMapping(sessionId, sessionId);
              console.log(`[sdk] session ${sessionId} exists on disk (${existingMsgs.length} msgs) — will resume`);
            }
          } catch {}
        }
        console.log(`[sdk] Windows detected — using direct CLI fallback (resume=${resumeSessionId ?? "none"})`);
        eventSource = this.queryDirectCli({
          prompt: message,
          cwd: effectiveCwd,
          sessionId,
          resumeSessionId,
          env: queryEnv,
          providerConfig,
        });
      } else {
        const q = query({
          prompt: message,
          options: {
            sessionId: isFirstMessage && !shouldFork ? sessionId : undefined,
            resume: (isFirstMessage && !shouldFork) ? undefined : sdkId,
            ...(shouldFork && { forkSession: true }),
            cwd: effectiveCwd,
            systemPrompt: systemPromptOpt,
            settingSources: ["user", "project"],
            env: queryEnv,
            settings: { permissions: { allow: [], deny: [] } },
            allowedTools,
            permissionMode,
            allowDangerouslySkipPermissions: isBypass,
            ...(permissionHooks && { hooks: permissionHooks }),
            ...(providerConfig.model && { model: providerConfig.model }),
            ...(providerConfig.effort && { effort: providerConfig.effort }),
            maxTurns: providerConfig.max_turns ?? 100,
            ...(providerConfig.max_budget_usd && { maxBudgetUsd: providerConfig.max_budget_usd }),
            ...(providerConfig.thinking_budget_tokens != null && {
              thinkingBudgetTokens: providerConfig.thinking_budget_tokens,
            }),
            canUseTool,
            includePartialMessages: true,
          } as any,
        });
        this.activeQueries.set(sessionId, q);
        eventSource = q;
      }

      let lastPartialText = "";
      /** Number of tool_use blocks pending results (top-level tools only, not subagent children) */
      let pendingToolCount = 0;

      // Retry logic: if SDK returns error_during_execution with 0 turns on first event,
      // it's a transient subprocess failure — retry once before surfacing the error.
      const MAX_RETRIES = 1;
      let retryCount = 0;

      retryLoop: while (true) {
      let sdkEventCount = 0;
      for await (const msg of eventSource) {
        sdkEventCount++;
        if (sdkEventCount === 1) {
          console.log(`[sdk] first event received: type=${(msg as any).type} subtype=${(msg as any).subtype ?? "none"}`);
          // Detect immediate failure: first event is a result with error + 0 turns
          if ((msg as any).type === "result" && (msg as any).subtype === "error_during_execution" && ((msg as any).num_turns ?? 0) === 0 && retryCount < MAX_RETRIES) {
            retryCount++;
            console.warn(`[sdk] transient error on first event — retrying (attempt ${retryCount}/${MAX_RETRIES})`);
            // Re-create query for retry — don't reuse sessionId in case SDK partially created it
            if (!useDirectCli) {
              const q = query({
                prompt: message,
                options: {
                  // On retry, let SDK generate a fresh session to avoid conflicts
                  sessionId: undefined,
                  resume: undefined,
                  ...(shouldFork && { forkSession: true }),
                  cwd: effectiveCwd,
                  systemPrompt: systemPromptOpt,
                  settingSources: ["user", "project"],
                  env: queryEnv,
                  settings: { permissions: { allow: [], deny: [] } },
                  allowedTools,
                  permissionMode,
                  allowDangerouslySkipPermissions: isBypass,
                  ...(permissionHooks && { hooks: permissionHooks }),
                  ...(providerConfig.model && { model: providerConfig.model }),
                  ...(providerConfig.effort && { effort: providerConfig.effort }),
                  maxTurns: providerConfig.max_turns ?? 100,
                  ...(providerConfig.max_budget_usd && { maxBudgetUsd: providerConfig.max_budget_usd }),
                  ...(providerConfig.thinking_budget_tokens != null && {
                    thinkingBudgetTokens: providerConfig.thinking_budget_tokens,
                  }),
                  canUseTool,
                  includePartialMessages: true,
                } as any,
              });
              this.activeQueries.set(sessionId, q);
              eventSource = q;
            }
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
          console.log(`[sdk] session=${sessionId} system: subtype=${(msg as any).subtype ?? "none"} ${JSON.stringify(msg).slice(0, 500)}`);
        }

        // Capture SDK session metadata from init message
        if (msg.type === "system" && (msg as any).subtype === "init") {
          const initMsg = msg as any;
          // SDK may assign a different session_id than our UUID
          if (initMsg.session_id && initMsg.session_id !== sessionId) {
            // Persist mapping so resume works after server restart
            setSessionMapping(sessionId, initMsg.session_id);
            // Update our in-memory mapping
            const oldMeta = this.activeSessions.get(sessionId);
            if (oldMeta) {
              this.activeSessions.set(initMsg.session_id, { ...oldMeta, id: initMsg.session_id });
            }
          }
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
          const assistantError = (msg as any).error as string | undefined;
          if (assistantError) {
            // Dump full SDK message for debugging
            console.error(`[sdk] session=${sessionId} cwd=${effectiveCwd} assistant error: ${assistantError} (isFirst=${isFirstMessage} retry=${retryCount})`);
            console.error(`[sdk] assistant message dump: ${JSON.stringify(msg).slice(0, 2000)}`);
            const errorHints: Record<string, string> = {
              authentication_failed: "API authentication failed. Check your account credentials in Settings → Accounts.",
              billing_error: "Billing error on this account. Check your subscription status.",
              rate_limit: "Rate limited by the API. Please wait and try again.",
              invalid_request: "Invalid request sent to the API.",
              server_error: "Anthropic API server error. Try again shortly.",
              unknown: `API error in project "${effectiveCwd}". Debug:\n1. Run: \`cd ${effectiveCwd} && claude -p "hi"\`\n2. Check env: \`echo $ANTHROPIC_API_KEY $ANTHROPIC_BASE_URL\` — stale/invalid keys cause this\n3. Try: \`ANTHROPIC_API_KEY="" ANTHROPIC_BASE_URL="" claude -p "hi"\`\n4. Refresh auth: \`claude login\``,
            };
            const hint = errorHints[assistantError] ?? `API error: ${assistantError}`;
            yield { type: "error", message: hint };
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
              // Post-stream 429 already has content — surface error to user
              yield { type: "error", message: "Rate limited. This account is now on cooldown. Please retry." };
              break;
            } else if (errCode === 401) {
              // Try refresh once
              try {
                await accountService.refreshAccessToken(account.id);
                console.log(`[sdk] 401 on account ${account.id} — token refreshed`);
              } catch {
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
          if (subtype && subtype !== "success") {
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
          break;
        }
      }

      // Yield remaining approval events
      while (approvalEvents.length > 0) {
        yield approvalEvents.shift()!;
      }

      if (sdkEventCount === 0) {
        yield { type: "error", message: "Claude did not respond. Check that 'claude' CLI works in your terminal." };
      }
      break; // Exit retryLoop — normal completion
      } // end retryLoop
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error(`[sdk] session=${sessionId} cwd=${meta.projectPath} error: ${msg}`);
      if (msg.includes("abort") || msg.includes("closed")) {
        // User-initiated abort or WS closed — nothing to report
      } else if (!isFirstMessage && msg.includes("exited with code")) {
        // SDK subprocess crashed during session resume — retry as fresh session
        console.warn(`[sdk] session resume failed, retrying as fresh session`);
        try {
          const providerConfig = this.getProviderConfig();
          const effectiveCwd = meta.projectPath || homedir();
          const retryAccount = accountSelector.isEnabled() ? accountSelector.next() : null;
          const queryEnv = this.buildQueryEnv(meta.projectPath, retryAccount);
          const retryQuery = query({
            prompt: message,
            options: {
              cwd: effectiveCwd,
              systemPrompt: systemPromptOpt,
              settingSources: ["user", "project"],
              env: queryEnv,
              settings: { permissions: { allow: [], deny: [] } },
              allowedTools,
              permissionMode,
              allowDangerouslySkipPermissions: isBypass,
              ...(permissionHooks && { hooks: permissionHooks }),
              ...(providerConfig.model && { model: providerConfig.model }),
              maxTurns: providerConfig.max_turns ?? 100,
              canUseTool,
              includePartialMessages: true,
            } as any,
          });
          this.activeQueries.set(sessionId, retryQuery);
          for await (const retryMsg of retryQuery) {
            if (retryMsg.type === "system") continue;
            if (retryMsg.type === "result") {
              const r = retryMsg as any;
              if (r.subtype && r.subtype !== "success") {
                const retryErrors = Array.isArray(r.errors) ? r.errors.join("\n") : "";
                yield { type: "error", message: retryErrors || `Agent stopped: ${r.subtype}` };
              }
              resultSubtype = r.subtype;
              resultNumTurns = r.num_turns;
              break;
            }
            if ((retryMsg as any).type === "assistant") {
              const content = (retryMsg as any).message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && typeof block.text === "string") {
                    yield { type: "text", content: block.text };
                  }
                }
              }
            }
          }
        } catch (retryErr) {
          const retryMsg = (retryErr as Error).message ?? String(retryErr);
          console.error(`[sdk] retry also failed: ${retryMsg}`);
          yield { type: "error", message: `SDK error: ${msg}` };
        }
      } else {
        yield { type: "error", message: `SDK error: ${msg}` };
      }
    } finally {
      this.activeQueries.delete(sessionId);
    }

    yield {
      type: "done",
      sessionId,
      resultSubtype: resultSubtype as any,
      numTurns: resultNumTurns,
      contextWindowPct: resultContextWindowPct,
    };
  }


  /** Abort an active query for a session */
  abortQuery(sessionId: string): void {
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
        textContent += block.text;
        if (role === "assistant") {
          events.push({ type: "text", content: block.text, ...(parentId && { parentToolUseId: parentId }) });
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
