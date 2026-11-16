/**
 * The PPM Assistant's cards on Telegram, end to end: a fake Bot API plays the phone, the real chat
 * socket layer runs the manager chat and the main Assistant session (a scripted Claude), the real
 * report tool files cards, the real bridge sends them, and the card routes answer from PPM. Time
 * is a fake clock, so quiet hours can begin and end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { getDb, setSessionAssistant, setSessionMetadata, setSessionProvider, setSessionTitle, upsertApprovedPairing } from "../../src/services/db.service.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { managerChats } from "../../src/services/assistant-managers/manager-chats.service.ts";
import { clearMainSessionIf, setMainSession } from "../../src/services/assistant/assistant-main-session.ts";
import { sessionCollabMcpHandler } from "../../src/services/session-collab/session-collab-endpoint.ts";
import { sessionCollabMcpTokens } from "../../src/services/session-collab/session-collab-tokens.ts";
import { pairCounter } from "../../src/services/session-collab/pair-counter.ts";
import { assistantCardRoutes } from "../../src/server/routes/assistant-cards.ts";
import { setAssistantClock } from "../../src/services/assistant-wake/assistant-clock.ts";
import { assistantWakeQueue } from "../../src/services/assistant-wake/assistant-wake-queue.ts";
import { startAssistantCards, stopAssistantCards } from "../../src/services/assistant-cards/assistant-cards-startup.ts";
import { assistantCards } from "../../src/services/assistant-cards/assistant-cards.service.ts";
import { assistantTelegramBridge } from "../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { CLOSED_CARD_NOT_SENT } from "../../src/services/assistant-telegram/assistant-telegram-card-replies.ts";
import { BRIDGE_STATE_ROW } from "../../src/services/assistant-telegram/assistant-telegram-state.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { decodeMessageBlocks } from "../../src/shared/chat-message-blocks.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import { startFakeTelegram } from "../helpers/fake-telegram-bot-api.ts";
import type { AIProvider, ChatEvent } from "../../src/types/chat.ts";
import type { PpmConfig } from "../../src/types/config.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

// ── A scripted Claude ────────────────────────────────────────────────────────────
const received: Array<{ sessionId: string; message: string }> = [];
const answers = new Map<string, (approved: boolean) => void>();
let original: AIProvider | undefined;
const stub = {
  id: "claude", name: "Scripted Claude", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: "claude", title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: "claude", title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    received.push({ sessionId, message });
    if (message.includes("ASK-BASH")) {
      const requestId = crypto.randomUUID();
      const answer = new Promise<boolean>((resolve) => answers.set(requestId, resolve));
      yield { type: "approval_request", requestId, tool: "Bash", input: { command: "npm publish" } };
      yield { type: "text", content: (await answer) ? "Published." : "Not published." };
    } else {
      yield { type: "text", content: "Noted." };
    }
    yield { type: "done", sessionId };
  },
  // Each scripted turn is its own stream: a message for a chat whose turn is ending waits for it
  // and opens the next turn, as with a stream that has closed.
  hasStreamingSession() { return false; },
  pushMessage(sessionId: string, message: string) { received.push({ sessionId, message }); },
  resolveApproval(requestId: string, approved: boolean) { answers.get(requestId)?.(approved); answers.delete(requestId); },
  abortQuery() {},
} as unknown as AIProvider;

// ── Fixtures ─────────────────────────────────────────────────────────────────────
const home = process.env.PPM_HOME!;
const projectPath = join(home, "tg-cards-proj");
const app = new Hono();
app.all("/mcp", sessionCollabMcpHandler);
app.route("/api/assistant", assistantCardRoutes);
const PHONE = 8_500_001;
let projectsBefore: PpmConfig["projects"] = [];
let assistantBefore: unknown;
const clawbotBefore = configService.get("clawbot");
let manager = "";
let assistant = "";
let clock = Date.UTC(2026, 10, 10, 9, 0, 0);
const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
const advance = (ms: number) => {
  clock += ms;
  for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.fn(); }
};
let notifySpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  getDb().query("DELETE FROM config WHERE key = ?").run(BRIDGE_STATE_ROW);
  getDb().query("DELETE FROM clawbot_paired_chats").run();
  upsertApprovedPairing(String(PHONE), String(PHONE), "Phone");
  mkdirSync(projectPath, { recursive: true });
  original = providerRegistry.get("claude");
  providerRegistry.register(stub);
  const saved = configService.get("assistant");
  assistantBefore = saved === undefined ? undefined : structuredClone(saved);
  configService.set("assistant", { ...(saved as object ?? {}), quiet_hours: { enabled: true, start: "22:00", end: "07:00" }, timezone: "UTC" } as never);
  configService.set("clawbot", { enabled: true, show_tool_calls: false, debounce_ms: 30 } as never);
  setAssistantClock({ now: () => clock, setTimer: (fn, ms) => { const t = { at: clock + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } });
  projectsBefore = [...configService.get("projects")];
  configService.set("projects", [...projectsBefore, { name: "tgcards", path: projectPath }]);
  await import("../../src/server/ws/chat.ts");
  const { notificationService } = await import("../../src/services/notification.service.ts");
  notifySpy = spyOn(notificationService, "broadcast").mockImplementation(async () => {});
  manager = `c-${crypto.randomUUID()}`;
  setSessionMetadata(manager, "tgcards", projectPath);
  setSessionProvider(manager, "claude");
  setSessionTitle(manager, "Manager");
  await managerChats.assign("tgcards", manager, "user");
  assistant = `asst-${crypto.randomUUID()}`;
  setSessionMetadata(assistant, ASSISTANT_PROJECT_NAME, join(home, "assistant-work"));
  setSessionProvider(assistant, "claude");
  setSessionAssistant(assistant);
  setMainSession(assistant);
  startAssistantCards();
  await assistantTelegramBridge.start({
    token: fake.token, client: { editIntervalMs: 0, sleep: async () => {} },
    debounceMs: 30, pollTimeoutS: 1, scaleDelay: (ms) => ms / 1000,
    sessionLink: async (p, id) => `http://localhost:8080/assistant?session=${p}/${id}`,
    chatLink: async (project, p, id) => `http://localhost:8080/project/${project}?openChat=${p}/${id}`,
  });
});

afterAll(async () => {
  await assistantTelegramBridge.stop();
  stopAssistantCards();
  assistantWakeQueue.stop();
  clearMainSessionIf(assistant);
  // Quiet hours must not follow this file into the next one.
  configService.set("assistant", (assistantBefore ?? {}) as never);
  getDb().query("DELETE FROM clawbot_paired_chats WHERE telegram_chat_id = ?").run(String(PHONE));
  configService.set("clawbot", clawbotBefore!);
  managerChats.unassign("tgcards");
  configService.set("projects", projectsBefore);
  setAssistantClock(null);
  notifySpy?.mockRestore();
  if (original) providerRegistry.register(original);
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
});

// Every test starts at 09:00 the next day (outside quiet hours) with no cards.
beforeEach(() => {
  getDb().run("DELETE FROM assistant_cards");
  advance(24 * 60 * 60_000 - ((clock - Date.UTC(2026, 10, 10, 9, 0, 0)) % (24 * 60 * 60_000)));
});

const ctl = () => chatControl()!;
const until = (check: () => unknown, ms = 5000) => fake.waitFor(() => check(), ms);
const idle = (id: string) => until(() => (ctl().liveState(id)?.phase ?? "idle") === "idle");
const lastWith = (part: string) => fake.sent(PHONE).findLast((m) => m.text.includes(part));
const button = (messageId: number, text: string) => fake.buttons(PHONE, messageId).flat().find((b) => b.text === text)?.callback_data;
const toManager = () => received.filter((r) => r.sessionId === manager);
const replyTo = (messageId: number, text: string, extra: Record<string, unknown> = {}) =>
  fake.pushText(PHONE, PHONE, text, "private", { reply_to_message: { message_id: messageId, chat: { id: PHONE, type: "private" }, date: 0 }, ...extra });

async function report(args: Record<string, unknown>): Promise<string> {
  const token = sessionCollabMcpTokens.mint({ sessionId: manager });
  const res = await app.request("/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_to_assistant", arguments: args } }),
  });
  const result = (await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  if (result.isError) throw new Error(result.content[0]!.text);
  return (JSON.parse(result.content[0]!.text) as { cardId: string }).cardId;
}

/** Keeps a design screenshot as `design_screenshot` would, for this test's project. */
function keepShot(id: string, file: string, label: string): void {
  const dir = join(home, "design-shots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.png`), new Uint8Array(64).fill(1));
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id, projectPath, slug: "kho-task", designTitle: "Kho task", file, label, width: 1280, height: 900, createdAt: new Date().toISOString(),
  }));
}

const DRAFT = { to: "#culi-devs → @Top", text: "Anh Top ơi, lỗi pension kỳ 32 em fix xong ở PR #1301 rồi 🙏" };

describe("OK on a card", () => {
  it("from Telegram reaches the manager as the user's OK on that draft; a later OK in PPM is told it was answered", async () => {
    const cardId = await report({ kind: "needs_decision", title: "Slack draft to Top", body: "Fix is ready.", draft: DRAFT });
    const shown = await until(() => lastWith("Slack draft to Top"));
    expect(shown.text).toContain("Written by the tgcards manager AI");
    const before = toManager().length;
    fake.pressButton(PHONE, PHONE, shown.message_id, button(shown.message_id, "OK, send")!);
    await until(() => toManager().length > before);
    const sent = decodeMessageBlocks(toManager().at(-1)!.message);
    const card = assistantCards.get(cardId)!;
    expect(sent.content).toBe("OK");
    expect(sent.userWords).toMatchObject({ cardId, channel: "telegram", ok: true, draftSha256: card.payload.draft!.sha256 });
    await until(() => fake.sent(PHONE).find((m) => m.message_id === shown.message_id)?.text.includes("OK given on Telegram"));
    expect(fake.buttons(PHONE, shown.message_id).flat().some((b) => b.text === "OK, send")).toBe(false);

    const again = await app.request(`/api/assistant/cards/${cardId}/ok`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draftSha256: card.payload.draft!.sha256 }),
    });
    expect(again.status).toBe(409);
    const body = await again.json() as { error: string; data: { question: string } };
    expect(body.data.question).toMatch(/^Already answered on Telegram at /);
    await idle(manager);
    expect(toManager().filter((r) => decodeMessageBlocks(r.message).userWords?.cardId === cardId)).toHaveLength(1);
  });
});

describe("a reply on Telegram", () => {
  it("reaches the manager byte for byte, says where it went, and resets the pair counts", async () => {
    await report({ kind: "needs_decision", title: "Release 2.14?", draft: DRAFT });
    const shown = await until(() => lastWith("Release 2.14?"));
    pairCounter.record(assistant, manager);
    expect(pairCounter.count(assistant, manager)).toBe(1);
    const text = "Sửa “chiều nay” thành “sáng mai” rồi gửi nhé 👍\nCảm ơn";
    const before = toManager().length;
    replyTo(shown.message_id, text);
    await until(() => toManager().length > before);
    const sent = decodeMessageBlocks(toManager().at(-1)!.message);
    expect(sent.content).toBe(text);
    expect(sent.userWords).toMatchObject({ channel: "telegram" });
    expect(sent.userWords?.ok).toBeUndefined();
    await until(() => lastWith("manager, word for word"));
    expect(pairCounter.count(assistant, manager)).toBe(0);
    await idle(manager);
  });

  it("to a card from two days ago that still waits asks first, and Send anyway forwards it", async () => {
    await report({ kind: "done", title: "Nightly build green" });
    const shown = await until(() => lastWith("Nightly build green"));
    advance(2 * 24 * 60 * 60_000);
    const before = toManager().length;
    replyTo(shown.message_id, "Run it again tonight");
    const ask = await until(() => lastWith("send anyway?"));
    expect(ask.text).toMatch(/^This card is from .* — send anyway\?$/);
    expect(toManager().length).toBe(before);
    fake.pressButton(PHONE, PHONE, ask.message_id, button(ask.message_id, "Send anyway")!);
    await until(() => toManager().length > before);
    expect(decodeMessageBlocks(toManager().at(-1)!.message).content).toBe("Run it again tonight");
    await idle(manager);
  });

  it("to a card answered only in words asks first, and Send anyway goes on with that conversation", async () => {
    await report({ kind: "needs_decision", title: "Which day for the demo?" });
    const shown = await until(() => lastWith("Which day for the demo?"));
    const before = toManager().length;
    replyTo(shown.message_id, "Thursday, if the build is green");
    await until(() => toManager().length > before);
    await idle(manager);
    // The card is answered by those words, not decided: more words continue the conversation.
    const seen = Math.max(...fake.sent(PHONE).map((m) => m.message_id));
    replyTo(shown.message_id, "Make it Friday instead");
    // This reply's own question, not one an earlier test left in the chat.
    const ask = await until(() => fake.sent(PHONE).find((m) => m.message_id > seen && m.text.includes("send anyway?")));
    fake.pressButton(PHONE, PHONE, ask.message_id, button(ask.message_id, "Send anyway")!);
    await until(() => toManager().length > before + 1);
    expect(decodeMessageBlocks(toManager().at(-1)!.message).content).toBe("Make it Friday instead");
    await idle(manager);
  });

  it("to a card that was decided (dismissed) is refused at once, with no Send anyway", async () => {
    const cardId = await report({ kind: "done", title: "Nightly build red" });
    const shown = await until(() => lastWith("Nightly build red"));
    await app.request(`/api/assistant/cards/${cardId}/dismiss`, { method: "POST" });
    const before = toManager().length;
    replyTo(shown.message_id, "Run it again tonight");
    const said = await until(() => lastWith(CLOSED_CARD_NOT_SENT));
    expect(button(said.message_id, "Send anyway")).toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(toManager().length).toBe(before);
  });

  it("Send anyway on a waiting card decided elsewhere after the question was asked is refused, and nothing is forwarded", async () => {
    const cardId = await report({ kind: "needs_decision", title: "Rotate the staging keys?" });
    const shown = await until(() => lastWith("Rotate the staging keys?"));
    advance(2 * 24 * 60 * 60_000);
    const before = toManager().length;
    replyTo(shown.message_id, "Yes, tonight");
    const ask = await until(() => lastWith("send anyway?"));
    // Answered in PPM while the question waited on the phone.
    await app.request(`/api/assistant/cards/${cardId}/dismiss`, { method: "POST" });
    fake.pressButton(PHONE, PHONE, ask.message_id, button(ask.message_id, "Send anyway")!);
    await until(() => lastWith(CLOSED_CARD_NOT_SENT));
    await new Promise((r) => setTimeout(r, 200));
    expect(toManager().length).toBe(before);
  });

  it("to an approval card refuses that request, and the words arrive", async () => {
    await ctl().sendUserMessage(manager, "ASK-BASH now", { origin: "telegram", projectName: "tgcards", providerId: "claude" });
    const shown = await until(() => lastWith("npm publish"));
    // Read among the Assistant's answers, the card has to say the manager chat is stopped on it.
    expect(shown.text.split("\n")[0]).toMatch(/^🔐 Manager chat “.+” in tgcards is stopped, waiting for your decision$/);
    const before = toManager().length;
    replyTo(shown.message_id, "Not yet: run the tests first");
    await until(() => toManager().length > before);
    expect(decodeMessageBlocks(toManager().at(-1)!.message).content).toBe("Not yet: run the tests first");
    await until(() => fake.sent(PHONE).find((m) => m.message_id === shown.message_id)?.text.includes("No longer waiting"));
    await idle(manager);
    expect(received.some((r) => r.sessionId === manager && r.message === "ASK-BASH now")).toBe(true);
  });

  it("is refused when forwarded from someone else", async () => {
    await report({ kind: "needs_decision", title: "Forward test" });
    const shown = await until(() => lastWith("Forward test"));
    const before = toManager().length;
    replyTo(shown.message_id, "OK do it", { forward_origin: { type: "user", sender_user: { first_name: "Eve" } } });
    await until(() => lastWith("A forwarded message cannot answer a card"));
    await assistantTelegramBridge.settle();
    expect(toManager().length).toBe(before);
  });
});

describe("quiet hours", () => {
  it("hold every card but urgent ones within the cap, then send one header and the cards, skipping gone ones", async () => {
    advance(14 * 60 * 60_000); // 23:00 UTC
    const sentBefore = fake.sent(PHONE).length;
    const done = await report({ kind: "done", title: "Q done" });
    await report({ kind: "urgent", title: "Q urgent one" });
    await report({ kind: "urgent", title: "Q urgent two" });
    const third = await report({ kind: "urgent", title: "Q urgent three" });
    await ctl().sendUserMessage(manager, "ASK-BASH quiet", { origin: "telegram", projectName: "tgcards", providerId: "claude" });
    await until(() => assistantCards.list({ limit: 10 }).cards.some((c) => c.kind === "approval" && c.status === "open"));
    await until(() => lastWith("Q urgent two"));
    expect(assistantCards.get(third)).toMatchObject({ kind: "needs_decision", payload: { urgentCapped: true } });
    const approval = assistantCards.list({ limit: 10 }).cards.find((c) => c.kind === "approval")!;
    ctl().answerApproval(manager, approval.payload.requestId!, { approved: false }, "ws");
    await idle(manager);
    await assistantTelegramBridge.settle();
    const during = fake.sent(PHONE).slice(sentBefore).map((m) => m.text);
    expect(during.some((t) => t.includes("Q urgent one"))).toBe(true);
    expect(during.some((t) => t.includes("Q done") || t.includes("Q urgent three") || t.includes("npm publish"))).toBe(false);

    advance(8 * 60 * 60_000); // 07:00
    await until(() => lastWith("Q urgent three"));
    await assistantTelegramBridge.settle();
    const after = fake.sent(PHONE).slice(sentBefore).map((m) => m.text);
    const header = after.findIndex((t) => t === "While you were away: 2 items");
    expect(header).toBeGreaterThan(-1);
    expect(after.slice(header + 1).map((t) => t.split("\n")[0])).toEqual(["✅ Done · tgcards", "🔔 Needs your decision · tgcards"]);
    expect(after.some((t) => t.includes("npm publish"))).toBe(false);
    expect(assistantCards.get(done)!.status).toBe("open");
  });
});

describe("a card with design pictures", () => {
  it("sends the pictures as one album just before the card, numbered, with no link", async () => {
    const one = "1".repeat(32), two = "2".repeat(32);
    keepShot(one, "index.html", "Light");
    keepShot(two, "variant-2.html", "Dark");
    const before = fake.sent(PHONE).length;
    await report({ kind: "needs_decision", title: "Pick the Kho task look", body: "Reply 1 or 2.", images: [one, two] });
    const card = await until(() => lastWith("Pick the Kho task look"));
    const fresh = fake.sent(PHONE).slice(before);
    const photos = fresh.filter((m) => m.photo);
    expect(photos).toHaveLength(2);
    expect(photos[0]!.photo!.album).toBe(photos[1]!.photo!.album);
    expect(photos[0]!.text).toContain("1. Kho task — index.html · Light");
    expect(photos[1]!.text).toContain("2. Kho task — variant-2.html · Dark");
    expect(photos.every((p) => !/https?:\/\//.test(p.text))).toBe(true);
    // Pictures first, then the card that is answered.
    expect(fresh.indexOf(photos[1]!)).toBeLessThan(fresh.indexOf(card));
    expect(card.text).toContain("2 pictures above");
  });

  it("refuses an id that is not a screenshot of this project", async () => {
    await expect(report({ kind: "done", title: "x", images: ["9".repeat(32)] })).rejects.toThrow("not a screenshot");
  });
});
