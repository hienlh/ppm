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
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

/** Persistent PPM sessionId → SDK sessionId mapping */
const SESSION_MAP_FILE = resolve(homedir(), ".ppm", "session-map.json");

function loadSessionMap(): Record<string, string> {
  try {
    if (existsSync(SESSION_MAP_FILE)) return JSON.parse(readFileSync(SESSION_MAP_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveSessionMapping(ppmId: string, sdkId: string): void {
  const map = loadSessionMap();
  map[ppmId] = sdkId;
  try {
    const dir = resolve(homedir(), ".ppm");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(map));
  } catch {}
}

function getSdkSessionId(ppmId: string): string {
  const map = loadSessionMap();
  return map[ppmId] ?? ppmId;
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

  /** Env vars to neutralize — only if project .env contains them (prevents .env poisoning) */
  private readonly SENSITIVE_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];

  private getProjectEnvOverrides(projectPath?: string): Record<string, string> {
    if (!projectPath) return {};
    try {
      const envPath = resolve(projectPath, ".env");
      if (!existsSync(envPath)) return {};
      const content = readFileSync(envPath, "utf-8");
      const overrides: Record<string, string> = {};
      for (const key of this.SENSITIVE_ENV_KEYS) {
        if (content.includes(key)) {
          overrides[key] = "";
          console.log(`[sdk] Neutralizing ${key} from project .env (prevents poisoning)`);
        }
      }
      return overrides;
    } catch { return {}; }
  }

  /**
   * Direct CLI fallback for Windows — spawns `claude -p` with stream-json output.
   * Workaround for Bun + Windows SDK subprocess pipe buffering issue.
   * Returns an async generator yielding the same event types as SDK query().
   */
  private async *queryDirectCli(opts: {
    prompt: string;
    cwd: string;
    sessionId: string;
    sdkId: string;
    isFirstMessage: boolean;
    shouldFork: boolean;
    env: Record<string, string | undefined>;
    providerConfig: Partial<import("../types/config.ts").AIProviderConfig>;
  }): AsyncGenerator<any> {
    const args = ["-p", opts.prompt, "--verbose", "--output-format", "stream-json"];

    // Session management
    if (!opts.isFirstMessage || opts.shouldFork) {
      args.push("--resume", opts.sdkId);
    }

    // Config-driven options
    if (opts.providerConfig.model) args.push("--model", opts.providerConfig.model);
    const maxTurns = opts.providerConfig.max_turns ?? 100;
    args.push("--max-turns", String(maxTurns));
    if (opts.providerConfig.effort) args.push("--effort", opts.providerConfig.effort);

    // Permission mode
    args.push("--permission-mode", "bypassPermissions", "--dangerously-skip-permissions");

    console.log(`[sdk-cli] spawning: claude ${args.slice(0, 6).join(" ")}... cwd=${opts.cwd}`);

    const proc = Bun.spawn({
      cmd: ["claude", ...args],
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

      // Read stderr if process failed
      if (exitCode !== 0) {
        try {
          const errReader = proc.stderr.getReader();
          const { value: errBytes } = await errReader.read();
          const stderr = errBytes ? new TextDecoder().decode(errBytes).trim() : "";
          if (stderr) console.error(`[sdk-cli] stderr: ${stderr.slice(0, 500)}`);
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
          title: found.summary ?? "Resumed Chat",
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
        title: s.summary ?? s.firstPrompt ?? "Chat",
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
    opts?: { forkSession?: boolean },
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

    /**
     * Approval events to yield from the generator.
     * canUseTool pushes events here; the main loop yields them.
     */
    const approvalEvents: ChatEvent[] = [];
    let approvalNotify: (() => void) | undefined;

    /**
     * canUseTool: only fires for AskUserQuestion (bypassPermissions auto-approves other tools).
     * Pauses SDK execution, yields approval_request to FE, waits for user response.
     */
    const canUseTool = async (toolName: string, input: unknown) => {
      // Non-AskUserQuestion tools: auto-approve (shouldn't reach here with bypassPermissions)
      if (toolName !== "AskUserQuestion") {
        return { behavior: "allow" as const, updatedInput: input };
      }

      const requestId = crypto.randomUUID();

      const APPROVAL_TIMEOUT_MS = 5 * 60_000; // 5min — extended for FE reconnect
      const approvalPromise = new Promise<{ approved: boolean; data?: unknown }>(
        (resolve) => {
          this.pendingApprovals.set(requestId, { resolve });
          // Auto-deny after timeout if FE doesn't respond
          setTimeout(() => {
            if (this.pendingApprovals.has(requestId)) {
              this.pendingApprovals.delete(requestId);
              resolve({ approved: false });
            }
          }, APPROVAL_TIMEOUT_MS);
        },
      );

      // Queue event for the generator to yield to FE
      approvalEvents.push({
        type: "approval_request",
        requestId,
        tool: toolName,
        input,
      });
      approvalNotify?.();

      // Wait for FE to send back answers (or timeout)
      const result = await approvalPromise;

      if (result.approved && result.data) {
        return {
          behavior: "allow" as const,
          updatedInput: { ...(input as Record<string, unknown>), answers: result.data },
        };
      }
      return { behavior: "deny" as const, message: "User skipped the question" };
    };

    let assistantContent = "";
    let resultSubtype: string | undefined;
    let resultNumTurns: number | undefined;
    let resultContextWindowPct: number | undefined;
    try {
      const providerConfig = this.getProviderConfig();
      // Resolve SDK's actual session ID for resume (may differ from PPM's UUID)
      // For fork: use the source session's SDK id
      const sdkId = shouldFork ? getSdkSessionId(forkSourceId!) : getSdkSessionId(sessionId);
      // Fallback cwd: SDK needs a valid working directory even when no project is selected.
      // On Windows daemons, undefined cwd can cause the subprocess to fail silently.
      const effectiveCwd = meta.projectPath || homedir();
      const queryEnv = { ...process.env, ...this.getProjectEnvOverrides(meta.projectPath) };
      console.log(`[sdk] query: session=${sessionId} sdkId=${sdkId} isFirst=${isFirstMessage} fork=${shouldFork} cwd=${effectiveCwd} platform=${process.platform}`);

      // On Windows, use direct CLI fallback (SDK query() hangs due to Bun subprocess pipe buffering)
      const useDirectCli = process.platform === "win32";
      let eventSource: AsyncIterable<any>;

      if (useDirectCli) {
        console.log(`[sdk] Windows detected — using direct CLI fallback (bypasses SDK pipe issue)`);
        eventSource = this.queryDirectCli({
          prompt: message,
          cwd: effectiveCwd,
          sessionId,
          sdkId,
          isFirstMessage,
          shouldFork,
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
            systemPrompt: { type: "preset", preset: "claude_code" },
            settingSources: ["user", "project"],
            env: queryEnv,
            settings: { permissions: { allow: [], deny: [] } },
            allowedTools: [
              "Read", "Write", "Edit", "Bash", "Glob", "Grep",
              "WebSearch", "WebFetch", "AskUserQuestion",
              "Agent", "Skill", "TodoWrite", "ToolSearch",
            ],
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
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

      let sdkEventCount = 0;
      for await (const msg of eventSource) {
        sdkEventCount++;
        if (sdkEventCount === 1) {
          console.log(`[sdk] first event received: type=${(msg as any).type} subtype=${(msg as any).subtype ?? "none"}`);
        }
        // Extract parent_tool_use_id from SDK message (present on subagent-scoped messages)
        const parentId = (msg as any).parent_tool_use_id as string | undefined;

        // Yield any queued approval events
        while (approvalEvents.length > 0) {
          yield approvalEvents.shift()!;
        }

        // Capture SDK session metadata from init message
        if (msg.type === "system" && (msg as any).subtype === "init") {
          const initMsg = msg as any;
          // SDK may assign a different session_id than our UUID
          if (initMsg.session_id && initMsg.session_id !== sessionId) {
            // Persist mapping so resume works after server restart
            saveSessionMapping(sessionId, initMsg.session_id);
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
            // Extract error detail from SDK result if available
            const sdkError = result.error ?? result.error_message ?? result.message ?? "";
            const sdkDetail = typeof sdkError === "string" ? sdkError : JSON.stringify(sdkError);
            const errorMessages: Record<string, string> = {
              error_max_turns: "Agent reached maximum turn limit.",
              error_max_budget_usd: "Agent reached budget limit.",
              error_during_execution: "Agent encountered an error during execution.",
            };
            const baseMsg = errorMessages[subtype] ?? `Agent stopped: ${subtype}`;
            const fullMsg = sdkDetail ? `${baseMsg}\n${sdkDetail}` : baseMsg;
            console.error(`[sdk] result error: subtype=${subtype} turns=${result.num_turns ?? 0} detail=${sdkDetail || "(none)"} raw=${JSON.stringify(result).slice(0, 500)}`);
            yield {
              type: "error",
              message: fullMsg,
            };
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
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error(`[sdk] error: ${msg}`);
      if (!msg.includes("abort") && !msg.includes("closed")) {
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
