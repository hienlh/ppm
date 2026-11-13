import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../../test-setup.ts"; // disable auth
import { providerRegistry } from "../../../src/providers/registry.ts";
import { MockProvider } from "../../../src/providers/mock-provider.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import type { ChatEvent, SendMessageOpts } from "../../../src/providers/provider.interface.ts";

const PORT = 19893;
let server: ReturnType<typeof Bun.serve>;

/**
 * A provider whose chat outlives its turns, like Antigravity: after the first turn it asks for one
 * of its own (`provider_continue`), which the chat socket must run as a follow-up.
 */
class ContinuingProvider extends MockProvider {
  override id = "continue-test";
  override name = "Continue test";
  pushed: Array<{ content: string }> = [];
  private queue: ChatEvent[] = [];
  private wake: (() => void) | null = null;

  private emit(...evs: ChatEvent[]) {
    this.queue.push(...evs);
    this.wake?.();
  }

  override async *sendMessage(sessionId: string, _message: string, _opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    this.emit({ type: "text", content: "Running the tests in the background." }, { type: "done", sessionId });
    setTimeout(() => this.emit({ type: "provider_continue", content: "A background task you started has finished. Continue from where you left off." }), 200);
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      await new Promise<void>((r) => { this.wake = r; });
    }
  }

  pushMessage(sessionId: string, content: string): void {
    this.pushed.push({ content });
    setTimeout(() => this.emit({ type: "text", content: "Tests passed." }, { type: "done", sessionId }), 50);
  }
}

const provider = new ContinuingProvider();

beforeAll(async () => {
  providerRegistry.register(provider);
  const { app } = await import("../../../src/server/index.ts");
  const { chatWebSocket } = await import("../../../src/server/ws/chat.ts");
  server = Bun.serve({
    port: PORT,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/ws/chat/")) {
        const sessionId = url.pathname.split("/ws/chat/")[1] ?? "";
        if (srv.upgrade(req, { data: { type: "chat", sessionId } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(req, srv as any);
    },
    websocket: { open: chatWebSocket.open as any, message: chatWebSocket.message as any, close: chatWebSocket.close as any },
  });
});

afterAll(() => server?.stop(true));

describe("a turn the provider asks for", () => {
  it("runs as a follow-up shown as the user's message, then goes idle again", async () => {
    const session = await chatService.createSession(provider.id, {});
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/chat/${session.id}`);
    const messages: any[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    await new Promise((r) => { ws.onopen = r; });
    const until = async (pred: () => boolean) => {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > 5000) throw new Error(`timed out: ${JSON.stringify(messages.map((m) => m.type))}`);
        await Bun.sleep(10);
      }
    };

    ws.send(JSON.stringify({ type: "message", content: "run the tests" }));
    await until(() => messages.filter((m) => m.type === "done").length === 2);

    expect(provider.pushed).toEqual([{ content: "A background task you started has finished. Continue from where you left off." }]);
    const firstDone = messages.findIndex((m) => m.type === "done");
    const after = messages.slice(firstDone + 1);
    expect(after.find((m) => m.type === "user_message")?.content).toBe("A background task you started has finished. Continue from where you left off.");
    expect(after.some((m) => m.type === "phase_changed" && m.phase === "thinking")).toBe(true);
    expect(after.some((m) => m.type === "text" && m.content === "Tests passed.")).toBe(true);
    expect(after.some((m) => m.type === "provider_continue")).toBe(false);
    await Bun.sleep(100);
    expect(messages.filter((m) => m.type === "phase_changed").at(-1)?.phase).toBe("idle");
    ws.close();
  });
});
