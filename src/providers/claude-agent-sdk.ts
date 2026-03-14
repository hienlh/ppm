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

/**
 * AI provider using @anthropic-ai/claude-agent-sdk.
 * Sessions are persisted by Claude Code itself (~/.claude/projects/).
 * We only keep a lightweight in-memory map for active session metadata.
 */
export class ClaudeAgentSdkProvider implements AIProvider {
  id = "claude-sdk";
  name = "Claude Agent SDK";

  /** Active session metadata (not messages — those live in Claude's JSONL) */
  private activeSessions = new Map<string, Session>();
  /** Track message count per session to know first vs continuation */
  private messageCount = new Map<string, number>();

  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    const meta: Session = {
      id,
      providerId: this.id,
      title: config.title ?? "New Chat",
      projectName: config.projectName,
      createdAt: new Date().toISOString(),
    };
    this.activeSessions.set(id, meta);
    this.messageCount.set(id, 0);
    return meta;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const existing = this.activeSessions.get(sessionId);
    if (existing) return existing;

    // Try to find in SDK's persisted sessions
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
        this.messageCount.set(sessionId, 1); // Mark as continuation
        return meta;
      }
    } catch {
      // SDK not available — create minimal session
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

  /** List sessions filtered by project directory */
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

  async *sendMessage(
    sessionId: string,
    message: string,
  ): AsyncIterable<ChatEvent> {
    // Ensure session exists
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

    let assistantContent = "";

    try {
      const q = query({
        prompt: message,
        options: {
          sessionId: isFirstMessage ? sessionId : undefined,
          resume: isFirstMessage ? undefined : sessionId,
          allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
        } as any,
      });

      let lastPartialText = "";

      for await (const msg of q) {
        // Partial assistant message — real streaming text deltas
        if ((msg as any).type === "partial") {
          const partial = msg as any;
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
                yield {
                  type: "tool_use",
                  tool: block.name ?? "unknown",
                  input: block.input ?? {},
                };
              }
            }
          }
          continue;
        }

        if (msg.type === "result") {
          break;
        }
      }
    } catch (e) {
      yield { type: "error", message: `SDK error: ${(e as Error).message}` };
    }

    yield { type: "done", sessionId };
  }

  /**
   * Get messages from SDK's persisted session transcript.
   * Falls back to empty array if session not found.
   */
  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    try {
      const messages = await getSessionMessages(sessionId);
      return messages.map((msg) => {
        const content = extractTextFromMessage(msg.message);
        return {
          id: msg.uuid,
          role: msg.type as "user" | "assistant",
          content,
          timestamp: new Date().toISOString(),
        };
      });
    } catch {
      return [];
    }
  }
}

/** Extract text content from SDK's raw message payload */
function extractTextFromMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";

  const msg = message as Record<string, unknown>;

  // SDK message format: { content: string | Array<{type, text}> }
  if (typeof msg.content === "string") return msg.content;

  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }

  return JSON.stringify(message);
}
