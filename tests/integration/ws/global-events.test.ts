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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { _resetAgentTranscriptHubForTest } from "../../../src/services/agent-transcript/agent-transcript-hub.ts";

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

  describe("agent-transcript protocol over the same socket", () => {
    let claudeRoot: string;
    const AGENT_SESSION = "cccccccc-1111-2222-3333-444444444444";

    beforeAll(() => {
      claudeRoot = mkdtempSync(resolve(tmpdir(), "ppm-globalws-claude-"));
      _setClaudeProjectsRoot(claudeRoot);
    });

    afterAll(() => {
      _setClaudeProjectsRoot(null);
    });

    function slugOf(p: string): string {
      return p.replace(/[/\\:.]/g, "-");
    }

    function writeCard(): { subagentsDir: string; file: string } {
      const projectDirInClaudeRoot = join(claudeRoot, slugOf(projectDir));
      mkdirSync(projectDirInClaudeRoot, { recursive: true });
      const sessionDir = join(projectDirInClaudeRoot, AGENT_SESSION);
      writeFileSync(join(projectDirInClaudeRoot, `${AGENT_SESSION}.jsonl`), '{"type":"user"}\n');
      const subagentsDir = join(sessionDir, "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(join(subagentsDir, "agent-a1.meta.json"), JSON.stringify({ toolUseId: "toolu_card1" }));
      const file = join(subagentsDir, "agent-a1.jsonl");
      writeFileSync(
        file,
        JSON.stringify({ type: "assistant", uuid: "u1", message: { content: [{ type: "tool_use", name: "Bash", id: "tu1", input: { command: "ls" } }] } }) + "\n",
      );
      return { subagentsDir, file };
    }

    it("delivers catch-up events for a real card over /ws/global", async () => {
      writeCard();
      const { ws, waitForType, close } = await connect();
      await waitForType("global_ready");

      ws.send(JSON.stringify({
        type: "agent-transcript:subscribe", subId: "sub1", projectName: PROJECT,
        providerId: "claude", sessionId: AGENT_SESSION, source: { kind: "card", cardId: "toolu_card1" },
      }));

      const msg = await waitForType("agent-transcript:events");
      expect(msg.subId).toBe("sub1");
      expect(msg.events).toHaveLength(1);
      expect(msg.events[0].ev.type).toBe("tool_use");
      close();
      _resetAgentTranscriptHubForTest();
    });

    it("pushes a live-appended step within about 500ms", async () => {
      const { file } = writeCard();
      const { ws, messages, waitForType, close } = await connect();
      await waitForType("global_ready");

      ws.send(JSON.stringify({
        type: "agent-transcript:subscribe", subId: "sub2", projectName: PROJECT,
        providerId: "claude", sessionId: AGENT_SESSION, source: { kind: "card", cardId: "toolu_card1" },
      }));
      await waitForType("agent-transcript:events");

      const appendedAt = Date.now();
      writeFileSync(
        file,
        JSON.stringify({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "done" }] } }) + "\n",
        { flag: "a" },
      );

      // A second events message (the live tick) distinct from the catch-up one.
      let live: any;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const found = messages.find((m) => m.type === "agent-transcript:events" && m.events.some((e: any) => e.ev.type === "tool_result"));
        if (found) { live = found; break; }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(live).toBeDefined();
      expect(Date.now() - appendedAt).toBeLessThan(1500);
      close();
      _resetAgentTranscriptHubForTest();
    });

    it("answers an unknown card with agent-transcript:error not_found", async () => {
      const { ws, waitForType, close } = await connect();
      await waitForType("global_ready");
      ws.send(JSON.stringify({
        type: "agent-transcript:subscribe", subId: "sub3", projectName: PROJECT,
        providerId: "claude", sessionId: AGENT_SESSION, source: { kind: "card", cardId: "toolu_does_not_exist" },
      }));
      const err = await waitForType("agent-transcript:error");
      expect(err).toEqual({ type: "agent-transcript:error", subId: "sub3", code: "not_found" });
      close();
      _resetAgentTranscriptHubForTest();
    });

    it("answers ping with pong", async () => {
      const { ws, waitForType, close } = await connect();
      await waitForType("global_ready");
      ws.send(JSON.stringify({ type: "ping" }));
      const pong = await waitForType("pong");
      expect(pong).toEqual({ type: "pong" });
      close();
    });
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
