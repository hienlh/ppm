import type {
  AIProvider,
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
} from "./provider.interface.ts";

/**
 * AI provider that spawns the `claude` CLI as a subprocess.
 * Uses `claude --session-id <id> --output-format stream-json -p <message>`
 * to stream responses back as ChatEvent items.
 */
export class ClaudeCodeCliProvider implements AIProvider {
  id = "claude";
  name = "Claude Code";

  private sessions = new Map<string, Session>();
  private messageHistory = new Map<string, ChatMessage[]>();

  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      providerId: this.id,
      title: config.title ?? "New Chat",
      projectName: config.projectName,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    this.messageHistory.set(id, []);
    return session;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      providerId: s.providerId,
      title: s.title,
      projectName: s.projectName,
      createdAt: s.createdAt,
    }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.messageHistory.delete(sessionId);
  }

  async *sendMessage(
    sessionId: string,
    message: string,
  ): AsyncIterable<ChatEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      yield { type: "error", message: "Session not found" };
      return;
    }

    // Update title from first message
    if (session.title === "New Chat") {
      session.title = message.slice(0, 50) + (message.length > 50 ? "..." : "");
    }

    // Store user message
    const history = this.messageHistory.get(sessionId) ?? [];
    history.push({
      id: crypto.randomUUID(),
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    });

    const args = [
      "--output-format", "stream-json",
      "--verbose",
      "-p", message,
    ];

    // Remove CLAUDECODE env to avoid "nested session" error
    const env = { ...process.env };
    delete env.CLAUDECODE;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["claude", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
    } catch (e) {
      yield { type: "error", message: `Failed to spawn claude CLI: ${(e as Error).message}` };
      return;
    }

    let assistantContent = "";

    try {
      const stdout = proc.stdout as ReadableStream<Uint8Array> | undefined;
      if (!stdout) {
        yield { type: "error", message: "Failed to get stdout from claude CLI" };
        return;
      }
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last partial line in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue; // Skip non-JSON lines
          }

          const event = mapCliEventToChatEvent(parsed);
          if (event) {
            if (event.type === "text") {
              assistantContent += event.content;
            }
            yield event;
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim()) as Record<string, unknown>;
          const event = mapCliEventToChatEvent(parsed);
          if (event) {
            if (event.type === "text") {
              assistantContent += event.content;
            }
            yield event;
          }
        } catch {
          // ignore partial JSON
        }
      }
    } catch (e) {
      yield { type: "error", message: `Stream error: ${(e as Error).message}` };
    }

    // Store assistant message
    history.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: assistantContent,
      timestamp: new Date().toISOString(),
    });
    this.messageHistory.set(sessionId, history);

    yield { type: "done", sessionId };
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.messageHistory.get(sessionId) ?? [];
  }
}

/**
 * Map Claude CLI stream-json events to our ChatEvent type.
 * The CLI outputs JSON objects with a `type` field.
 */
/**
 * Map Claude CLI stream-json events to ChatEvent.
 * Actual CLI output format (from testing):
 * - {type:"system", subtype:"init", ...} — ignore
 * - {type:"assistant", message:{content:[{type:"text",text:"..."}]}} — extract text
 * - {type:"result", result:"full text", session_id:"..."} — final result
 * - {type:"rate_limit_event"} — ignore
 */
function mapCliEventToChatEvent(
  event: Record<string, unknown>,
): ChatEvent | null {
  const type = event.type as string | undefined;

  switch (type) {
    case "assistant": {
      // Claude CLI wraps in {type:"assistant", message:{content:[{type:"text",text:"..."}]}}
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.content && Array.isArray(msg.content)) {
        const blocks = msg.content as Array<Record<string, unknown>>;
        const textBlocks = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string);
        if (textBlocks.length > 0) {
          return { type: "text", content: textBlocks.join("") };
        }
        // Check for tool_use blocks
        for (const block of blocks) {
          if (block.type === "tool_use") {
            return {
              type: "tool_use",
              tool: (block.name as string) ?? "unknown",
              input: block.input ?? {},
            };
          }
        }
      }
      return null;
    }

    case "result":
      // Final result — don't duplicate if we already got assistant text
      return null;

    case "tool_result":
      return {
        type: "tool_result",
        output: typeof event.output === "string"
          ? event.output
          : JSON.stringify(event.output ?? ""),
      };

    case "error":
      return {
        type: "error",
        message: typeof event.error === "string"
          ? event.error
          : (event.message as string) ?? "Unknown error",
      };

    // Ignore system, rate_limit_event, etc.
    default:
      return null;
  }
}
