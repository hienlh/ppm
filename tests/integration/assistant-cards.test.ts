/**
 * Reports, PPM-detected signals and cards end to end in one process: the real chat socket layer
 * runs the manager chat, a child chat and the main Assistant session; a scripted provider stands in
 * for Claude; the real `/api/sessions-mcp` endpoint takes `report_to_assistant`; the card routes
 * answer; the wake queue starts every Assistant turn PPM begins. Time is a fake clock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { getDb, setSessionAssistant, setSessionMetadata, setSessionProvider, setSessionTitle } from "../../src/services/db.service.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { managerChats } from "../../src/services/assistant-managers/manager-chats.service.ts";
import { clearMainSessionIf, setMainSession } from "../../src/services/assistant/assistant-main-session.ts";
import { sessionCollabMcpHandler } from "../../src/services/session-collab/session-collab-endpoint.ts";
import { sessionCollabMcpTokens } from "../../src/services/session-collab/session-collab-tokens.ts";
import { assistantCardRoutes } from "../../src/server/routes/assistant-cards.ts";
import { setAssistantClock } from "../../src/services/assistant-wake/assistant-clock.ts";
import { assistantWakeQueue } from "../../src/services/assistant-wake/assistant-wake-queue.ts";
import { NEWS_OPENER } from "../../src/services/assistant-wake/wake-news-text.ts";
import { startAssistantCards, stopAssistantCards } from "../../src/services/assistant-cards/assistant-cards-startup.ts";
import { assistantCards } from "../../src/services/assistant-cards/assistant-cards.service.ts";
import { NOT_A_MANAGER } from "../../src/services/assistant-cards/manager-report-env.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import { FAILED_CARD_GRACE_MS, WAKE_TURNS_PER_HOUR } from "../../src/shared/assistant-limits.ts";
import type { AssistantCard } from "../../src/shared/assistant-cards.ts";
import type { AIProvider, ChatEvent, SendMessageOpts } from "../../src/types/chat.ts";
import type { PpmConfig } from "../../src/types/config.ts";

// ── A scripted Claude for every chat here ───────────────────────────────────────
const received: Array<{ sessionId: string; message: string; opts?: SendMessageOpts }> = [];
const answers = new Map<string, (approved: boolean) => void>();
let original: AIProvider | undefined;
const stub = {
  id: "claude", name: "Scripted Claude", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: "claude", title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: "claude", title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    received.push({ sessionId, message, opts });
    if (message.includes(NEWS_OPENER)) {
      yield { type: "text", content: "Noted." };
    } else if (message.includes("ASK-BASH")) {
      const requestId = crypto.randomUUID();
      const answer = new Promise<boolean>((resolve) => answers.set(requestId, resolve));
      yield { type: "approval_request", requestId, tool: "Bash", input: { command: "npm publish" } };
      yield { type: "text", content: (await answer) ? "Published." : "Not published." };
    } else if (message.includes("CRASH")) {
      throw new Error("The tool crashed");
    } else {
      yield { type: "text", content: "Build is green; three tickets left." };
    }
    yield { type: "done", sessionId };
  },
  pushMessage() {},
  resolveApproval(requestId: string, approved: boolean) { answers.get(requestId)?.(approved); answers.delete(requestId); },
  abortQuery() {},
} as unknown as AIProvider;

// ── Fixtures ────────────────────────────────────────────────────────────────────
const home = process.env.PPM_HOME!;
const projectPath = join(home, "cards-proj");
const app = new Hono();
app.all("/mcp", sessionCollabMcpHandler);
app.route("/api/assistant", assistantCardRoutes);
let projectsBefore: PpmConfig["projects"] = [];
let assistantBefore: unknown;
let manager = "";
let child = "";
let assistant = "";
let clock = Date.UTC(2026, 10, 10, 9, 0, 0);
const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
const advance = (ms: number) => {
  clock += ms;
  for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.fn(); }
};
let notifySpy: ReturnType<typeof spyOn>;

function chatIn(project: string, path: string, title: string): string {
  const id = `c-${crypto.randomUUID()}`;
  setSessionMetadata(id, project, path);
  setSessionProvider(id, "claude");
  setSessionTitle(id, title);
  return id;
}

beforeAll(async () => {
  mkdirSync(projectPath, { recursive: true });
  original = providerRegistry.get("claude");
  providerRegistry.register(stub);
  const saved = configService.get("assistant");
  assistantBefore = saved === undefined ? undefined : structuredClone(saved);
  setAssistantClock({ now: () => clock, setTimer: (fn, ms) => { const t = { at: clock + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } });
  projectsBefore = [...configService.get("projects")];
  configService.set("projects", [...projectsBefore, { name: "cards", path: projectPath }]);
  await import("../../src/server/ws/chat.ts");
  const { notificationService } = await import("../../src/services/notification.service.ts");
  notifySpy = spyOn(notificationService, "broadcast").mockImplementation(async () => {});
  manager = chatIn("cards", projectPath, "Manager");
  child = chatIn("cards", projectPath, "Child");
  await managerChats.assign("cards", manager, "user");
  assistant = `asst-${crypto.randomUUID()}`;
  setSessionMetadata(assistant, ASSISTANT_PROJECT_NAME, join(home, "assistant-work"));
  setSessionProvider(assistant, "claude");
  setSessionAssistant(assistant);
  setMainSession(assistant);
  startAssistantCards();
});
afterAll(() => {
  stopAssistantCards();
  assistantWakeQueue.stop();
  clearMainSessionIf(assistant);
  // The main session as it was before this file, so a later file's startup pick sees the same row.
  if (assistantBefore !== undefined) configService.set("assistant", assistantBefore as never);
  managerChats.unassign("cards");
  configService.set("projects", projectsBefore);
  setAssistantClock(null);
  notifySpy?.mockRestore();
  if (original) providerRegistry.register(original);
});
// Every test starts with no cards and a fresh hour of wake turns.
beforeEach(() => { getDb().run("DELETE FROM assistant_cards"); advance(2 * 60 * 60_000); });

const until = async (check: () => unknown, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};
const ctl = () => chatControl()!;
const idle = (id: string) => until(() => (ctl().liveState(id)?.phase ?? "idle") === "idle", `${id} idle`);
const wakeTurns = () => received.filter((r) => r.sessionId === assistant && r.message.includes(NEWS_OPENER));
const send = (id: string, text: string) => ctl().sendUserMessage(id, text, { origin: "telegram", projectName: "cards", providerId: "claude" });

async function report(sessionId: string, args: Record<string, unknown>) {
  const token = sessionCollabMcpTokens.mint({ sessionId });
  const res = await app.request("/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_to_assistant", arguments: args } }),
  });
  const result = (await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { text: result.content[0]!.text, isError: result.isError === true };
}
const cards = async (q = ""): Promise<AssistantCard[]> =>
  ((await (await app.request(`/api/assistant/cards${q}`)).json()) as { data: { cards: AssistantCard[] } }).data.cards;
const wakeOf = (id: string) => (getDb().query("SELECT wake FROM assistant_cards WHERE id = ?").get(id) as { wake: string }).wake;

describe("reports", () => {
  it("refuses a chat that is not the manager", async () => {
    const r = await report(child, { kind: "done", title: "x" });
    expect(r).toEqual({ isError: true, text: NOT_A_MANAGER });
  });

  it("turns a done report into a card with PPM's provenance line, and wakes the Assistant once", async () => {
    const before = wakeTurns().length;
    const r = await report(manager, { kind: "done", title: "🚀 Release 2.1 shipped", body: "All checks green." });
    expect(r.isError).toBe(false);
    const { cardId } = JSON.parse(r.text) as { cardId: string };
    const [card] = await cards();
    expect(card).toMatchObject({ id: cardId, kind: "done", title: "Release 2.1 shipped", provenance: "Written by the cards manager AI", projectName: "cards" });
    await until(() => wakeTurns().length === before + 1, "a wake turn");
    const wake = wakeTurns().at(-1)!;
    expect(wake.opts?.sharedContext).toContain("Manager news");
    expect(wake.opts?.sharedContext).toContain("\"Release 2.1 shipped\"");
    await idle(assistant);
    await until(() => wakeOf(cardId) === "delivered", "the news delivered");
  });

  it("starts at most the hourly cap of wake turns, then batches, then goes on after the hour", async () => {
    const before = wakeTurns().length;
    for (let i = 0; i < WAKE_TURNS_PER_HOUR + 1; i++) {
      await report(manager, { kind: "done", title: `Task ${i}` });
      if (i < WAKE_TURNS_PER_HOUR) {
        await until(() => wakeTurns().length === before + i + 1, `wake ${i + 1}`);
        await idle(assistant);
      }
    }
    await Bun.sleep(50);
    expect(wakeTurns().length).toBe(before + WAKE_TURNS_PER_HOUR);
    advance(60 * 60_000 + 1);
    assistantWakeQueue.tick();
    await until(() => wakeTurns().length === before + WAKE_TURNS_PER_HOUR + 1, "the held wake");
    await idle(assistant);
  });

  it("hands a manager's answer nobody waited for to the Assistant as one wake, with no card", async () => {
    const before = wakeTurns().length;
    const { noteManagerAsked } = await import("../../src/services/assistant-cards/manager-reply-expectations.ts");
    noteManagerAsked(assistant, manager, "cards", false);
    advance(20 * 60_000);
    await send(manager, "How is the release going?");
    await until(() => wakeTurns().length === before + 1, "the late-reply wake");
    const news = wakeTurns().at(-1)!.opts?.sharedContext ?? "";
    expect(news).toContain("answered your earlier message");
    expect(news).toContain("Build is green; three tickets left.");
    expect(await cards()).toHaveLength(0);
    await idle(assistant);
    await idle(manager);
  });
});

describe("what PPM sees in the manager chat", () => {
  it("mirrors the manager's approval; Allow on the card runs it", async () => {
    await send(manager, "ASK-BASH please");
    await until(async () => (await cards()).length === 1, "the approval card");
    const [card] = await cards();
    expect(card).toMatchObject({ kind: "approval", status: "open", payload: { deciding: { text: "npm publish", complete: true } } });
    const res = await app.request(`/api/assistant/cards/${card!.id}/answer`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "allow" }),
    });
    expect(res.status).toBe(200);
    await idle(manager);
    expect(received.some((r) => r.sessionId === manager)).toBe(true);
    expect(assistantCards.get(card!.id)!.status).toBe("answered");
    const again = await app.request(`/api/assistant/cards/${card!.id}/answer`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "deny" }),
    });
    expect(again.status).toBe(409);
  });

  it("resolves the card when the approval is answered in the chat, and cards nothing for a child chat", async () => {
    await send(child, "ASK-BASH child");
    await until(() => !!ctl().liveState(child)?.card, "the child's card");
    await send(manager, "ASK-BASH again");
    await until(() => !!ctl().liveState(manager)?.card, "the manager's card");
    const requestId = ctl().liveState(manager)!.card!.requestId;
    expect(ctl().answerApproval(manager, requestId, { approved: false }, "telegram")).toBe("answered");
    const list = await cards();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "resolved", answer: { note: "Answered on Telegram" } });
    ctl().answerApproval(child, ctl().liveState(child)!.card!.requestId, { approved: false }, "telegram");
    await idle(manager);
    await idle(child);
  });

  it("keeps one failed card when the manager reports a failure inside the grace period", async () => {
    await send(manager, "CRASH now");
    await idle(manager);
    advance(5 * 60_000);
    await report(manager, { kind: "failed", title: "Deploy failed", body: "The tool crashed." });
    advance(FAILED_CARD_GRACE_MS);
    const list = await cards();
    expect(list.map((c) => [c.kind, c.title])).toEqual([["failed", "Deploy failed"]]);
    await idle(assistant);
  });
});

describe("after a restart", () => {
  it("re-queues pending news, and marks a request card gone only when no chat still shows it", async () => {
    await send(manager, "ASK-BASH live");
    await until(async () => (await cards()).length === 1, "a live approval card");
    const [live] = await cards();
    stopAssistantCards();
    assistantWakeQueue.stop();
    const stale = assistantCards.create({
      kind: "approval", projectName: "cards", projectPath, sessionId: child, title: "Old",
      payload: { requestId: "request-from-before-the-restart", deciding: { kind: "command", title: "Bash", facts: [], text: "ls", complete: true } },
    });
    const pending = assistantCards.create({ kind: "done", projectName: "cards", projectPath, sessionId: manager, title: "Done while down", wake: true });
    const before = wakeTurns().length;
    startAssistantCards();
    expect(assistantCards.get(stale.id)!.status).toBe("gone");
    expect(assistantCards.get(live!.id)!.status).toBe("open");
    await until(() => wakeTurns().length === before + 1, "the re-queued wake");
    await until(() => wakeOf(pending.id) === "delivered", "the re-queued news delivered");
    ctl().answerApproval(manager, ctl().liveState(manager)!.card!.requestId, { approved: false }, "telegram");
    await idle(manager);
    await idle(assistant);
  });
});
