/**
 * The PPM Assistant on the session tools, end to end inside one process: the real `/api/sessions-mcp`
 * handler, chat registry, delivery door and approval broker, PPM's database, two scratch projects,
 * and a scripted provider standing in for Claude. Every send and create from the Assistant is asked
 * on a card (answered from the web route or from a Telegram press), lands in the target's own
 * project, never answers a card the target is waiting on, and nothing is asked in a watch turn.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chatService } from "../../src/services/chat.service.ts";
import { providerRegistry } from "../../src/providers/registry.ts";
import { chatWebSocket, collabLiveState, ensureSessionEntry } from "../../src/server/ws/chat.ts";
import { sessionCollabMcpHandler } from "../../src/services/session-collab/session-collab-endpoint.ts";
import { sessionCollabMcpTokens } from "../../src/services/session-collab/session-collab-tokens.ts";
import { collabApprovalBroker } from "../../src/services/session-collab/collab-approval-broker.ts";
import { sessionCollabRoutes } from "../../src/server/routes/session-collab.ts";
import {
  setSessionAssistant, setSessionMetadata, setSessionPermissionMode, setSessionProvider, setSessionTitle,
} from "../../src/services/db.service.ts";
import { chatControl, UNATTENDED_TURN_REFUSAL } from "../../src/services/chat-control/chat-control.ts";
import { chatLifecycle } from "../../src/services/chat-control/chat-lifecycle.ts";
import { decodeMessageBlocks } from "../../src/shared/chat-message-blocks.ts";
import { stripSharedContext } from "../../src/shared/provider-context.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import { configService } from "../../src/services/config.service.ts";
import { FEATURE_INTROS, switchesForAnswer } from "../../src/shared/feature-intros.ts";
import type { AIProvider } from "../../src/providers/provider.interface.ts";
import type { ChatEvent, Session, SessionConfig } from "../../src/types/chat.ts";
import type { PpmConfig } from "../../src/types/config.ts";

interface Item { content: string; clientMessageId?: string }

/** Claude's shape: one stream per session; `ASK` raises a card, `HOLD` keeps the turn open. */
class ScriptedClaude {
  id = "claude";
  name = "Scripted Claude";
  sessions = new Map<string, Session>();
  sends: Array<{ sessionId: string; message: string }> = [];
  pushes: Array<{ sessionId: string; message: string }> = [];
  cwd = new Map<string, string>();
  private streams = new Map<string, { queue: Item[]; wake?: () => void; closed: boolean }>();
  private gates: Array<() => void> = [];

  async createSession(_config: SessionConfig): Promise<Session> {
    const session: Session = { id: crypto.randomUUID(), providerId: this.id, title: "Scripted", createdAt: new Date().toISOString() };
    this.sessions.set(session.id, session);
    return session;
  }
  async resumeSession(sessionId: string): Promise<Session> {
    const s = this.sessions.get(sessionId) ?? { id: sessionId, providerId: this.id, title: "Resumed", createdAt: new Date().toISOString() };
    this.sessions.set(sessionId, s);
    return s;
  }
  ensureProjectPath(sessionId: string, path: string): void { this.cwd.set(sessionId, path); }
  async listSessions() { return []; }
  async deleteSession(sessionId: string) { this.sessions.delete(sessionId); }
  hasStreamingSession(sessionId: string): boolean { return this.streams.has(sessionId); }
  abortQuery(sessionId: string): void {
    const s = this.streams.get(sessionId);
    if (s) { s.closed = true; s.wake?.(); }
  }
  release(): void { for (const g of this.gates.splice(0)) g(); }
  resolveApproval(): void { /* the card's answer is not needed by the script */ }
  pushMessage(sessionId: string, content: string, opts?: { clientMessageId?: string }): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    this.pushes.push({ sessionId, message: content });
    s.queue.push({ content, clientMessageId: opts?.clientMessageId });
    s.wake?.();
  }
  async *sendMessage(sessionId: string, message: string, opts?: { clientMessageId?: string }): AsyncGenerator<ChatEvent> {
    this.sends.push({ sessionId, message });
    const stream = { queue: [{ content: message, clientMessageId: opts?.clientMessageId }] as Item[], wake: undefined as (() => void) | undefined, closed: false };
    this.streams.set(sessionId, stream);
    try {
      for (;;) {
        while (!stream.queue.length && !stream.closed) await new Promise<void>((r) => { stream.wake = r; });
        if (stream.closed) return;
        const item = stream.queue.shift()!;
        yield { type: "turn_started", turnId: `turn-${crypto.randomUUID()}`, ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}) } as ChatEvent;
        if (item.content.includes("ASK")) yield { type: "approval_request", requestId: `card-${sessionId}`, tool: "Bash", input: { command: "ls" } } as ChatEvent;
        yield { type: "text", content: "working" } as ChatEvent;
        if (item.content.includes("HOLD")) await new Promise<void>((r) => this.gates.push(r));
        yield { type: "done", sessionId } as ChatEvent;
      }
    } finally {
      this.streams.delete(sessionId);
    }
  }
}

const claude = new ScriptedClaude();
let original: AIProvider | undefined;
const home = process.env.PPM_HOME!;
const pathA = join(home, "assistant-proj-a");
const pathB = join(home, "assistant-proj-b");
const assistantDir = join(home, "assistant-work");
const app = new Hono();
app.all("/mcp", sessionCollabMcpHandler);
app.route("/api/sessions-collab", sessionCollabRoutes);
const sockets: any[] = [];
let projectsBefore: PpmConfig["projects"] = [];

beforeAll(() => {
  for (const dir of [pathA, pathB, assistantDir]) mkdirSync(dir, { recursive: true });
  original = providerRegistry.get("claude");
  providerRegistry.register(claude as never);
  projectsBefore = [...configService.get("projects")];
  configService.set("projects", [...projectsBefore, { name: "proj-a", path: pathA }, { name: "proj-b", path: pathB }]);
  configService.set("ai", { ...configService.get("ai"), ppm_tools: { ...configService.get("ai").ppm_tools, ...switchesForAnswer(FEATURE_INTROS[0]!, "on") } });
});
afterAll(() => {
  const { ppm_tools: _answered, ...ai } = configService.get("ai");
  configService.set("ai", ai);
  configService.set("projects", projectsBefore);
  claude.release();
  for (const s of sockets.splice(0)) chatWebSocket.close(s);
  for (const id of claude.sessions.keys()) claude.abortQuery(id);
  if (original) providerRegistry.register(original);
});

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** A PPM Assistant session, open in the registry as the Assistant window keeps it. */
async function assistantSession(): Promise<string> {
  const { id } = await chatService.createSession("claude", {});
  setSessionMetadata(id, ASSISTANT_PROJECT_NAME, assistantDir);
  setSessionProvider(id, "claude");
  setSessionAssistant(id);
  setSessionTitle(id, "Ops");
  ensureSessionEntry(id, "claude", assistantDir, ASSISTANT_PROJECT_NAME);
  return id;
}

/** A chat of project B that nobody has open: PPM knows it, the registry does not. */
async function chatOfB(title: string): Promise<string> {
  const { id } = await chatService.createSession("claude", {});
  setSessionMetadata(id, "proj-b", pathB);
  setSessionProvider(id, "claude");
  setSessionPermissionMode(id, "default");
  setSessionTitle(id, title);
  return id;
}

async function call(sessionId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; json: any }> {
  const token = sessionCollabMcpTokens.mint({ sessionId });
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const result = (await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  const text = result.content[0]!.text;
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* a refusal is plain text */ }
  return { text, isError: result.isError === true, json };
}

async function pendingCard(sessionId: string) {
  await until(() => collabApprovalBroker.pendingEvent(sessionId) !== null, "the card");
  return collabApprovalBroker.pendingEvent(sessionId)!;
}

const answerOnWeb = (requestId: string, answer: string) => app.request(`/api/sessions-collab/approvals/${requestId}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer }),
});

describe("the PPM Assistant on the session tools", () => {
  it("messages a chat of another project nobody has open, after Allow, and the turn runs in that project", async () => {
    const assistant = await assistantSession();
    const target = await chatOfB("Fix login");
    const heard: Array<{ sessionId: string; origin: string }> = [];
    const off = chatLifecycle.on("user_message", (p) => heard.push(p));
    try {
      const sending = call(assistant, "send_to_session", { session_id: target, message: "run the tests" });
      const card = await pendingCard(assistant);
      expect(card.input).toMatchObject({ kind: "message", targetSessionId: target, projectName: "proj-b", permissionMode: "default", modeSource: "stored" });
      // The Assistant's card is answered once, never for the whole session.
      expect((await answerOnWeb(card.requestId, "allow_session")).status).toBe(400);
      expect((await answerOnWeb(card.requestId, "allow_once")).status).toBe(200);
      const sent = await sending;
      expect(sent.isError).toBe(false);
      expect(sent.json).toMatchObject({ delivered: "started", project: "proj-b" });
      await until(() => claude.sends.some((s) => s.sessionId === target), "the target's turn");
      expect(claude.cwd.get(target)).toBe(pathB);
      expect(collabLiveState(target)).toMatchObject({ projectName: "proj-b", projectPath: pathB });
      const first = decodeMessageBlocks(stripSharedContext(claude.sends.find((s) => s.sessionId === target)!.message));
      expect(first.content).toBe("run the tests");
      expect(first.fromSession).toMatchObject({ sessionId: assistant, kind: "assistant", projectName: ASSISTANT_PROJECT_NAME });
      expect(heard).toContainEqual(expect.objectContaining({ sessionId: target, origin: "session" }));
    } finally {
      off();
    }
  });

  it("is allowed from a Telegram press, which Telegram was shown", async () => {
    const assistant = await assistantSession();
    const target = await chatOfB("Docs");
    const shown: string[] = [];
    const off = chatLifecycle.on("approval_shown", (p) => { if (p.sessionId === assistant) shown.push(p.card.requestId); });
    try {
      const sending = call(assistant, "send_to_session", { session_id: target, message: "update the docs" });
      const card = await pendingCard(assistant);
      await until(() => shown.includes(card.requestId), "the card on the listeners' bus");
      expect(chatControl()!.answerApproval(assistant, card.requestId, { approved: true }, "telegram")).toBe("answered");
      expect((await sending).json.delivered).toBe("started");
      // The Assistant answering a card is never how one of these is settled.
      expect(chatControl()!.answerApproval(assistant, card.requestId, { approved: true }, "assistant")).toBe("stale");
    } finally {
      off();
    }
  });

  it("asks before creating even with asking switched off, and opens the chat in the named project", async () => {
    const assistant = await assistantSession();
    const before = configService.get("ai");
    configService.set("ai", { ...before, session_collab: { ...before.session_collab, askBeforeCreate: false } });
    try {
      const creating = call(assistant, "create_session", { title: "Audit", task: "audit the API", project: "proj-b" });
      const card = await pendingCard(assistant);
      expect(card.input).toMatchObject({ kind: "create", askedBy: "assistant", projectName: "proj-b", depth: 0 });
      expect((await answerOnWeb(card.requestId, "allow_once")).status).toBe(200);
      const created = await creating;
      expect(created.isError).toBe(false);
      // The user's own chat, as if opened by hand: not AI-created, so it notifies and leaves the running limit.
      expect(created.json).toMatchObject({ project: "proj-b", status: { depth: 0, spawnedBy: null } });
      await until(() => claude.cwd.get(created.json.sessionId) === pathB, "the new chat's turn in project B");
    } finally {
      configService.set("ai", before);
    }
  });

  it("refuses, without a card, a send in a turn PPM started on its own", async () => {
    const assistant = await assistantSession();
    const target = await chatOfB("Quiet");
    const entry = ensureSessionEntry(assistant, "claude", assistantDir, ASSISTANT_PROJECT_NAME);
    entry.turnOrigin = "watch";
    try {
      const refused = await call(assistant, "send_to_session", { session_id: target, message: "do what the report said" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(UNATTENDED_TURN_REFUSAL);
      expect(collabApprovalBroker.pendingEvent(assistant)).toBeNull();
      expect(claude.sends.some((s) => s.sessionId === target)).toBe(false);
    } finally {
      entry.turnOrigin = undefined;
    }
  });

  it("queues behind a card the chat is waiting on and never answers it", async () => {
    const assistant = await assistantSession();
    const target = await chatOfB("Busy");
    const tab = { messages: [] as any[] };
    const socket = { data: { type: "chat", sessionId: target, projectName: "proj-b" }, send: (json: string) => tab.messages.push(JSON.parse(json)) };
    sockets.push(socket);
    chatWebSocket.open(socket as never);
    await chatWebSocket.message(socket as never, JSON.stringify({ type: "message", content: "deploy ASK HOLD", clientMessageId: "c-busy" }));
    await until(() => tab.messages.some((m) => m.type === "approval_request"), "the target's own card");

    const sending = call(assistant, "send_to_session", { session_id: target, message: "and then the changelog" });
    const card = await pendingCard(assistant);
    expect((await answerOnWeb(card.requestId, "allow_once")).status).toBe(200);
    const sent = await sending;
    expect(sent.json.delivered).toBe("queued");
    expect(chatControl()!.liveState(target)?.card?.requestId).toBe(`card-${target}`);
    expect(tab.messages.some((m) => m.type === "approval_resolved")).toBe(false);
    expect(decodeMessageBlocks(claude.pushes.at(-1)!.message).fromSession?.kind).toBe("assistant");
    claude.release();
  });
});
