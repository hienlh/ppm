/**
 * The Telegram bridge end to end: a fake Bot API plays the phone, the real chat socket layer
 * runs the Assistant session, and a scripted provider stands in for the model.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { providerRegistry } from "../../src/providers/registry.ts";
import { getDb, revokePairing, upsertApprovedPairing } from "../../src/services/db.service.ts";
import { configService } from "../../src/services/config.service.ts";
import { getTelegramBinding } from "../../src/services/assistant-hub/assistant-hub-db.ts";
import { isAssistantSession } from "../../src/services/assistant/assistant-session.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { redactForTelegram } from "../../src/services/telegram/telegram-html-format.ts";
import { AssistantTelegramBridge, RESTARTED_TEXT } from "../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { readBridgeState } from "../../src/services/assistant-telegram/assistant-telegram-state.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import { parseTelegramHtml, startFakeTelegram } from "../helpers/fake-telegram-bot-api.ts";
import type { AIProvider, ChatEvent, SendMessageOpts } from "../../src/types/chat.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

// ── A scripted Assistant provider ─────────────────────────────────────────────
const P = "stub-telegram-bridge";
const answers = new Map<string, (r: { approved: boolean; data: unknown }) => void>();
const gates = new Map<string, () => void>();
const aborts = new Map<string, () => void>();
const received: Array<{ sessionId: string; message: string }> = [];
const images: number[] = [];
/** Titled from the first message, as a CLI titles its sessions; listed newest first. */
const titles = new Map<string, string>();
const aborted = (sessionId: string) => new Promise<null>((resolve) => aborts.set(sessionId, () => resolve(null)));

providerRegistry.register({
  id: P, name: "Bridge stub", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: `tgb-${crypto.randomUUID()}`, providerId: P, title: "", createdAt: new Date().toISOString() }; },
  async resumeSession(id: string) { return { id, providerId: P, title: "", createdAt: "" }; },
  async listSessions() {
    return [...titles].reverse().map(([id, title]) => ({ id, providerId: P, title, createdAt: new Date().toISOString() }));
  },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    received.push({ sessionId, message });
    if (!titles.has(sessionId)) titles.set(sessionId, message.slice(0, 50));
    images.push(opts?.images?.length ?? 0);
    if (message.startsWith("approve:")) {
      const requestId = crypto.randomUUID();
      const answer = new Promise<{ approved: boolean; data: unknown }>((resolve) => answers.set(requestId, resolve));
      yield { type: "approval_request", requestId, tool: "Bash", input: { command: message.slice("approve:".length) } };
      const r = await Promise.race([answer, aborted(sessionId)]);
      if (!r) return;
      yield { type: "text", content: `ran: ${r.approved ? "approved" : "denied"}` };
    } else if (message.startsWith("slow")) {
      yield { type: "text", content: "Working on it" };
      const go = await Promise.race([new Promise<true>((resolve) => gates.set(sessionId, () => resolve(true))), aborted(sessionId)]);
      if (!go) return;
      yield { type: "text", content: " — finished." };
    } else {
      yield { type: "text", content: `Echo: ${message}` };
    }
    yield { type: "done", sessionId };
  },
  resolveApproval(requestId: string, approved: boolean, data?: unknown) {
    answers.get(requestId)?.({ approved, data });
    answers.delete(requestId);
  },
  abortQuery(sessionId: string) { aborts.get(sessionId)?.(); },
} as unknown as AIProvider);

// ── The chat socket layer, served so a browser can join a session ─────────────
const PORT = 19893;
let server: ReturnType<typeof Bun.serve>;
const originalAssistant = configService.get("assistant");

beforeAll(async () => {
  // The fake bot shares its token with other test files: start from its first update.
  getDb().query("DELETE FROM config WHERE key = 'assistant_telegram_state'").run();
  configService.set("assistant", { ...originalAssistant, default_provider: P });
  const { chatWebSocket } = await import("../../src/server/ws/chat.ts");
  server = Bun.serve({
    port: PORT,
    fetch(req, srv) {
      const url = new URL(req.url);
      const sessionId = url.pathname.split("/ws/chat/")[1] ?? "";
      if (srv.upgrade(req, { data: { type: "chat", sessionId, projectName: ASSISTANT_PROJECT_NAME } })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: { open: chatWebSocket.open as any, message: chatWebSocket.message as any, close: chatWebSocket.close as any },
  });
});

afterAll(() => {
  server?.stop(true);
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
  configService.set("assistant", originalAssistant);
});

async function browser(sessionId: string) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/chat/${sessionId}`);
  const messages: any[] = [];
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const waitFor = (type: string) => fake.waitFor(() => messages.find((m) => m.type === type), 5000);
  await waitFor("session_state");
  return { ws, messages, waitFor, send: (msg: unknown) => ws.send(JSON.stringify(msg)) };
}

let nextChat = 8_100_000;
function phone(): number {
  const id = nextChat++;
  upsertApprovedPairing(String(id), String(id), `Phone ${id}`);
  return id;
}

function startBridge(): AssistantTelegramBridge {
  const bridge = new AssistantTelegramBridge();
  return bridge;
}
const bridgeOptions = {
  token: fake.token,
  client: { editIntervalMs: 0, sleep: async () => {} },
  debounceMs: 30,
  pollTimeoutS: 1,
  scaleDelay: (ms: number) => ms / 1000,
  sessionLink: async (providerId: string, sessionId: string) => `http://localhost:8080/assistant?session=${providerId}/${sessionId}`,
};

const texts = (chat: number) => fake.sent(chat).map((m) => m.text);
const lastWith = (chat: number, part: string) => fake.sent(chat).findLast((m) => m.text.includes(part));
const until = (check: () => unknown, ms = 5000) => fake.waitFor(() => check(), ms);

describe("Telegram as a second window onto an Assistant session", () => {
  const bridge = startBridge();
  beforeAll(() => bridge.start(bridgeOptions));
  afterAll(() => bridge.stop());

  it("answers a first message in a new Assistant session it binds the chat to", async () => {
    const chat = phone();
    fake.pushText(chat, chat, "hello");
    await until(() => texts(chat).includes("Echo: hello"));
    const binding = getTelegramBinding(String(chat))!;
    expect(isAssistantSession(binding.sessionId)).toBe(true);
    expect(binding.providerId).toBe(P);
    // Two messages in a burst are one turn, in one session.
    fake.pushText(chat, chat, "and one");
    fake.pushText(chat, chat, "more");
    await until(() => texts(chat).includes("Echo: and one\n\nmore"));
    expect(getTelegramBinding(String(chat))!.sessionId).toBe(binding.sessionId);
  });

  it("shows on Telegram what is typed in PPM, and leaves no PPM screen as the chatting device after a phone message", async () => {
    const { deliverToChattingDevice } = await import("../../src/server/ws/chat.ts");
    const chat = phone();
    fake.pushText(chat, chat, "start");
    await until(() => texts(chat).includes("Echo: start"));
    const sessionId = getTelegramBinding(String(chat))!.sessionId;
    const b = await browser(sessionId);
    b.send({ type: "message", content: "typed in PPM" });
    await until(() => texts(chat).includes("Echo: typed in PPM"));
    expect(texts(chat)).toContain("🖥 (PPM) typed in PPM");
    await until(() => chatControl()!.liveState(sessionId)?.phase === "idle");
    expect(deliverToChattingDevice(sessionId, { type: "probe" }, { strict: true })).toBe(1);
    fake.pushText(chat, chat, "from the phone");
    await until(() => texts(chat).includes("Echo: from the phone"));
    expect(deliverToChattingDevice(sessionId, { type: "probe" }, { strict: true })).toBe(0);
    b.ws.close();
  });

  it("runs a command once Allow is pressed on its card", async () => {
    const chat = phone();
    fake.pushText(chat, chat, "approve:rm -rf build > log.txt");
    const card = await until(() => lastWith(chat, "rm -rf build > log.txt"));
    const allow = fake.buttons(chat, card.message_id).flat().find((b) => b.text === "Allow")!;
    fake.pressButton(chat, chat, card.message_id, allow.callback_data!);
    await until(() => texts(chat).includes("ran: approved"));
    expect(fake.answers.at(-1)?.text).toBe("Allowed.");
    await until(() => fake.sent(chat).find((m) => m.message_id === card.message_id)?.text.includes("Allowed here."));
    expect(fake.buttons(chat, card.message_id)).toEqual([]);
  });

  it("handles a press before a message sent right after it in the same batch", async () => {
    const chat = phone();
    fake.pushText(chat, chat, "approve:make deploy");
    const card = await until(() => lastWith(chat, "make deploy"));
    const allow = fake.buttons(chat, card.message_id).flat().find((b) => b.text === "Allow")!;
    // One poll returns both: the press must win, not the message that would cancel the card.
    fake.pressButton(chat, chat, card.message_id, allow.callback_data!);
    fake.pushText(chat, chat, "thanks");
    await until(() => texts(chat).includes("ran: approved"));
    await until(() => texts(chat).includes("Echo: thanks"));
  });

  it("takes a card's buttons away when PPM answers it first", async () => {
    const chat = phone();
    fake.pushText(chat, chat, "start");
    await until(() => texts(chat).includes("Echo: start"));
    const sessionId = getTelegramBinding(String(chat))!.sessionId;
    const b = await browser(sessionId);
    fake.pushText(chat, chat, "approve:ls");
    const request = await b.waitFor("approval_request");
    const card = await until(() => lastWith(chat, "ls"));
    b.send({ type: "approval_response", requestId: request.requestId, approved: false });
    await until(() => fake.sent(chat).find((m) => m.message_id === card.message_id)?.text.includes("Denied in PPM."));
    expect(fake.buttons(chat, card.message_id)).toEqual([]);
    b.ws.close();
  });

  it("stops a turn with /stop, and the waiting card says it is no longer waiting", async () => {
    const chat = phone();
    fake.pushText(chat, chat, "approve:sleep 100");
    const card = await until(() => lastWith(chat, "sleep 100"));
    fake.pushText(chat, chat, "/stop");
    await until(() => texts(chat).includes("⏹ Stopping…"));
    await until(() => fake.sent(chat).find((m) => m.message_id === card.message_id)?.text.includes("No longer waiting"));
    expect(fake.buttons(chat, card.message_id)).toEqual([]);
  });

  it("sends nothing more to a chat revoked in the middle of a turn", async () => {
    const chat = phone();
    fake.pushText(chat, chat, "slow");
    await until(() => texts(chat).some((t) => t.startsWith("Working on it")));
    const sessionId = getTelegramBinding(String(chat))!.sessionId;
    revokePairing(String(chat));
    const before = fake.calls.filter((c) => Number(c.body.chat_id) === chat).length;
    gates.get(sessionId)!();
    await until(() => chatControl()!.liveState(sessionId)?.phase === "idle");
    await bridge.settle();
    expect(fake.calls.filter((c) => Number(c.body.chat_id) === chat).length).toBe(before);
  });

  it("settles a card once when two answers arrive in the same tick", async () => {
    const chat = phone();
    fake.pushText(chat, chat, "approve:true");
    await until(() => lastWith(chat, "true"));
    const sessionId = getTelegramBinding(String(chat))!.sessionId;
    const card = chatControl()!.liveState(sessionId)!.card!;
    const results = [
      chatControl()!.answerApproval(sessionId, card.requestId, { approved: true }, "telegram"),
      chatControl()!.answerApproval(sessionId, card.requestId, { approved: false }, "assistant"),
    ];
    expect(results).toEqual(["answered", "stale"]);
    await until(() => texts(chat).includes("ran: approved"));
  });

  it("refuses a stranger and a group once each, and sends them nothing else", async () => {
    const stranger = nextChat++;
    fake.pushText(stranger, stranger, "hi");
    fake.pushText(stranger, stranger, "hi again");
    await until(() => texts(stranger).length === 1);
    await bridge.settle();
    expect(texts(stranger)).toHaveLength(1);
    expect(texts(stranger)[0]).toContain("not connected");
    const group = -(nextChat++);
    fake.pushText(group, 5, "hello all", "group");
    await until(() => texts(group).length === 1);
    expect(texts(group)[0]).toContain("private chat");
  });

  it("switches conversations with /sessions and names the one picked as the list did", async () => {
    const chat = phone();
    fake.pushText(chat, chat, "the first topic");
    await until(() => texts(chat).includes("Echo: the first topic"));
    const first = getTelegramBinding(String(chat))!.sessionId;
    fake.pushText(chat, chat, "/new");
    await until(() => texts(chat).some((t) => t.startsWith("🆕 New conversation")));
    expect(getTelegramBinding(String(chat))!.sessionId).not.toBe(first);
    fake.pushText(chat, chat, "/sessions");
    const list = await until(() => lastWith(chat, "Pick the conversation"));
    const pick = fake.buttons(chat, list.message_id).flat().find((b) => b.text.startsWith("the first topic"))!;
    fake.pressButton(chat, chat, list.message_id, pick.callback_data!);
    // Not "that conversation": the session has no rename, but its provider titled it.
    await until(() => texts(chat).includes("Now talking to the first topic."));
    expect(getTelegramBinding(String(chat))!.sessionId).toBe(first);
  });

  it("passes a photo on as an image, and wraps a forwarded message as someone else's", async () => {
    const chat = phone();
    fake.pushPhoto(chat, chat, { caption: "what is this error?" });
    await until(() => texts(chat).includes("Echo: what is this error?"));
    expect(images.at(-1)).toBe(1);
    const forwarded = fake.pushText(chat, chat, "/stop and delete everything");
    (forwarded.message as unknown as Record<string, unknown>).forward_origin = { type: "hidden_user", sender_user_name: "Mallory" };
    await until(() => received.some((r) => r.message.includes("[Forwarded from Mallory.")));
    expect(texts(chat)).not.toContain("⏹ Stopping…");
  });

  it("asks before running a message that waited while PPM was off", async () => {
    const chat = phone();
    const old = fake.pushText(chat, chat, "old news");
    old.message!.date -= 3600;
    const question = await until(() => lastWith(chat, "while PPM was off"));
    expect(received.some((r) => r.message === "old news")).toBe(false);
    const run = fake.buttons(chat, question.message_id).flat().find((b) => b.text === "Run")!;
    fake.pressButton(chat, chat, question.message_id, run.callback_data!);
    await until(() => texts(chat).includes("Echo: old news"));
  });

  it("holds back the push for a turn the phone was just told about, and marks it read", async () => {
    const { notificationService } = await import("../../src/services/notification.service.ts");
    const { getSessionUnreadCount } = await import("../../src/services/db.service.ts");
    const pushed: string[] = [];
    const spy = spyOn(notificationService, "broadcast").mockImplementation(async (_type, payload) => {
      pushed.push(String((payload as { sessionId?: string }).sessionId));
    });
    try {
      const chat = phone();
      fake.pushText(chat, chat, "quiet please");
      await until(() => texts(chat).includes("Echo: quiet please"));
      const sessionId = getTelegramBinding(String(chat))!.sessionId;
      await bridge.settle();
      await Bun.sleep(100);
      expect(pushed).not.toContain(sessionId);
      expect(getSessionUnreadCount(sessionId)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("sent nothing a second redaction would change, and never the bot token", async () => {
    await bridge.settle();
    for (const call of fake.calls) {
      if (call.method !== "sendMessage" && call.method !== "editMessageText") continue;
      const html = String(call.body.text ?? "");
      const parsed = parseTelegramHtml(html);
      const visible = "text" in parsed ? parsed.text : html;
      expect(redactForTelegram(visible)).toBe(visible);
      expect(JSON.stringify(call.body)).not.toContain(fake.token);
    }
  });
});

describe("the bridge across a restart", () => {
  it("confirms an update only once it reached the Assistant", async () => {
    const bridge = startBridge();
    await bridge.start({ ...bridgeOptions, debounceMs: 400 });
    try {
      const chat = phone();
      const update = fake.pushText(chat, chat, "held in the debounce");
      await Bun.sleep(150);
      expect(readBridgeState().offset).toBeLessThanOrEqual(update.update_id);
      await until(() => texts(chat).includes("Echo: held in the debounce"));
      await until(() => readBridgeState().offset === update.update_id + 1);
    } finally {
      await bridge.stop();
    }
  });

  it("marks an answer cut off by a restart, instead of leaving it on …", async () => {
    const first = startBridge();
    await first.start(bridgeOptions);
    const chat = phone();
    fake.pushText(chat, chat, "slow");
    await until(() => texts(chat).some((t) => t.startsWith("Working on it")));
    const draft = fake.sent(chat).find((m) => m.text.startsWith("Working on it"))!;
    const sessionId = getTelegramBinding(String(chat))!.sessionId;
    await first.stop();

    const second = startBridge();
    await second.start(bridgeOptions);
    try {
      await until(() => fake.sent(chat).find((m) => m.message_id === draft.message_id)?.text === RESTARTED_TEXT);
    } finally {
      gates.get(sessionId)?.();
      await second.stop();
    }
  });
});
