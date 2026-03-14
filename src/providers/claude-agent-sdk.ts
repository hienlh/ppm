import { query, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { AIProvider, Session, SessionConfig, SessionInfo, ChatEvent, ToolApprovalHandler } from "./provider.interface.ts";

export class ClaudeAgentSdkProvider implements AIProvider {
  readonly id = "claude";
  readonly name = "Claude (Agent SDK)";

  private toolApprovalHandler: ToolApprovalHandler | undefined;

  onToolApproval(callback: ToolApprovalHandler): void {
    this.toolApprovalHandler = callback;
  }

  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    return {
      id,
      title: config.title ?? "New session",
      createdAt: new Date().toISOString(),
    };
  }

  async resumeSession(sessionId: string): Promise<Session> {
    return {
      id: sessionId,
      title: "Resumed session",
      createdAt: new Date().toISOString(),
    };
  }

  async listSessions(): Promise<SessionInfo[]> {
    try {
      const sessions = await listSessions({ limit: 50 });
      return sessions.map((s) => ({
        id: s.sessionId,
        title: s.summary ?? s.firstPrompt ?? s.sessionId,
        createdAt: new Date(s.lastModified).toISOString(),
        messageCount: 0,
      }));
    } catch {
      return [];
    }
  }

  async deleteSession(_sessionId: string): Promise<void> {
    // SDK does not expose a delete API; sessions are disk files managed by Claude Code
  }

  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    const isResume = sessionId !== "" && !sessionId.startsWith("new-");

    const canUseTool = this.toolApprovalHandler
      ? async (
          toolName: string,
          input: Record<string, unknown>,
          opts: { toolUseID: string }
        ) => {
          const requestId = opts.toolUseID;
          try {
            const approved = await this.toolApprovalHandler!({
              requestId,
              tool: toolName,
              input,
              sessionId,
            });
            return approved
              ? ({ behavior: "allow" } as const)
              : ({ behavior: "deny", message: "User denied" } as const);
          } catch {
            return { behavior: "deny", message: "Approval error" } as const;
          }
        }
      : undefined;

    const options = {
      ...(isResume ? { resume: sessionId } : { sessionId }),
      cwd: process.cwd(),
      ...(canUseTool ? { canUseTool } : {}),
    };

    try {
      const q = query({ prompt: message, options });

      for await (const msg of q) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              yield { type: "text", content: block.text };
            } else if (block.type === "tool_use") {
              yield { type: "tool_use", tool: block.name, input: block.input };
            }
          }
        } else if (msg.type === "result") {
          if (msg.subtype === "success") {
            yield { type: "done", sessionId: msg.session_id };
          } else {
            const errors = "errors" in msg ? msg.errors : [];
            yield { type: "error", message: errors.join("; ") || msg.subtype };
          }
        }
      }
    } catch (err) {
      yield { type: "error", message: String(err) };
    }
  }
}
