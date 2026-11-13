import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test-setup.ts"; // disable auth + isolated PPM_HOME
import { app } from "../../src/server/index.ts";
import { chatWebSocket, listRunningSessions, ensureSessionEntry, getActiveSessionProjectPath, getSessionTurnOrigin } from "../../src/server/ws/chat.ts";
import { chatService } from "../../src/services/chat.service.ts";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { setSessionMetadata } from "../../src/services/db.service.ts";
import type { AIProvider, Session, SessionConfig, SessionInfo, ChatEvent, ChatMessage } from "../../src/providers/provider.interface.ts";

// Unique paths: projects.path is UNIQUE in the shared test DB, so reusing
// process.cwd() would collide with other route tests that run in the same process.
const TEST_PROJECT = "headless-test-project";
const TEST_PROJECT_PATH = `${process.cwd()}/.headless-test-project-${process.pid}`;
const OTHER_PROJECT = "headless-other-project";
const OTHER_PROJECT_PATH = `${process.cwd()}/.headless-other-project-${process.pid}`;

/**
 * Deterministic stand-in for a real SDK/CLI provider — drives the scenarios this route
 * cares about (a stuck AskUserQuestion, a turn that never finishes on its own) without
 * spawning a subprocess. Registered with the shared registry like the built-in "mock".
 */
class HeadlessTestProvider implements AIProvider {
  id = "headless-test";
  name = "Headless Test Provider";
  sessions = new Map<string, Session>();
  private aborts = new Map<string, AbortController>();
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  abortCalls: Array<{ sessionId: string; reason?: string }> = [];
  resolveApprovalCalls: Array<{ requestId: string; approved: boolean }> = [];
  pushMessageCalls: Array<{ sessionId: string; content: string }> = [];

  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    const session: Session = {
      id, providerId: this.id, title: config.title ?? "Test",
      projectName: config.projectName, projectPath: config.projectPath,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    if (config.projectPath) setSessionMetadata(id, config.projectName, config.projectPath);
    return session;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    return s;
  }

  async listSessions(): Promise<SessionInfo[]> { return []; }
  async deleteSession(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
  async getMessages(): Promise<ChatMessage[]> { return []; }

  async *sendMessage(sessionId: string, sent: string): AsyncIterable<ChatEvent> {
    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    // The chat service may prefix the message with shared project context: match the command inside it.
    const message = ["ask-question-hold", "ask-question", "slow-forever"].find((c) => sent.includes(c)) ?? sent;

    if (message === "ask-question" || message === "ask-question-hold") {
      const requestId = crypto.randomUUID();
      // Register the resolver BEFORE yielding: the consumer may call resolveApproval()
      // synchronously while this generator is still paused at the yield below.
      const approvalPromise = new Promise<boolean>((resolve) => {
        const onAbort = () => resolve(false);
        this.pendingApprovals.set(requestId, (a) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(a);
        });
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      yield { type: "approval_request", requestId, tool: "AskUserQuestion", input: { question: "Continue?" } };
      const approved = await approvalPromise;
      yield { type: "text", content: approved ? "approved" : "skipped" };
      if (message === "ask-question-hold") {
        // Park instead of finishing: `done` empties the turn buffer, and this variant
        // exists to inspect what a tab attaching after the auto-resolve would replay.
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        this.aborts.delete(sessionId);
        yield { type: "error", message: "aborted by provider" };
        return;
      }
    } else if (message === "slow-forever") {
      // Never resolves on its own — only abortQuery() (the wall-clock budget) ends it.
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      this.aborts.delete(sessionId);
      yield { type: "error", message: "aborted by provider" };
      return;
    } else {
      // Small delay so a poller has a real window to observe the running state.
      await new Promise((r) => setTimeout(r, 150));
      yield { type: "text", content: `echo: ${message}` };
    }

    this.aborts.delete(sessionId);
    yield { type: "done", sessionId };
  }

  resolveApproval(requestId: string, approved: boolean): void {
    this.resolveApprovalCalls.push({ requestId, approved });
    this.pendingApprovals.get(requestId)?.(approved);
    this.pendingApprovals.delete(requestId);
  }

  abortQuery(sessionId: string, reason?: string): void {
    this.abortCalls.push({ sessionId, reason });
    this.aborts.get(sessionId)?.abort();
  }

  pushMessage(sessionId: string, content: string): void {
    this.pushMessageCalls.push({ sessionId, content });
  }
}

/**
 * Unlike `HeadlessTestProvider`, this generator never returns after yielding `done` — it
 * loops back and awaits the next `pushMessage()`, as the real SDK's persistent generator
 * does. Needed to catch cleanup wired to the consumer's own end instead of the turn's.
 */
class PersistentTestProvider implements AIProvider {
  id = "persistent-test";
  name = "Persistent Test Provider";
  sessions = new Map<string, Session>();
  private aborts = new Map<string, AbortController>();
  private nextMessage = new Map<string, (content: string | undefined) => void>();
  abortCalls: Array<{ sessionId: string; reason?: string }> = [];
  pushMessageCalls: Array<{ sessionId: string; content: string }> = [];

  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    const session: Session = {
      id, providerId: this.id, title: config.title ?? "Test",
      projectName: config.projectName, projectPath: config.projectPath,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    if (config.projectPath) setSessionMetadata(id, config.projectName, config.projectPath);
    return session;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    return s;
  }

  async listSessions(): Promise<SessionInfo[]> { return []; }
  async deleteSession(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
  async getMessages(): Promise<ChatMessage[]> { return []; }

  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    let current: string | undefined = message;
    while (current !== undefined) {
      await new Promise((r) => setTimeout(r, 20));
      if (controller.signal.aborted) {
        yield { type: "error", message: "aborted by provider" };
        this.aborts.delete(sessionId);
        return;
      }
      yield { type: "text", content: `echo: ${current}` };
      yield { type: "done", sessionId };
      current = await new Promise<string | undefined>((resolve) => {
        this.nextMessage.set(sessionId, resolve);
        controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    }
    this.aborts.delete(sessionId);
  }

  pushMessage(sessionId: string, content: string): void {
    this.pushMessageCalls.push({ sessionId, content });
    const resolve = this.nextMessage.get(sessionId);
    if (resolve) {
      this.nextMessage.delete(sessionId);
      resolve(content);
    }
  }

  abortQuery(sessionId: string, reason?: string): void {
    this.abortCalls.push({ sessionId, reason });
    this.aborts.get(sessionId)?.abort();
  }
}

const testProvider = new HeadlessTestProvider();
const persistentProvider = new PersistentTestProvider();

async function req(projectName: string, path: string, init?: RequestInit) {
  const url = `http://localhost/api/project/${projectName}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return app.request(new Request(url, { ...init, headers }));
}

async function createSession(): Promise<Session> {
  return chatService.createSession(testProvider.id, { projectName: TEST_PROJECT, projectPath: TEST_PROJECT_PATH });
}

async function createPersistentSession(): Promise<Session> {
  return chatService.createSession(persistentProvider.id, { projectName: TEST_PROJECT, projectPath: TEST_PROJECT_PATH });
}

async function postMessage(sessionId: string, body: Record<string, unknown>, projectName = TEST_PROJECT) {
  const res = await req(projectName, `/chat/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
}

const running = (id: string) => listRunningSessions().some((s) => s.sessionId === id);

/** Poll until `predicate()` is true or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function serveChat(port: number) {
  return Bun.serve({
    port,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/ws/chat/")) {
        const sessionId = (url.pathname.split("/ws/chat/")[1] ?? "").split("?")[0] ?? "";
        const upgraded = srv.upgrade(request, { data: { type: "chat", sessionId } });
        if (upgraded) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(request, srv as any);
    },
    websocket: {
      open: chatWebSocket.open as any,
      message: chatWebSocket.message as any,
      close: chatWebSocket.close as any,
    },
  });
}

function connectWs(port: number, sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/chat/${sessionId}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws connect failed"));
  });
}

beforeAll(() => {
  providerRegistry.register(testProvider);
  providerRegistry.register(persistentProvider);
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === TEST_PROJECT)) projects.push({ name: TEST_PROJECT, path: TEST_PROJECT_PATH });
  if (!projects.find((p) => p.name === OTHER_PROJECT)) projects.push({ name: OTHER_PROJECT, path: OTHER_PROJECT_PATH });
  configService.set("projects", projects);
});

afterAll(() => {
  // Leave no project rows behind for the next test file in this process.
  configService.set("projects", configService.get("projects").filter((p) => p.name !== TEST_PROJECT && p.name !== OTHER_PROJECT));
});

describe("POST /chat/sessions/:id/messages — validation", () => {
  it("400s on blank content, no consumer started", async () => {
    const session = await createSession();
    const { status, json } = await postMessage(session.id, { content: "   " });
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
    expect(running(session.id)).toBe(false);
  });

  it("400s on more than 5 images", async () => {
    const session = await createSession();
    const images = Array.from({ length: 6 }, () => ({ data: "x", mediaType: "image/png" }));
    const { status, json } = await postMessage(session.id, { content: "hi", images });
    expect(status).toBe(400);
    expect(json.error).toContain("Max 5 images");
  });

  it("400s on an unsupported image media type", async () => {
    const session = await createSession();
    const { status, json } = await postMessage(session.id, { content: "hi", images: [{ data: "x", mediaType: "image/tiff" }] });
    expect(status).toBe(400);
    expect(json.error).toContain("Unsupported image type");
  });

  it("400s on a reply reference that names another session, and on an unknown permission mode", async () => {
    const session = await createSession();
    const replyTo = { version: 1, sessionId: crypto.randomUUID(), providerId: testProvider.id, messageId: "m1", role: "assistant", timestamp: new Date().toISOString(), quote: "earlier", truncated: false };
    const reply = await postMessage(session.id, { content: "hi", replyTo });
    expect(reply.status).toBe(400);
    expect(reply.json.error).toContain("reply reference");
    const mode = await postMessage(session.id, { content: "hi", permissionMode: "yolo" });
    expect(mode.status).toBe(400);
    expect(mode.json.error).toContain("permissionMode");
    expect(running(session.id)).toBe(false);
  });

  it("400s when the session belongs to another project (DB-persisted path)", async () => {
    const session = await createSession();
    const { status, json } = await postMessage(session.id, { content: "hi" }, OTHER_PROJECT);
    expect(status).toBe(400);
    expect(json.error).toContain("different project");
  });

  it("404s for an unknown session id — no create-on-post", async () => {
    const unknownId = crypto.randomUUID();
    const { status, json } = await postMessage(unknownId, { content: "hi" });
    expect(status).toBe(404);
    expect(json.error).toContain("not found");
    expect(running(unknownId)).toBe(false);
  });

  it("400s when only the in-memory WS registry entry points at another project", async () => {
    const session = await createSession();
    ensureSessionEntry(session.id, testProvider.id, OTHER_PROJECT_PATH, OTHER_PROJECT);
    const { status, json } = await postMessage(session.id, { content: "hi" }, TEST_PROJECT);
    expect(status).toBe(400);
    expect(json.error).toContain("different project");
    expect(getActiveSessionProjectPath(session.id)).toBe(OTHER_PROJECT_PATH);
    expect(running(session.id)).toBe(false);
  });

  it("400s on a timeoutMs that is not an integer inside the accepted range", async () => {
    const session = await createSession();
    for (const timeoutMs of [999, 86_400_001, 1500.5, "60000", null, Number.NaN]) {
      const { status, json } = await postMessage(session.id, { content: "hi", timeoutMs });
      expect(status).toBe(400);
      expect(json.error).toContain("timeoutMs");
    }
    expect(running(session.id)).toBe(false);
  });

  it("accepts the minimum timeoutMs", async () => {
    const session = await createSession();
    const { status } = await postMessage(session.id, { content: "hello", timeoutMs: 1_000 });
    expect(status).toBe(202);
    await waitUntil(() => !running(session.id));
  });

  it("400s on content past the size cap, no consumer started", async () => {
    const session = await createSession();
    const { status, json } = await postMessage(session.id, { content: "x".repeat(1_000_001) });
    expect(status).toBe(400);
    expect(json.error).toContain("too large");
    expect(running(session.id)).toBe(false);
  });

  it("400s when the session belongs to another project (in-memory only, no DB row)", async () => {
    const id = crypto.randomUUID();
    testProvider.sessions.set(id, { id, providerId: testProvider.id, title: "mem-only", projectPath: OTHER_PROJECT_PATH, createdAt: new Date().toISOString() });
    const { status, json } = await postMessage(id, { content: "hi" }, TEST_PROJECT);
    expect(status).toBe(400);
    expect(json.error).toContain("different project");
  });
});

describe("POST /chat/sessions/:id/messages — happy path + visibility", () => {
  it("returns 202 { sessionId, queued: false } for a fresh session, under the extension origin", async () => {
    const session = await createSession();
    const { status, json } = await postMessage(session.id, { content: "hello" });
    expect(status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({ sessionId: session.id, queued: false });
    expect(getSessionTurnOrigin(session.id)).toBe("extension");
    await waitUntil(() => !running(session.id));
  });

  it("shows the run in /sessions/running while in flight and drops it once done", async () => {
    const session = await createSession();
    const postPromise = postMessage(session.id, { content: "hello running" });
    await waitUntil(() => running(session.id));
    const res = await req(TEST_PROJECT, "/chat/sessions/running");
    expect(((await res.json()) as any).data.some((s: any) => s.sessionId === session.id)).toBe(true);
    await postPromise;
    await waitUntil(() => !running(session.id));
  });
});

describe("POST /chat/sessions/:id/messages — concurrency", () => {
  it("two concurrent POSTs start exactly one consumer; the second reports queued: true", async () => {
    const session = await createSession();
    const [r1, r2] = await Promise.all([
      postMessage(session.id, { content: "hello concurrent" }),
      postMessage(session.id, { content: "hello concurrent" }),
    ]);
    expect([r1.json.data.queued, r2.json.data.queued].sort()).toEqual([false, true]);
    expect(testProvider.pushMessageCalls.filter((c) => c.sessionId === session.id)).toHaveLength(1);
    await waitUntil(() => !running(session.id));
  });
});

describe("POST /chat/sessions/:id/messages — unattended AskUserQuestion", () => {
  it("denies the question and the turn completes", async () => {
    const session = await createSession();
    const { status, json } = await postMessage(session.id, { content: "ask-question" });
    expect(status).toBe(202);
    expect(json.data.queued).toBe(false);
    await waitUntil(() => testProvider.resolveApprovalCalls.some((c) => c.approved === false));
    await waitUntil(() => !running(session.id));
  });

  it("buffers the request as answered and its denial right after it, for a tab attaching later", async () => {
    const session = await createSession();
    const { status } = await postMessage(session.id, { content: "ask-question-hold" });
    expect(status).toBe(202);

    const entry = ensureSessionEntry(session.id, testProvider.id);
    await waitUntil(() => entry.turnEvents.some((e) => (e as any).type === "approval_request"));
    const at = entry.turnEvents.findIndex((e) => (e as any).type === "approval_request");
    expect(entry.turnEvents[at]).toMatchObject({ approved: false });
    expect(entry.turnEvents[at + 1]).toMatchObject({ type: "approval_resolved", approved: false });
    expect(entry.pendingApprovalEvent).toBeUndefined();

    testProvider.abortQuery(session.id, "test_cleanup");
    await waitUntil(() => !running(session.id));
  });
});

describe("POST /chat/sessions/:id/messages — wall-clock budget", () => {
  const PORT = 19880;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => { server = serveChat(PORT); });
  afterAll(() => { server?.stop(true); });

  it("aborts once after timeoutMs and buffers an error event", async () => {
    const session = await createSession();
    const ws = await connectWs(PORT, session.id);
    const errorMessages: string[] = [];
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "error") errorMessages.push(msg.message);
      } catch { /* ignore */ }
    };

    const { status, json } = await postMessage(session.id, { content: "slow-forever", timeoutMs: 1_000 });
    expect(status).toBe(202);
    expect(json.data.queued).toBe(false);

    await waitUntil(() => testProvider.abortCalls.some((c) => c.sessionId === session.id && c.reason === "headless_timeout"));
    expect(testProvider.abortCalls.filter((c) => c.sessionId === session.id && c.reason === "headless_timeout")).toHaveLength(1);
    await waitUntil(() => errorMessages.some((m) => m.includes("wall-clock budget")));
    ws.close();
  });
});

describe("POST /chat/sessions/:id/messages — turn-scoped state", () => {
  const PORT = 19881;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => { server = serveChat(PORT); });
  afterAll(() => { server?.stop(true); });

  it("clears the wall-clock budget when the turn ends, so it never aborts a later turn on the same session", async () => {
    const session = await createPersistentSession();
    const { status, json } = await postMessage(session.id, { content: "turn one", timeoutMs: 1_000 });
    expect(status).toBe(202);
    expect(json.data.queued).toBe(false);
    await waitUntil(() => !running(session.id));

    // Past that budget, with the generator still parked after `done`: a timer cleared only
    // when the consumer itself ends would still be armed here.
    await new Promise((r) => setTimeout(r, 1_300));
    expect(persistentProvider.abortCalls.filter((c) => c.sessionId === session.id && c.reason === "headless_timeout")).toHaveLength(0);

    const followUp = await postMessage(session.id, { content: "turn two" });
    expect(followUp.json.data.queued).toBe(true);
    await waitUntil(() => persistentProvider.pushMessageCalls.some((c) => c.sessionId === session.id && c.content === "turn two"));
    await waitUntil(() => !running(session.id));
    expect(persistentProvider.abortCalls.filter((c) => c.sessionId === session.id && c.reason === "headless_timeout")).toHaveLength(0);
    persistentProvider.abortQuery(session.id, "test_cleanup");
  });

  it("keeps the turn's origin while a browser attaches mid-turn", async () => {
    const session = await createSession();
    const postPromise = postMessage(session.id, { content: "slow-forever" });
    await waitUntil(() => running(session.id));
    expect(getSessionTurnOrigin(session.id)).toBe("extension");

    const ws = await connectWs(PORT, session.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(getSessionTurnOrigin(session.id)).toBe("extension");

    testProvider.abortQuery(session.id, "test_cleanup");
    await waitUntil(() => !running(session.id));
    await postPromise;
    ws.close();
  });

  it("a headless follow-up unblocks a pending approval instead of dropping it", async () => {
    const session = await createSession();
    // A browser is attached, so the question is shown rather than denied at once.
    const ws = await connectWs(PORT, session.id);
    await postMessage(session.id, { content: "ask-question" });
    await waitUntil(() => running(session.id));
    await waitUntil(() => ensureSessionEntry(session.id, testProvider.id).pendingApprovalEvent != null);

    const followUp = await postMessage(session.id, { content: "carry on" });
    expect(followUp.json.data.queued).toBe(true);
    await waitUntil(() => testProvider.resolveApprovalCalls.some((c) => c.approved === false));
    await waitUntil(() => testProvider.pushMessageCalls.some((c) => c.sessionId === session.id && c.content === "carry on"));
    await waitUntil(() => !running(session.id));
    ws.close();
  });
});

describe("POST /chat/sessions/:id/cancel", () => {
  it("aborts the query with reason rest_cancel", async () => {
    const session = await createSession();
    await postMessage(session.id, { content: "hello" });
    const res = await req(TEST_PROJECT, `/chat/sessions/${session.id}/cancel`, { method: "POST" });
    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json.data.cancelled).toBe(true);
    expect(testProvider.abortCalls.some((c) => c.sessionId === session.id && c.reason === "rest_cancel")).toBe(true);
  });

  it("404s for an unknown session", async () => {
    const res = await req(TEST_PROJECT, `/chat/sessions/${crypto.randomUUID()}/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("400s when the session belongs to another project", async () => {
    const session = await createSession();
    const res = await req(OTHER_PROJECT, `/chat/sessions/${session.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(400);
  });
});
