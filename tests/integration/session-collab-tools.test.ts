/**
 * The session tools end to end inside one process: the real `/api/sessions-mcp` handler, the real
 * chat registry and delivery door, PPM's database, and a scripted provider standing in for Claude.
 * A session creates others (behind a card answered over HTTP), they message each other, waits end
 * the way they should, and every refusal holds: depth, pair limit, design caller, other project.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatService } from "../../src/services/chat.service.ts";
import { providerRegistry } from "../../src/providers/registry.ts";
import { chatWebSocket, collabLiveState, ensureSessionEntry } from "../../src/server/ws/chat.ts";
import { sessionCollabMcpHandler } from "../../src/services/session-collab/session-collab-endpoint.ts";
import { collabEnv } from "../../src/services/session-collab/collab-env.ts";
import { effectivePermissionMode } from "../../src/services/session-collab/collab-context.ts";
import { sessionCollabMcpTokens } from "../../src/services/session-collab/session-collab-tokens.ts";
import { collabApprovalBroker } from "../../src/services/session-collab/collab-approval-broker.ts";
import { pairCounter } from "../../src/services/session-collab/pair-counter.ts";
import { parentOf, recordSpawn } from "../../src/services/session-collab/session-links.service.ts";
import { chatSessionCollabRoutes, sessionCollabRoutes } from "../../src/server/routes/session-collab.ts";
import {
  getDb, getSessionPermissionMode, getSessionTitle, setSessionDesignSlug, setSessionMetadata, setSessionMigratedTo,
  setSessionPermissionMode, setSessionProvider, setSessionTitle,
} from "../../src/services/db.service.ts";
import { decodeMessageBlocks } from "../../src/shared/chat-message-blocks.ts";
import { configService } from "../../src/services/config.service.ts";
import { FEATURE_INTROS, switchesForAnswer } from "../../src/shared/feature-intros.ts";
import { stripSharedContext } from "../../src/shared/provider-context.ts";
import type { AIProvider } from "../../src/providers/provider.interface.ts";
import type { ChatEvent, Session, SessionConfig } from "../../src/types/chat.ts";

interface Item { content: string; clientMessageId?: string }

/** Claude's shape: one stream per session, follow-ups pushed into it; `HOLD` keeps a turn open. */
class ScriptedClaude {
  id = "claude";
  name = "Scripted Claude";
  sessions = new Map<string, Session>();
  sends: Array<{ sessionId: string; message: string; permissionMode?: string }> = [];
  pushes: Array<{ sessionId: string; message: string }> = [];
  private streams = new Map<string, { queue: Item[]; wake?: () => void; closed: boolean }>();
  private gates: Array<() => void> = [];
  private turnNo = 0;

  async createSession(config: SessionConfig): Promise<Session> {
    const session: Session = { id: crypto.randomUUID(), providerId: this.id, title: config.title ?? "Scripted", createdAt: new Date().toISOString() };
    this.sessions.set(session.id, session);
    return session;
  }
  async resumeSession(sessionId: string): Promise<Session> {
    const s = this.sessions.get(sessionId) ?? { id: sessionId, providerId: this.id, title: "Resumed", createdAt: new Date().toISOString() };
    this.sessions.set(sessionId, s);
    return s;
  }
  async listSessions() { return []; }
  async deleteSession(sessionId: string) { this.sessions.delete(sessionId); }
  hasStreamingSession(sessionId: string): boolean { return this.streams.has(sessionId); }
  abortQuery(sessionId: string): void {
    const s = this.streams.get(sessionId);
    if (s) { s.closed = true; s.wake?.(); }
  }
  release(): void { for (const g of this.gates.splice(0)) g(); }
  pushMessage(sessionId: string, content: string, opts?: { clientMessageId?: string }): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    this.pushes.push({ sessionId, message: content });
    s.queue.push({ content, clientMessageId: opts?.clientMessageId });
    s.wake?.();
  }
  async *sendMessage(sessionId: string, message: string, opts?: { clientMessageId?: string; permissionMode?: string }): AsyncGenerator<ChatEvent> {
    this.sends.push({ sessionId, message, ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}) });
    const stream = { queue: [{ content: message, clientMessageId: opts?.clientMessageId }] as Item[], wake: undefined as (() => void) | undefined, closed: false };
    this.streams.set(sessionId, stream);
    try {
      for (;;) {
        while (!stream.queue.length && !stream.closed) await new Promise<void>((r) => { stream.wake = r; });
        if (stream.closed) return;
        const item = stream.queue.shift()!;
        const turnId = `turn-${String(++this.turnNo).padStart(6, "0")}`;
        yield { type: "turn_started", turnId, ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}) } as ChatEvent;
        yield { type: "text", content: `answer to ${decodeMessageBlocks(item.content).content}` } as ChatEvent;
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
const PROJECT = "collab-project";
const projectPath = process.env.PPM_HOME!;
const app = new Hono();
app.all("/mcp", sessionCollabMcpHandler);
app.route("/api/sessions-collab", sessionCollabRoutes);
const sockets: any[] = [];

beforeAll(() => {
  original = providerRegistry.get("claude");
  providerRegistry.register(claude as never);
  // The session tools are off until the tour's question is answered; these tests answer "Turn on".
  configService.set("ai", { ...configService.get("ai"), ppm_tools: { ...configService.get("ai").ppm_tools, ...switchesForAnswer(FEATURE_INTROS[0]!, "on") } });
});
afterAll(() => {
  const { ppm_tools: _answered, ...ai } = configService.get("ai");
  configService.set("ai", ai);
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

/** A session PPM knows in this project, open in the chat registry like one a browser started. */
async function session(title: string, mode = "default", path = projectPath): Promise<string> {
  const { id } = await chatService.createSession("claude", {});
  setSessionMetadata(id, path === projectPath ? PROJECT : "elsewhere", path);
  setSessionProvider(id, "claude");
  setSessionPermissionMode(id, mode);
  setSessionTitle(id, title);
  if (path === projectPath) ensureSessionEntry(id, "claude", path, PROJECT);
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

async function answerCard(sessionId: string, answer: string): Promise<{ status: number; kind: string }> {
  await until(() => collabApprovalBroker.pendingEvent(sessionId) !== null, "the card");
  const event = collabApprovalBroker.pendingEvent(sessionId)!;
  const res = await app.request(`/api/sessions-collab/approvals/${event.requestId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer }),
  });
  return { status: res.status, kind: event.input.kind };
}

function connect(sessionId: string) {
  const messages: any[] = [];
  const socket = { data: { type: "chat", sessionId, projectName: PROJECT }, send: (json: string) => messages.push(JSON.parse(json)) };
  sockets.push(socket);
  chatWebSocket.open(socket as never);
  return { socket, messages };
}

describe("session tools", () => {
  let parent = "";
  let child = "";

  it("lists the three tools", async () => {
    const token = sessionCollabMcpTokens.mint({ sessionId: await session("Lister") });
    const res = await app.request("/mcp", {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const names = ((await res.json()) as any).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["create_session", "send_to_session", "session_status"]);
  });

  it("creates a session behind a card answered over HTTP, and asks no more after Allow for this session", async () => {
    parent = await session("Planner", "acceptEdits");
    const pending = call(parent, "create_session", { title: "Part one", task: "do part one HOLD" });
    expect(await answerCard(parent, "allow_session")).toEqual({ status: 200, kind: "create" });
    const created = await pending;
    expect(created.isError).toBe(false);
    child = created.json.sessionId;
    expect(created.json.status).toMatchObject({ spawnedBy: parent, depth: 1 });
    expect(parentOf(child)).toBe(parent);
    expect(getSessionTitle(child)).toBe("Part one");
    expect(getSessionPermissionMode(child)).toBe("acceptEdits");
    await until(() => claude.sends.some((s) => s.sessionId === child), "the child's first turn");
    // The provider is handed the message after the project's shared context, as every turn is.
    const first = decodeMessageBlocks(stripSharedContext(claude.sends.find((s) => s.sessionId === child)!.message));
    expect(first.content).toBe("do part one HOLD");
    expect(first.fromSession).toMatchObject({ sessionId: parent, title: "Planner", projectName: PROJECT });

    const second = await call(parent, "create_session", { title: "Part two", task: "do part two" });
    expect(second.isError).toBe(false);
    expect(collabApprovalBroker.pendingCount()).toBe(0);
  });

  it("returns a waited-for reply as the call's result and never also as a message", async () => {
    const asking = call(parent, "send_to_session", { session_id: child, message: "how is it going?", wait: true });
    await until(() => claude.pushes.some((p) => p.sessionId === child), "the message inserted into the child's turn");
    const reply = await call(child, "send_to_session", { session_id: parent, message: "part one done" });
    expect(reply.json.delivered).toBe("inserted");
    const asked = await asking;
    expect(asked.json.reply).toMatchObject({ replied: true, text: "part one done" });
    expect(claude.sends.some((s) => s.sessionId === parent)).toBe(false);
    claude.release();
  });

  it("ends a wait without a reply once the turn that read the message is over", async () => {
    const quiet = await session("Quiet");
    const result = await call(parent, "send_to_session", { session_id: quiet, message: "just read this", wait: true });
    expect(result.json.reply).toEqual({ replied: false, reason: "turn_ended_without_reply" });
    expect(result.json.status.sessionId).toBe(quiet);
  });

  it("inserts into a running session's turn, and asks at the pair limit", async () => {
    const busy = await session("Busy");
    const tab = connect(busy);
    await chatWebSocket.message(tab.socket as never, JSON.stringify({ type: "message", content: "long work HOLD", clientMessageId: "c-busy" }));
    await until(() => tab.messages.some((m) => m.type === "text"), "the running turn");
    const sent = await call(parent, "send_to_session", { session_id: busy, message: "one more thing" });
    expect(sent.json.delivered).toBe("inserted");
    expect(decodeMessageBlocks(claude.pushes.at(-1)!.message).fromSession?.sessionId).toBe(parent);

    while (pairCounter.count(parent, busy) < 20) pairCounter.record(parent, busy);
    const limited = call(parent, "send_to_session", { session_id: busy, message: "and another" });
    expect(await answerCard(parent, "deny")).toEqual({ status: 200, kind: "pair_limit" });
    const refused = await limited;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("limit of 20");
    claude.release();
  });

  it("refuses a fourth level of created sessions", async () => {
    const root = await session("Root");
    const one = await session("One"), two = await session("Two"), three = await session("Three");
    recordSpawn(one, root);
    recordSpawn(two, one);
    recordSpawn(three, two);
    const result = await call(three, "create_session", { title: "Four", task: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("3 levels");
  });

  it("cancels a wait when the waiting session is stopped; the late reply arrives as a new message", async () => {
    // As permissive as the parent, so its reply needs no escalation card.
    const helper = await session("Helper", "acceptEdits");
    const waiter = connect(parent);
    const asking = call(parent, "send_to_session", { session_id: helper, message: "investigate HOLD", wait: true });
    await until(() => claude.sends.some((s) => s.sessionId === helper), "the helper's turn");
    await chatWebSocket.message(waiter.socket as never, JSON.stringify({ type: "cancel" }));
    expect((await asking).json.reply).toEqual({ replied: false, reason: "cancelled" });

    const late = await call(helper, "send_to_session", { session_id: parent, message: "found it" });
    expect(late.json.delivered).toBe("started");
    await until(() => claude.sends.some((s) => s.sessionId === parent), "the parent's new turn");
    expect(decodeMessageBlocks(stripSharedContext(claude.sends.find((s) => s.sessionId === parent)!.message)).fromSession?.sessionId).toBe(helper);
    claude.release();
  });

  it("asks before a session messages one with more permissions than its own", async () => {
    const careful = await session("Careful", "plan");
    const asking = call(careful, "send_to_session", { session_id: parent, message: "please run the migration" });
    expect(await answerCard(careful, "deny")).toEqual({ status: 200, kind: "escalation" });
    const refused = await asking;
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("more permissions");
  });

  it("refuses a design session as caller or target, and a session of another project", async () => {
    const design = await session("Design");
    setSessionDesignSlug(design, "landing");
    expect((await call(design, "session_status", {})).text).toContain("design session");
    expect((await call(parent, "send_to_session", { session_id: design, message: "x" })).text).toContain("design session");

    const far = await session("Far", "default", join(tmpdir(), "ppm-collab-other-project"));
    expect((await call(parent, "send_to_session", { session_id: far, message: "x" })).text).toContain("another project");
  });

  it("reports the linked sessions", async () => {
    const status = await call(parent, "session_status", {});
    const ids = status.json.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(ids).toContain(child);
  });

  it("runs a created session in its inherited mode once its registry entry is gone, as the escalation check reads it", async () => {
    // What create_session leaves once the child's entry was cleaned up, or after a restart: its
    // rows in PPM's database and no registry entry.
    const owner = await session("Owner", "default");
    const { id: kid } = await chatService.createSession("claude", {});
    setSessionMetadata(kid, PROJECT, projectPath);
    setSessionProvider(kid, "claude");
    setSessionPermissionMode(kid, "default");
    setSessionTitle(kid, "Kid");
    recordSpawn(kid, owner);
    expect(collabLiveState(kid)).toBeNull();

    // Both run in "default", so no card; the message starts the child's turn in that mode, not
    // in the provider's configured default.
    const sent = await call(owner, "send_to_session", { session_id: kid, message: "next step" });
    expect(sent.isError).toBe(false);
    expect(sent.json.delivered).toBe("started");
    expect(collabApprovalBroker.pendingEvent(owner)).toBeNull();
    await until(() => claude.sends.some((s) => s.sessionId === kid), "the child's turn");
    expect(claude.sends.find((s) => s.sessionId === kid)!.permissionMode).toBe("default");
    expect(collabLiveState(kid)?.permissionMode).toBe("default");
    expect(effectivePermissionMode(collabEnv, kid, "claude")).toBe("default");
    claude.abortQuery(kid);

    // A caller that names no mode (the CLI, a schedule) gets the stored one too.
    const { id: quiet } = await chatService.createSession("claude", {});
    setSessionPermissionMode(quiet, "plan");
    const turn = chatService.sendMessage("claude", quiet, "from a schedule")[Symbol.asyncIterator]();
    await turn.next();
    expect(claude.sends.find((s) => s.sessionId === quiet)!.permissionMode).toBe("plan");
    claude.abortQuery(quiet);
    await turn.return?.();
  });

  it("counts every message no turn of the recipient has taken yet", () => {
    const from = crypto.randomUUID(), to = crypto.randomUUID();
    collabEnv.unread.add(from, to, `m-${crypto.randomUUID()}`, "queued");
    collabEnv.unread.add(from, to, `m-${crypto.randomUUID()}`, "queued");
    expect(collabEnv.unread.peek(from, to)).toBe(2);
    expect(collabEnv.unread.take(from, to)).toBe(2);
    expect(collabEnv.unread.peek(from, to)).toBe(0);
  });

  it("lists a renamed child among its creator's links, finding its project under its old id", async () => {
    const lead = await session("Lead");
    const { id: draft } = await chatService.createSession("claude", {});
    setSessionMetadata(draft, PROJECT, projectPath);
    recordSpawn(draft, lead);
    const thread = crypto.randomUUID();
    setSessionMigratedTo(draft, thread);
    // A rename recorded before the project was carried with it.
    getDb().query("UPDATE session_metadata SET project_path = NULL, project_name = NULL WHERE session_id = ?").run(thread);

    const projectApp = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
    projectApp.use("*", async (c, next) => { c.set("projectPath", projectPath); c.set("projectName", PROJECT); await next(); });
    projectApp.route("/chat", chatSessionCollabRoutes);
    const res = await projectApp.request(`/chat/sessions/${lead}/links`);
    const links = ((await res.json()) as { data: Array<{ sessionId: string }> }).data;
    expect(links.map((l) => l.sessionId)).toContain(thread);
  });
});
