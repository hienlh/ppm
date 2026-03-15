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
  UsageInfo,
} from "./provider.interface.ts";

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
  id = "claude-sdk";
  name = "Claude Agent SDK";

  private activeSessions = new Map<string, Session>();
  private messageCount = new Map<string, number>();
  /** Pending approval promises keyed by requestId */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Active query objects for abort support */
  private activeQueries = new Map<string, { close: () => void }>();
  /** Latest known usage/rate-limit info (shared across all sessions) */
  private latestUsage: UsageInfo = {};

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

    try {
      const sdkSessions = await sdkListSessions({ limit: 100 });
      const found = sdkSessions.find((s) => s.sessionId === sessionId);
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

    const meta: Session = {
      id: sessionId,
      providerId: this.id,
      title: "Resumed Chat",
      createdAt: new Date().toISOString(),
    };
    this.activeSessions.set(sessionId, meta);
    this.messageCount.set(sessionId, 1);
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

      const approvalPromise = new Promise<{ approved: boolean; data?: unknown }>(
        (resolve) => {
          this.pendingApprovals.set(requestId, { resolve });
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

      // Wait for FE to send back answers
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

    try {
      const q = query({
        prompt: message,
        options: {
          sessionId: isFirstMessage ? sessionId : undefined,
          resume: isFirstMessage ? undefined : sessionId,
          cwd: meta.projectPath,
          settingSources: meta.projectPath ? ["project"] : undefined,
          allowedTools: [
            "Read", "Write", "Edit", "Bash", "Glob", "Grep",
            "WebSearch", "WebFetch", "AskUserQuestion",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          canUseTool,
          includePartialMessages: true,
        } as any,
      });

      // Track active query for abort support
      this.activeQueries.set(sessionId, q);

      let lastPartialText = "";
      /** Number of tool_use blocks pending results (tools executing internally by SDK) */
      let pendingToolCount = 0;

      for await (const msg of q) {
        // Debug: log all SDK events to understand flow
        console.log(`[SDK:${sessionId.slice(0,8)}] event type=${msg.type}`, msg.type === "assistant" ? `blocks=${JSON.stringify(((msg as any).message?.content ?? []).map((b:any) => b.type))}` : "");

        // Yield any queued approval events
        while (approvalEvents.length > 0) {
          yield approvalEvents.shift()!;
        }

        // When tools were pending and a new assistant/stream_event arrives,
        // the SDK has finished executing tools. Fetch tool_results from session history.
        if (pendingToolCount > 0 && (msg.type === "assistant" || (msg as any).type === "partial" || (msg as any).type === "stream_event")) {
          try {
            const sessionMsgs = await getSessionMessages(sessionId);
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
            if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
              const text = event.delta.text ?? "";
              if (text) {
                lastPartialText += text;
                yield { type: "text", content: text };
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
              yield { type: "text", content: delta };
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
                  yield { type: "text", content: block.text.slice(lastPartialText.length) };
                } else if (lastPartialText.length === 0) {
                  yield { type: "text", content: block.text };
                }
                assistantContent += block.text;
                lastPartialText = "";
              } else if (block.type === "tool_use") {
                pendingToolCount++;
                yield {
                  type: "tool_use",
                  tool: block.name ?? "unknown",
                  input: block.input ?? {},
                  toolUseId: block.id as string | undefined,
                };
              }
            }
          }
          continue;
        }

        // Rate limit event — extract utilization percentages
        if ((msg as any).type === "rate_limit_event") {
          const info = (msg as any).rate_limit_info;
          if (info) {
            const rateLimitType = info.rateLimitType as string | undefined;
            const utilization = info.utilization as number | undefined;
            if (rateLimitType && utilization != null) {
              const usage: Record<string, number> = {};
              if (rateLimitType === "five_hour") usage.fiveHour = utilization;
              else if (rateLimitType.startsWith("seven_day")) usage.sevenDay = utilization;
              // Cache latest rate limits
              Object.assign(this.latestUsage, usage);
              yield { type: "usage", usage };
            }
          }
          continue;
        }

        if (msg.type === "result") {
          // Flush any remaining pending tool_results before finishing
          if (pendingToolCount > 0) {
            try {
              const sessionMsgs = await getSessionMessages(sessionId);
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
          // Yield final cost + any rate limit info from result
          const usage: Record<string, unknown> = {};
          if (result.total_cost_usd != null) usage.totalCostUsd = result.total_cost_usd;
          if (Object.keys(usage).length > 0) {
            yield { type: "usage", usage };
          }
          break;
        }
      }

      // Yield remaining approval events
      while (approvalEvents.length > 0) {
        yield approvalEvents.shift()!;
      }
    } catch (e) {
      const msg = (e as Error).message;
      // Don't yield error for intentional abort
      if (!msg.includes("abort")) {
        yield { type: "error", message: `SDK error: ${msg}` };
      }
    } finally {
      this.activeQueries.delete(sessionId);
    }

    yield { type: "done", sessionId };
  }

  /** Get latest cached usage/rate-limit info */
  getUsage(): UsageInfo {
    return { ...this.latestUsage };
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
      const messages = await getSessionMessages(sessionId);
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

      return merged.filter(
        (msg) => msg.content.trim().length > 0 || (msg.events && msg.events.length > 0),
      );
    } catch {
      return [];
    }
  }
}

/** Parse SDK SessionMessage into ChatMessage with events for tool_use blocks */
function parseSessionMessage(msg: { uuid: string; type: string; message: unknown }): ChatMessage {
  const message = msg.message as Record<string, unknown> | undefined;
  const role = msg.type as "user" | "assistant";

  // Parse content blocks for both user and assistant messages
  const events: ChatEvent[] = [];
  let textContent = "";

  if (message && Array.isArray(message.content)) {
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        textContent += block.text;
        if (role === "assistant") {
          events.push({ type: "text", content: block.text });
        }
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool_use",
          tool: (block.name as string) ?? "unknown",
          input: block.input ?? {},
          toolUseId: block.id as string | undefined,
        });
      } else if (block.type === "tool_result") {
        const output = block.content ?? block.output ?? "";
        events.push({
          type: "tool_result",
          output: typeof output === "string" ? output : JSON.stringify(output),
          isError: !!(block as Record<string, unknown>).is_error,
          toolUseId: block.tool_use_id as string | undefined,
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
