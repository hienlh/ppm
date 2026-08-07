/**
 * Global event bus (`/ws/global`).
 *
 * The point of this suite is the failure it prevents: file watching and app-wide
 * broadcasts used to be started by, and delivered over, the chat WebSocket. Chat
 * tabs mount lazily now, so a workspace whose visible tabs are an editor and a
 * terminal has NO chat socket — which silently killed editor live-reload,
 * docx/pdf preview reload, file-tree invalidation and cross-device unread sync.
 * These tests assert the bus works with zero chat sessions in existence.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const PORT = 19881; // unique — avoid clashing with other WS suites
let server: ReturnType<typeof Bun.serve>;
let projectDir: string;
const PROJECT = "global-events-test";

beforeAll(async () => {
  projectDir = mkdtempSync(resolve(tmpdir(), "ppm-globalws-"));
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === PROJECT)) {
    projects.push({ name: PROJECT, path: projectDir });
    configService.set("projects", projects);
  }

  const { app } = await import("../../../src/server/index.ts");
  const { globalWebSocket } = await import("../../../src/server/ws/global.ts");

  server = Bun.serve({
    port: PORT,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws/global") {
        if (srv.upgrade(req, { data: { type: "global" } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(req, srv as any);
    },
    websocket: {
      open: globalWebSocket.open as any,
      message: globalWebSocket.message as any,
      close: globalWebSocket.close as any,
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

function connect(): Promise<{
  ws: WebSocket;
  messages: any[];
  waitForType: (type: string, timeoutMs?: number) => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/global`);
    const messages: any[] = [];
    ws.onmessage = (ev) => {
      try { messages.push(JSON.parse(ev.data as string)); } catch { /* ignore */ }
    };
    ws.onerror = () => reject(new Error("global WS connection failed"));
    ws.onopen = () => {
      const waitForType = (type: string, timeoutMs = 8000) =>
        new Promise<any>((res, rej) => {
          const existing = messages.find((m) => m.type === type);
          if (existing) return res(existing);
          const timer = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs);
          const handler = (ev: MessageEvent) => {
            try {
              const msg = JSON.parse(ev.data as string);
              if (msg.type === type) {
                clearTimeout(timer);
                ws.removeEventListener("message", handler);
                res(msg);
              }
            } catch { /* ignore */ }
          };
          ws.addEventListener("message", handler);
        });
      resolve({ ws, messages, waitForType, close: () => ws.close() });
    };
  });
}

describe("global event bus", () => {
  it("greets a new client with global_ready", async () => {
    const { waitForType, close } = await connect();
    const ready = await waitForType("global_ready");
    expect(ready.type).toBe("global_ready");
    close();
  });

  it("delivers broadcastGlobalEvent with no chat session in existence", async () => {
    const { broadcastGlobalEvent } = await import("../../../src/server/ws/global.ts");
    const { waitForType, close } = await connect();
    await waitForType("global_ready");

    // This is the regression guard: previously the only delivery path iterated
    // chat sockets, so with zero chat sessions the event reached nobody.
    broadcastGlobalEvent({ type: "session:unread_changed", sessionId: "s1", unreadCount: 3 });
    const got = await waitForType("session:unread_changed");
    expect(got.sessionId).toBe("s1");
    expect(got.unreadCount).toBe(3);

    close();
  });

  it("relays file:changed after being asked to watch a project", async () => {
    const { ws, waitForType, close } = await connect();
    await waitForType("global_ready");

    ws.send(JSON.stringify({ type: "watch", projectName: PROJECT }));
    // Give the watcher a moment to attach before touching the directory.
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(resolve(projectDir, "touched.txt"), "hello");

    const evt = await waitForType("file:changed");
    expect(evt.projectName).toBe(PROJECT);
    expect(typeof evt.path).toBe("string");

    close();
  });

  it("ignores a watch request for an unknown project instead of throwing", async () => {
    const { ws, waitForType, close } = await connect();
    await waitForType("global_ready");

    ws.send(JSON.stringify({ type: "watch", projectName: "does-not-exist" }));
    ws.send(JSON.stringify({ type: "watch" })); // missing projectName
    ws.send("not json at all");
    await new Promise((r) => setTimeout(r, 200));

    // Connection survives and still delivers events.
    const { broadcastGlobalEvent } = await import("../../../src/server/ws/global.ts");
    broadcastGlobalEvent({ type: "session:unread_changed", sessionId: "s2", unreadCount: 1 });
    const got = await waitForType("session:unread_changed");
    expect(got.sessionId).toBe("s2");

    close();
  });

  it("stops delivering to a disconnected client", async () => {
    const { broadcastGlobalEvent } = await import("../../../src/server/ws/global.ts");
    const a = await connect();
    const b = await connect();
    await a.waitForType("global_ready");
    await b.waitForType("global_ready");

    a.close();
    await new Promise((r) => setTimeout(r, 200));

    const beforeA = a.messages.length;
    broadcastGlobalEvent({ type: "session:unread_changed", sessionId: "s3", unreadCount: 9 });
    const gotB = await b.waitForType("session:unread_changed");
    expect(gotB.sessionId).toBe("s3");
    expect(a.messages.length).toBe(beforeA);

    b.close();
  });
});
