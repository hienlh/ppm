import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts"; // disable auth
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import type { ChatEvent, SendMessageOpts } from "../../../src/types/chat.ts";

const PORT = 19893;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const { app } = await import("../../../src/server/index.ts");
  const { chatWebSocket } = await import("../../../src/server/ws/chat.ts");
  server = Bun.serve({
    port: PORT,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/ws/chat/")) {
        const sessionId = url.pathname.split("/ws/chat/")[1] ?? "";
        return srv.upgrade(req, { data: { type: "chat", sessionId } }) ? undefined : new Response("no", { status: 400 });
      }
      return app.fetch(req, srv as any);
    },
    websocket: { open: chatWebSocket.open as any, message: chatWebSocket.message as any, close: chatWebSocket.close as any },
  });
});
afterAll(() => server?.stop(true));

function connect(sessionId: string): Promise<{ ws: WebSocket; next: (type: string) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/chat/${sessionId}`);
    const seen: any[] = [];
    const waiters: Array<{ type: string; res: (m: any) => void }> = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      const at = waiters.findIndex((w) => w.type === msg.type);
      if (at !== -1) waiters.splice(at, 1)[0]!.res(msg);
      else seen.push(msg);
    };
    const next = (type: string) => new Promise<any>((res, rej) => {
      const at = seen.findIndex((m) => m.type === type);
      if (at !== -1) return res(seen.splice(at, 1)[0]);
      waiters.push({ type, res });
      setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), 5000);
    });
    ws.onopen = () => resolve({ ws, next });
    ws.onerror = () => reject(new Error("ws failed"));
  });
}

describe("turn_started over the chat socket", () => {
  it("hands the sender's message id back with its turn, and greets a later device with it", async () => {
    const mock = providerRegistry.get("mock")!;
    const spy = spyOn(mock, "sendMessage").mockImplementation(async function* (sessionId: string, _m: string, opts?: SendMessageOpts): AsyncGenerator<ChatEvent> {
      yield { type: "turn_started", turnId: "44444444-0000-4000-8000-000000000001", ...(opts?.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}) };
      yield { type: "text", content: "ok" };
      yield { type: "done", sessionId };
    } as any);
    try {
      const session = await chatService.createSession("mock", {});
      const first = await connect(session.id);
      await first.next("session_state");
      first.ws.send(JSON.stringify({ type: "message", content: "hello", clientMessageId: "optimistic-1" }));
      const started = await first.next("turn_started");
      expect(started).toMatchObject({ turnId: "44444444-0000-4000-8000-000000000001", clientMessageId: "optimistic-1" });
      expect(spy.mock.calls[0]![2]).toMatchObject({ clientMessageId: "optimistic-1" });
      await first.next("done");

      const second = await connect(session.id);
      const state = await second.next("session_state");
      expect(state.turnBindings).toEqual([{ turnId: "44444444-0000-4000-8000-000000000001", clientMessageId: "optimistic-1" }]);
      first.ws.close();
      second.ws.close();
    } finally {
      spy.mockRestore();
    }
  });
});
