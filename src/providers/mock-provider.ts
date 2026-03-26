import type {
  AIProvider,
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
} from "./provider.interface.ts";

const MOCK_RESPONSES = [
  "I can help you with that! Let me take a look at the code.",
  "Here's what I found after analyzing the project structure.",
  "I'll make those changes for you. Let me update the file.",
  "That looks like a good approach. Here's my suggestion:",
  "I've reviewed the code and here are my findings.",
];

/**
 * Mock AI provider for development/testing.
 * Simulates streaming chat responses without needing a real API key.
 */
export class MockProvider implements AIProvider {
  id = "mock";
  name = "Mock AI (Dev)";

  private sessions = new Map<string, Session>();
  private messageHistory = new Map<string, ChatMessage[]>();
  /** Active abort controllers for cancel support */
  private activeAborts = new Map<string, AbortController>();

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
    _opts?: import("./provider.interface.ts").SendMessageOpts,
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

    // Track abort controller for this session
    const abortController = new AbortController();
    this.activeAborts.set(sessionId, abortController);

    // Simulate SDK system events (hooks, init) — real SDK emits these before content
    yield { type: "system" as any, subtype: "hook_started" } as any;
    await sleep(50);
    yield { type: "system" as any, subtype: "init" } as any;

    // Simulate thinking delay
    await sleep(250);

    // Pick a response
    const responseText =
      MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)] ??
      MOCK_RESPONSES[0]!;

    // Simulate tool use for messages containing "file" or "code"
    const lowerMsg = message.toLowerCase();
    if (lowerMsg.includes("file") || lowerMsg.includes("code")) {
      yield { type: "tool_use", tool: "Read", input: { path: "src/index.ts" } };
      await sleep(200);
      yield { type: "tool_result", output: '// Main entry point\nconsole.log("Hello");' };
      await sleep(100);
    }

    // Simulate approval request for messages containing "delete" or "remove"
    if (lowerMsg.includes("delete") || lowerMsg.includes("remove")) {
      yield {
        type: "approval_request",
        requestId: crypto.randomUUID(),
        tool: "Bash",
        input: { command: "rm -rf /tmp/test" },
      };
      // In real usage, we'd wait for approval response.
      // Mock just continues after a delay.
      await sleep(500);
    }

    // Stream response text word by word
    const words = responseText.split(" ");
    for (let i = 0; i < words.length; i++) {
      if (abortController.signal.aborted) break;
      const chunk = (i === 0 ? "" : " ") + words[i];
      yield { type: "text", content: chunk };
      await sleep(50);
    }

    // Add a mock code block for variety
    if (lowerMsg.includes("code") || lowerMsg.includes("example")) {
      yield {
        type: "text",
        content: "\n\n```typescript\nfunction hello() {\n  console.log('Hello from PPM!');\n}\n```\n",
      };
      await sleep(50);
    }

    // Store assistant message
    history.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: responseText,
      timestamp: new Date().toISOString(),
    });
    this.messageHistory.set(sessionId, history);

    this.activeAborts.delete(sessionId);
    yield { type: "done", sessionId };
  }

  /** Abort an active query for a session (for cancel support) */
  abortQuery(sessionId: string): void {
    const controller = this.activeAborts.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAborts.delete(sessionId);
    }
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.messageHistory.get(sessionId) ?? [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
