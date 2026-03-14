import type {
  AIProvider,
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
} from "./provider.interface.ts";
import { findClaudeBinary } from "./claude-binary-finder.ts";
import { processRegistry } from "./claude-process-registry.ts";

/**
 * Stream-JSON event types from Claude CLI.
 * Each line of stdout is one complete JSON object.
 * Mirrors opcode's line-by-line parsing approach.
 */
interface CliSystemEvent {
  type: "system";
  subtype: "init" | string;
  session_id?: string;
  [key: string]: unknown;
}

interface CliAssistantEvent {
  type: "assistant";
  message: {
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; name: string; input: unknown; id?: string }
    >;
  };
}

interface CliResultEvent {
  type: "result";
  result?: string;
  session_id?: string;
  is_error?: boolean;
}

interface CliToolResultEvent {
  type: "tool_result";
  output?: unknown;
  content?: unknown;
}

interface CliErrorEvent {
  type: "error";
  error?: string;
  message?: string;
}

type CliEvent =
  | CliSystemEvent
  | CliAssistantEvent
  | CliResultEvent
  | CliToolResultEvent
  | CliErrorEvent
  | { type: string; [key: string]: unknown };

/**
 * AI provider that spawns the `claude` CLI as a subprocess.
 * Architecture mirrors opcode's Rust implementation:
 *   - Binary discovery chain (claude-binary-finder.ts)
 *   - Process registry for cancel/kill (claude-process-registry.ts)
 *   - Line-by-line stream-json parsing (no chunk accumulation)
 *   - Session ID extraction from init message
 *   - Continue/resume support via -c and --resume flags
 */
export class ClaudeCodeCliProvider implements AIProvider {
  id = "claude";
  name = "Claude Code";

  private sessions = new Map<string, Session>();
  private messageHistory = new Map<string, ChatMessage[]>();
  /** Maps our session ID → Claude CLI's real session ID (from init message) */
  private cliSessionIds = new Map<string, string>();

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
    // Kill running process if any
    if (processRegistry.isRunning(sessionId)) {
      await processRegistry.kill(sessionId);
    }
    this.sessions.delete(sessionId);
    this.messageHistory.delete(sessionId);
    this.cliSessionIds.delete(sessionId);
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

    // Build CLI arguments (mirrors opcode's execute/continue/resume pattern)
    const args = this.buildCliArgs(sessionId, message);

    // Clean env — remove CLAUDECODE to avoid "nested session" error
    const env = { ...process.env };
    delete env.CLAUDECODE;

    // Find binary via discovery chain
    let binaryPath: string;
    try {
      binaryPath = findClaudeBinary();
    } catch (e) {
      yield { type: "error", message: (e as Error).message };
      return;
    }

    // Spawn process
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([binaryPath, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
    } catch (e) {
      yield { type: "error", message: `Failed to spawn claude CLI: ${(e as Error).message}` };
      return;
    }

    // Register in process registry (for cancel support)
    processRegistry.register(sessionId, proc, { prompt: message });

    let assistantContent = "";

    try {
      // Read stdout line-by-line (mirrors opcode's BufReader::lines())
      yield* this.readStreamJsonLines(proc, sessionId, (text) => {
        assistantContent += text;
      });

      // Check stderr for errors after stdout is done
      yield* this.readStderrErrors(proc);
    } catch (e) {
      yield { type: "error", message: `Stream error: ${(e as Error).message}` };
    } finally {
      // Unregister from process registry
      processRegistry.unregister(sessionId);
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

  /** Cancel a running session */
  async cancelSession(sessionId: string): Promise<boolean> {
    return processRegistry.kill(sessionId);
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.messageHistory.get(sessionId) ?? [];
  }

  /**
   * Build CLI arguments based on session state.
   * Mirrors opcode's execute_claude_code / continue_claude_code / resume_claude_code.
   */
  private buildCliArgs(sessionId: string, message: string): string[] {
    const cliSessionId = this.cliSessionIds.get(sessionId);
    const history = this.messageHistory.get(sessionId) ?? [];
    const userMessageCount = history.filter((m) => m.role === "user").length;
    const isFirstMessage = userMessageCount <= 1; // Current message already pushed

    const args: string[] = [];

    if (!isFirstMessage && cliSessionId) {
      // Resume existing CLI session (like opcode's resume_claude_code)
      args.push("--resume", cliSessionId);
    } else if (!isFirstMessage) {
      // Continue most recent session (like opcode's continue_claude_code)
      args.push("-c");
    }

    args.push(
      "-p", message,
      "--output-format", "stream-json",
      "--verbose",
    );

    return args;
  }

  /**
   * Read stdout line-by-line and yield ChatEvents.
   * Each line is a complete JSON object — no chunk accumulation needed.
   * Mirrors opcode's spawn_claude_process stdout_task.
   */
  private async *readStreamJsonLines(
    proc: ReturnType<typeof Bun.spawn>,
    sessionId: string,
    onText: (text: string) => void,
  ): AsyncGenerator<ChatEvent> {
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

      // Split into complete lines
      const lines = buffer.split("\n");
      // Keep last partial line in buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse JSON — each line is one complete event
        let event: CliEvent;
        try {
          event = JSON.parse(trimmed) as CliEvent;
        } catch {
          continue; // Skip non-JSON lines (e.g. progress indicators)
        }

        // Process the event — may yield multiple ChatEvents per CLI event
        for (const chatEvent of this.mapCliEvent(event, sessionId, onText)) {
          yield chatEvent;
        }
      }
    }

    // Process remaining buffer (last line without trailing newline)
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim()) as CliEvent;
        for (const chatEvent of this.mapCliEvent(event, sessionId, onText)) {
          yield chatEvent;
        }
      } catch {
        // Ignore incomplete trailing data
      }
    }
  }

  /** Read stderr and yield error events */
  private async *readStderrErrors(
    proc: ReturnType<typeof Bun.spawn>,
  ): AsyncGenerator<ChatEvent> {
    const stderr = proc.stderr as ReadableStream<Uint8Array> | undefined;
    if (!stderr) return;

    try {
      const reader = stderr.getReader();
      const decoder = new TextDecoder();
      let stderrContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrContent += decoder.decode(value, { stream: true });
      }

      // Only yield if there's meaningful stderr content
      const trimmed = stderrContent.trim();
      if (trimmed && !trimmed.includes("ExperimentalWarning")) {
        yield { type: "error", message: trimmed };
      }
    } catch {
      // Stderr read failure is non-fatal
    }
  }

  /**
   * Map a single CLI stream-json event to a ChatEvent.
   * Mirrors opcode's event handling in stdout_task.
   *
   * CLI output format (one JSON per line):
   *   {type:"system", subtype:"init", session_id:"..."} — extract session ID
   *   {type:"assistant", message:{content:[...]}} — text and tool_use blocks
   *   {type:"result", result:"...", session_id:"..."} — final result (ignored to avoid duplication)
   *   {type:"tool_result", output:"..."} — tool execution result
   *   {type:"error", error:"..."} — error event
   *   {type:"rate_limit_event"} — ignored
   */
  /**
   * Map a single CLI stream-json event to ChatEvent(s).
   * Returns an array because one `assistant` event can contain
   * multiple content blocks (text + tool_use interleaved).
   */
  private mapCliEvent(
    event: CliEvent,
    sessionId: string,
    onText: (text: string) => void,
  ): ChatEvent[] {
    switch (event.type) {
      case "system": {
        const sysEvent = event as CliSystemEvent;
        if (sysEvent.subtype === "init" && sysEvent.session_id) {
          this.cliSessionIds.set(sessionId, sysEvent.session_id);
        }
        return [];
      }

      case "assistant": {
        const assistantEvent = event as CliAssistantEvent;
        const content = assistantEvent.message?.content;
        if (!Array.isArray(content)) return [];

        // Yield ALL blocks in order — text and tool_use interleaved
        const events: ChatEvent[] = [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            onText(block.text);
            events.push({ type: "text", content: block.text });
          } else if (block.type === "tool_use") {
            events.push({
              type: "tool_use",
              tool: block.name ?? "unknown",
              input: block.input ?? {},
            });
          }
        }
        return events;
      }

      case "result":
        return [];

      case "tool_result": {
        const trEvent = event as CliToolResultEvent;
        const output = trEvent.output ?? trEvent.content ?? "";
        return [{
          type: "tool_result",
          output: typeof output === "string" ? output : JSON.stringify(output),
        }];
      }

      case "error": {
        const errEvent = event as CliErrorEvent;
        return [{
          type: "error",
          message: errEvent.error ?? errEvent.message ?? "Unknown CLI error",
        }];
      }

      default:
        return [];
    }
  }
}
