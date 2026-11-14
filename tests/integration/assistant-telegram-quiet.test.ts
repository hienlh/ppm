/**
 * "Quiet while I'm at PPM", end to end: the real chat socket layer runs an Assistant session (a
 * scripted provider), a browser types into it, the fake Bot API plays the phone, and every check
 * reads `disable_notification` off what the bot actually sent. The user's presence, the bridge's
 * clock and the reminders' clock are the test's, so "five minutes later" takes no time.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { providerRegistry } from "../../src/providers/registry.ts";
import { getDb, upsertApprovedPairing } from "../../src/services/db.service.ts";
import { configService } from "../../src/services/config.service.ts";
import { getTelegramBinding } from "../../src/services/assistant-hub/assistant-hub-db.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { stripTelegramHtml } from "../../src/services/telegram/telegram-html-format.ts";
import { AssistantTelegramBridge } from "../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { quietWhileInPpm, REMINDER_HTML, setQuietWhileInPpm, TelegramSilence } from "../../src/services/assistant-telegram/assistant-telegram-silence.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import { startFakeTelegram, type FakeSentMessage } from "../helpers/fake-telegram-bot-api.ts";
import type { AssistantClock } from "../../src/services/assistant-wake/assistant-clock.ts";
import type { AIProvider, ChatEvent } from "../../src/types/chat.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;
const MIN = 60_000;

// ── A scripted Assistant provider ─────────────────────────────────────────────
const P = "stub-telegram-quiet";
const answers = new Map<string, (approved: boolean) => void>();
const gates = new Map<string, () => void>();

providerRegistry.register({
  id: P, name: "Quiet stub", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: `tgq-${crypto.randomUUID()}`, providerId: P, title: "", createdAt: new Date().toISOString() }; },
  async resumeSession(id: string) { return { id, providerId: P, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    if (message.startsWith("approve:")) {
      const requestId = crypto.randomUUID();
      const answer = new Promise<boolean>((resolve) => answers.set(requestId, resolve));
      yield { type: "approval_request", requestId, tool: "Bash", input: { command: message.slice("approve:".length) } };
      yield { type: "text", content: `ran: ${(await answer) ? "approved" : "denied"}` };
    } else if (message.startsWith("slow")) {
      yield { type: "text", content: "Working on it" };
      await new Promise<void>((resolve) => gates.set(sessionId, resolve));
      yield { type: "text", content: " — finished." };
    } else {
      yield { type: "text", content: `Echo: ${message}` };
    }
    yield { type: "done", sessionId };
  },
  resolveApproval(requestId: string, approved: boolean) {
    answers.get(requestId)?.(approved);
    answers.delete(requestId);
  },
  abortQuery() {},
} as unknown as AIProvider);

// ── The user's presence and the clocks, all the test's ───────────────────────
// Behind the real clock on purpose: a message the fake phone sends is dated by the real clock, and
// one dated well before the bridge's "now" would be taken for a message sent while PPM was off.
let clockNow = Date.now() - 12 * 60 * MIN;
/** When a PPM tab last saw real input; null: never since the server started. */
let lastInput: number | null = null;
let quietUntil: number | null = null;
const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
const reminderClock: AssistantClock = {
  now: () => clockNow,
  setTimer: (fn, ms) => {
    const t = { at: clockNow + ms, fn, live: true };
    timers.push(t);
    return () => { t.live = false; };
  },
};
/** Moves every clock on: the bridge's, presence's and the reminders'. */
function advance(ms: number): void {
  clockNow += ms;
  for (const t of timers) if (t.live && t.at <= clockNow) { t.live = false; t.fn(); }
}
const silence = new TelegramSilence({
  enabled: quietWhileInPpm,
  idleMs: (now) => (lastInput === null ? null : now - lastInput),
  now: () => clockNow,
  windowMs: 5 * MIN,
});

// ── The chat socket layer, served so a browser can join a session ─────────────
const PORT = 19897;
let server: ReturnType<typeof Bun.serve>;
const originalAssistant = configService.get("assistant");
const originalClawbot = configService.get("clawbot");
const bridge = new AssistantTelegramBridge();

beforeAll(async () => {
  getDb().query("DELETE FROM config WHERE key = 'assistant_telegram_state'").run();
  configService.set("assistant", { ...originalAssistant, default_provider: P });
  setQuietWhileInPpm(true);
  const { chatWebSocket } = await import("../../src/server/ws/chat.ts");
  server = Bun.serve({
    port: PORT,
    fetch(req, srv) {
      const sessionId = new URL(req.url).pathname.split("/ws/chat/")[1] ?? "";
      if (srv.upgrade(req, { data: { type: "chat", sessionId, projectName: ASSISTANT_PROJECT_NAME } })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: { open: chatWebSocket.open as any, message: chatWebSocket.message as any, close: chatWebSocket.close as any },
  });
  await bridge.start({
    token: fake.token,
    client: { editIntervalMs: 0, sleep: async () => {} },
    debounceMs: 30,
    pollTimeoutS: 1,
    scaleDelay: (ms: number) => ms / 1000,
    now: () => clockNow,
    sessionLink: async (providerId: string, sessionId: string) => `http://localhost:8080/assistant?session=${providerId}/${sessionId}`,
    silence,
    reminders: { clock: reminderClock, quietEnd: () => quietUntil, delayMs: 5 * MIN },
  });
});

afterAll(async () => {
  await bridge.stop();
  server?.stop(true);
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
  configService.set("assistant", originalAssistant);
  configService.set("clawbot", originalClawbot as never);
});

async function browser(sessionId: string) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/chat/${sessionId}`);
  const messages: any[] = [];
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await fake.waitFor(() => messages.find((m) => m.type === "session_state"), 5000);
  return { ws, send: (content: string) => ws.send(JSON.stringify({ type: "message", content })) };
}

let nextChat = 8_700_000;
const until = <T>(check: () => T | undefined | null | false, ms = 5000) => fake.waitFor(check, ms);
/** What the bot sent to a chat after the first `from` messages, as [text, silent] pairs. */
const sentSince = (chat: number, from: number) => fake.sent(chat).slice(from).map((m) => [m.text, m.silent] as const);
const idle = (sessionId: string) => until(() => chatControl()!.liveState(sessionId)?.phase === "idle");

/** A connected phone, bound to a fresh Assistant session by one message typed on it. */
async function phone(): Promise<{ chat: number; sessionId: string }> {
  const chat = nextChat++;
  upsertApprovedPairing(String(chat), String(chat), `Phone ${chat}`);
  fake.pushText(chat, chat, "start");
  await until(() => fake.sent(chat).some((m) => m.text === "Echo: start"));
  const sessionId = getTelegramBinding(String(chat))!.sessionId;
  await idle(sessionId);
  return { chat, sessionId };
}

/** Each case starts with the user away from PPM and every earlier sign of them long past. */
function freshStart(): void {
  advance(10 * MIN);
  lastInput = null;
}

const cardWith = (chat: number, part: string): FakeSentMessage | undefined => fake.sent(chat).findLast((m) => m.text.includes(part));

describe("quiet while the user is at PPM", () => {
  it("leaves a message typed on Telegram as it was: its answer rings, even with the user at PPM", async () => {
    freshStart();
    lastInput = clockNow;
    const { chat, sessionId } = await phone();
    // The first answer ("…" then "Echo: start") was one new message, with a sound.
    expect(fake.sent(chat).map((m) => [m.text, m.silent])).toEqual([["Echo: start", false]]);
    fake.pushText(chat, chat, "from the phone");
    await until(() => fake.sent(chat).some((m) => m.text === "Echo: from the phone"));
    await idle(sessionId);
    expect(sentSince(chat, 1)).toEqual([["Echo: from the phone", false]]);
  });

  it("copies a message typed in PPM and its answer without a sound", async () => {
    freshStart();
    const { chat, sessionId } = await phone();
    const b = await browser(sessionId);
    const from = fake.sent(chat).length;
    b.send("typed in PPM");
    await until(() => fake.sent(chat).some((m) => m.text === "Echo: typed in PPM"));
    await idle(sessionId);
    await bridge.settle();
    expect(sentSince(chat, from)).toEqual([["🖥 (PPM) typed in PPM", true], ["Echo: typed in PPM", true]]);
    b.ws.close();
  });

  it("finishes a long answer typed in PPM in place, without a new message, while the user is still there", async () => {
    freshStart();
    const { chat, sessionId } = await phone();
    const b = await browser(sessionId);
    const from = fake.sent(chat).length;
    const deletedBefore = fake.deleted.length;
    b.send("slow job");
    await until(() => fake.sent(chat).some((m) => m.text.startsWith("Working on it")));
    advance(60_000);
    lastInput = clockNow;
    gates.get(sessionId)!();
    await until(() => fake.sent(chat).some((m) => m.text === "Working on it — finished."));
    await idle(sessionId);
    await bridge.settle();
    expect(sentSince(chat, from)).toEqual([["🖥 (PPM) slow job", true], ["Working on it — finished.", true]]);
    expect(fake.deleted.length).toBe(deletedBefore);
    b.ws.close();
  });

  it("rings the final answer when the user left PPM for more than five minutes before the turn ended", async () => {
    freshStart();
    const { chat, sessionId } = await phone();
    const b = await browser(sessionId);
    const from = fake.sent(chat).length;
    b.send("slow report");
    await until(() => fake.sent(chat).some((m) => m.text.startsWith("Working on it")));
    // Typed at the start, then nothing from PPM for six minutes.
    advance(6 * MIN);
    gates.get(sessionId)!();
    await until(() => fake.sent(chat).some((m) => m.text === "Working on it — finished." && !m.silent));
    await idle(sessionId);
    await bridge.settle();
    // The silent draft was deleted; the answer came again as a new message, with a sound.
    expect(sentSince(chat, from)).toEqual([["🖥 (PPM) slow report", true], ["Working on it — finished.", false]]);
    expect(fake.deleted.findLast((m) => m.chat_id === chat)?.silent).toBe(true);
    b.ws.close();
  });

  it("sends a card silently while the user touched PPM in the last five minutes, then reminds once with a sound", async () => {
    freshStart();
    const { chat, sessionId } = await phone();
    lastInput = clockNow - 2 * MIN;
    fake.pushText(chat, chat, "approve:npm publish");
    const card = await until(() => cardWith(chat, "npm publish"));
    expect(card.silent).toBe(true);
    const count = fake.sent(chat).length;
    advance(5 * MIN - 1000);
    await bridge.settle();
    expect(fake.sent(chat).length).toBe(count);
    advance(1000);
    const reminder = await until(() => fake.sent(chat).find((m) => m.reply_to === card.message_id));
    expect(reminder.text).toBe(stripTelegramHtml(REMINDER_HTML));
    expect(reminder.silent).toBe(false);
    // Once only.
    advance(30 * MIN);
    await bridge.settle();
    expect(fake.sent(chat).filter((m) => m.reply_to === card.message_id)).toHaveLength(1);
    const deny = fake.buttons(chat, card.message_id).flat().find((x) => x.text === "Deny")!;
    fake.pressButton(chat, chat, card.message_id, deny.callback_data!);
    await until(() => fake.sent(chat).some((m) => m.text === "ran: denied"));
    await idle(sessionId);
  });

  it("does not remind about a card answered within five minutes", async () => {
    freshStart();
    const { chat, sessionId } = await phone();
    lastInput = clockNow;
    fake.pushText(chat, chat, "approve:ls");
    const card = await until(() => cardWith(chat, "ls"));
    expect(card.silent).toBe(true);
    const allow = fake.buttons(chat, card.message_id).flat().find((x) => x.text === "Allow")!;
    fake.pressButton(chat, chat, card.message_id, allow.callback_data!);
    await until(() => fake.sent(chat).some((m) => m.text === "ran: approved"));
    await idle(sessionId);
    advance(5 * MIN);
    await bridge.settle();
    expect(fake.sent(chat).some((m) => m.reply_to === card.message_id)).toBe(false);
  });

  it("rings a card as before when the user has been away from PPM for more than five minutes, with no reminder", async () => {
    freshStart();
    const { chat, sessionId } = await phone();
    lastInput = clockNow - 6 * MIN;
    fake.pushText(chat, chat, "approve:pwd");
    const card = await until(() => cardWith(chat, "pwd"));
    expect(card.silent).toBe(false);
    advance(5 * MIN);
    await bridge.settle();
    expect(fake.sent(chat).some((m) => m.reply_to === card.message_id)).toBe(false);
    chatControl()!.answerApproval(sessionId, chatControl()!.liveState(sessionId)!.card!.requestId, { approved: false }, "telegram");
    await idle(sessionId);
  });

  it("lets quiet hours win: a card sent silently in quiet hours gets no reminder", async () => {
    freshStart();
    const { chat, sessionId } = await phone();
    lastInput = clockNow;
    quietUntil = clockNow + 8 * 60 * MIN;
    try {
      fake.pushText(chat, chat, "approve:date");
      const card = await until(() => cardWith(chat, "date"));
      expect(card.silent).toBe(true);
      advance(5 * MIN);
      await bridge.settle();
      expect(fake.sent(chat).some((m) => m.reply_to === card.message_id)).toBe(false);
      chatControl()!.answerApproval(sessionId, chatControl()!.liveState(sessionId)!.card!.requestId, { approved: false }, "telegram");
      await idle(sessionId);
    } finally {
      quietUntil = null;
    }
  });

  it("with the switch off, sends everything with a sound and re-sends a long answer as before", async () => {
    setQuietWhileInPpm(false);
    try {
      freshStart();
      const { chat, sessionId } = await phone();
      const b = await browser(sessionId);
      const from = fake.sent(chat).length;
      b.send("slow off");
      await until(() => fake.sent(chat).some((m) => m.text.startsWith("Working on it")));
      lastInput = clockNow;
      advance(60_000);
      gates.get(sessionId)!();
      await until(() => fake.sent(chat).some((m) => m.text === "Working on it — finished."));
      await idle(sessionId);
      await bridge.settle();
      expect(sentSince(chat, from)).toEqual([["🖥 (PPM) slow off", false], ["Working on it — finished.", false]]);
      // A card with the user at PPM rings too, and nothing reminds about it.
      lastInput = clockNow;
      fake.pushText(chat, chat, "approve:whoami");
      const card = await until(() => cardWith(chat, "whoami"));
      expect(card.silent).toBe(false);
      advance(5 * MIN);
      await bridge.settle();
      expect(fake.sent(chat).some((m) => m.reply_to === card.message_id)).toBe(false);
      chatControl()!.answerApproval(sessionId, chatControl()!.liveState(sessionId)!.card!.requestId, { approved: false }, "telegram");
      await idle(sessionId);
      b.ws.close();
    } finally {
      setQuietWhileInPpm(true);
    }
  });

  it("is switched by /quiet from the phone, and says so", async () => {
    freshStart();
    const { chat } = await phone();
    fake.pushText(chat, chat, "/quiet");
    const status = await until(() => fake.sent(chat).find((m) => m.text.startsWith("🔕 Quiet while you are at PPM: on.")));
    const off = fake.buttons(chat, status.message_id).flat().find((x) => x.text === "Turn off")!;
    fake.pressButton(chat, chat, status.message_id, off.callback_data!);
    await until(() => fake.sent(chat).some((m) => m.text.startsWith("🔔 Quiet while you are at PPM: off.")));
    expect(quietWhileInPpm()).toBe(false);
    fake.pushText(chat, chat, "/quiet on");
    await until(() => quietWhileInPpm());
    expect(fake.sent(chat).filter((m) => m.text.startsWith("🔕 Quiet while you are at PPM: on."))).toHaveLength(2);
  });
});
