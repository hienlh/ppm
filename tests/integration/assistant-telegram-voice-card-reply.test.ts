/**
 * A voice message sent on Telegram as a reply to one of the PPM Assistant's cards answers that card,
 * end to end: a fake Bot API plays the phone and serves a real Ogg Opus voice note, the real bridge
 * reads it through a stand-in for Whisper, the real card actions and `forward-verbatim.ts` forward the
 * transcript, and the real chat socket layer delivers it to a scripted manager chat.
 *
 * It used to go to the Assistant instead, as an ordinary message quoting the card: the voice branch
 * of the inbound router returned before the router ever asked whether the message replied to a card.
 * Every rule of a typed reply holds for a spoken one: a decided card refuses it, a withdrawn card
 * asks "send anyway?", a card with no manager chat (the digest) sends it to the Assistant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { getDb, setSessionAssistant, setSessionMetadata, setSessionProvider, setSessionTitle, upsertApprovedPairing } from "../../src/services/db.service.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { managerChats } from "../../src/services/assistant-managers/manager-chats.service.ts";
import { patchManagerChatRow } from "../../src/services/assistant-managers/manager-chats-db.ts";
import { clearMainSessionIf, setMainSession } from "../../src/services/assistant/assistant-main-session.ts";
import { sessionCollabMcpHandler } from "../../src/services/session-collab/session-collab-endpoint.ts";
import { sessionCollabMcpTokens } from "../../src/services/session-collab/session-collab-tokens.ts";
import { setAssistantClock } from "../../src/services/assistant-wake/assistant-clock.ts";
import { assistantWakeQueue } from "../../src/services/assistant-wake/assistant-wake-queue.ts";
import { startAssistantCards, stopAssistantCards } from "../../src/services/assistant-cards/assistant-cards-startup.ts";
import { assistantCards } from "../../src/services/assistant-cards/assistant-cards.service.ts";
import { addCardTelegramRef } from "../../src/services/assistant-cards/assistant-cards-outbound-db.ts";
import { assistantTelegramBridge } from "../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { TelegramSilence } from "../../src/services/assistant-telegram/assistant-telegram-silence.ts";
import { BRIDGE_STATE_ROW } from "../../src/services/assistant-telegram/assistant-telegram-state.ts";
import { CLOSED_CARD_NOT_SENT } from "../../src/services/assistant-telegram/assistant-telegram-card-replies.ts";
import { VOICE_ANSWERS_TEXT } from "../../src/services/assistant-telegram/assistant-telegram-voice-card.ts";
import type { TelegramVoiceDeps, VoiceProcessInput, VoiceProcessResult } from "../../src/services/assistant-telegram/assistant-telegram-voice-deps.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { projectKey } from "../../src/services/project-name-for-path.ts";
import { decodeMessageBlocks } from "../../src/shared/chat-message-blocks.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import { splitVoiceMessage, VOICE_NOTE } from "../../src/shared/voice-message.ts";
import { startFakeTelegram } from "../helpers/fake-telegram-bot-api.ts";
import type { AIProvider, ChatEvent, SendMessageOpts } from "../../src/types/chat.ts";
import type { PpmConfig } from "../../src/types/config.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

/** A real Ogg Opus voice note: 4.4 s of synthesized speech, encoded by ffmpeg with libopus. */
const OGG = new Uint8Array(readFileSync(join(import.meta.dir, "../fixtures/voice/card-reply-synth.ogg")));
const TRANSCRIPT = "Go ahead with option two, but run the smoke tests first.";
const PHONE = 8_700_001;

// ── A scripted Claude for the manager chat and the Assistant: it records what reached it ──────
const received: Array<{ sessionId: string; message: string }> = [];
let original: AIProvider | undefined;
let manager = "";
let assistant = "";
const stub = {
  id: "claude", name: "Scripted Claude", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: "claude", title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: "claude", title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    received.push({ sessionId, message });
    if (opts?.clientMessageId) yield { type: "turn_started", turnId: crypto.randomUUID(), clientMessageId: opts.clientMessageId };
    yield { type: "text", content: "Noted." };
    yield { type: "done", sessionId };
  },
  hasStreamingSession() { return false; },
  pushMessage() { return false; },
  resolveApproval() {},
  abortQuery() {},
} as unknown as AIProvider;

// ── A stand-in for Whisper + the clean-up: it gets the real audio and answers with the transcript ──
let review = false;
const processed: VoiceProcessInput[] = [];
const voice: TelegramVoiceDeps = {
  enabled: () => true,
  reviewBeforeSend: () => review,
  whisperReady: () => true,
  enable: () => {},
  async process(input): Promise<VoiceProcessResult> {
    processed.push(input);
    return { raw: TRANSCRIPT, text: TRANSCRIPT, cleaned: false, cleanupSkipped: true, transcribeMs: 5, cleanupMs: 0 };
  },
  async learn() { return []; },
};

// ── Fixtures ─────────────────────────────────────────────────────────────────────
const home = process.env.PPM_HOME!;
const projectPath = join(home, "voice-reply-proj");
const app = new Hono();
app.all("/mcp", sessionCollabMcpHandler);
let projectsBefore: PpmConfig["projects"] = [];
let assistantBefore: unknown;
const clawbotBefore = configService.get("clawbot");
const clock = Date.UTC(2026, 10, 15, 2, 0, 0); // 09:00 in Asia/Saigon, outside quiet hours
let notifySpy: ReturnType<typeof spyOn>;

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

beforeAll(async () => {
  getDb().query("DELETE FROM config WHERE key = ?").run(BRIDGE_STATE_ROW);
  getDb().query("DELETE FROM clawbot_paired_chats").run();
  getDb().run("DELETE FROM assistant_cards");
  upsertApprovedPairing(String(PHONE), String(PHONE), "Phone");
  mkdirSync(projectPath, { recursive: true });
  original = providerRegistry.get("claude");
  providerRegistry.register(stub);
  const saved = configService.get("assistant");
  assistantBefore = saved === undefined ? undefined : structuredClone(saved);
  configService.set("assistant", { ...(saved as object ?? {}), quiet_hours: { enabled: true, start: "22:00", end: "07:00" }, timezone: "Asia/Saigon" } as never);
  configService.set("clawbot", { enabled: true, show_tool_calls: false, debounce_ms: 30 } as never);
  setAssistantClock({ now: () => clock, setTimer: () => () => {} });
  projectsBefore = [...configService.get("projects")];
  configService.set("projects", [...projectsBefore, { name: "voiceproj", path: projectPath }]);
  await import("../../src/server/ws/chat.ts");
  const { notificationService } = await import("../../src/services/notification.service.ts");
  notifySpy = spyOn(notificationService, "broadcast").mockImplementation(async () => {});
  manager = `c-${crypto.randomUUID()}`;
  setSessionMetadata(manager, "voiceproj", projectPath);
  setSessionProvider(manager, "claude");
  setSessionTitle(manager, "Manager");
  await managerChats.assign("voiceproj", manager, "user");
  patchManagerChatRow(projectKey(projectPath), { telegramDetail: "full" });
  assistant = `asst-${crypto.randomUUID()}`;
  setSessionMetadata(assistant, ASSISTANT_PROJECT_NAME, join(home, "assistant-work"));
  setSessionProvider(assistant, "claude");
  setSessionAssistant(assistant);
  setMainSession(assistant);
  startAssistantCards();
  await assistantTelegramBridge.start({
    token: fake.token, client: { editIntervalMs: 0, sleep: async () => {} },
    debounceMs: 30, pollTimeoutS: 1, scaleDelay: (ms) => ms / 1000, voice,
    sessionLink: async (p, id) => `https://ppm.example.com/assistant?session=${p}/${id}`,
    chatLink: async (project, p, id) => `https://ppm.example.com/project/${project}?openChat=${p}/${id}`,
    silence: new TelegramSilence({ enabled: () => true, idleMs: () => null, now: () => clock }),
  });
});

afterAll(async () => {
  await assistantTelegramBridge.stop();
  stopAssistantCards();
  assistantWakeQueue.stop();
  clearMainSessionIf(assistant);
  configService.set("assistant", (assistantBefore ?? {}) as never);
  getDb().query("DELETE FROM clawbot_paired_chats WHERE telegram_chat_id = ?").run(String(PHONE));
  configService.set("clawbot", clawbotBefore!);
  managerChats.unassign("voiceproj");
  configService.set("projects", projectsBefore);
  setAssistantClock(null);
  notifySpy?.mockRestore();
  if (original) providerRegistry.register(original);
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
});

beforeEach(() => { review = false; });

const ctl = () => chatControl()!;
const until = <T>(check: () => T | undefined | null | false, ms = 5000) => fake.waitFor(check, ms);
const idle = (id: string) => until(() => (ctl().liveState(id)?.phase ?? "idle") === "idle");
const lastWith = (part: string) => fake.sent(PHONE).findLast((m) => m.text.includes(part));
const now = () => Math.floor(Date.now() / 1000);
const voiceReplyTo = (messageId: number) =>
  fake.pushVoice(PHONE, PHONE, { bytes: OGG, duration: 4, extra: { reply_to_message: { message_id: messageId, chat: { id: PHONE, type: "private" }, date: now() } } });
const to = (sessionId: string, from: number) => received.slice(from).filter((r) => r.sessionId === sessionId);
/** What reached a chat carrying the voice message's words (an urgent card also wakes the Assistant on its own). */
const heard = (sessionId: string, from: number) => to(sessionId, from).filter((r) => r.message.includes(TRANSCRIPT));
/** A card on the phone, found by a phrase of its title. */
const cardOnPhone = (title: string) => until(() => fake.sent(PHONE).find((m) => m.text.includes(title) && !m.text.startsWith("🎙")));

describe("a voice message replying to a card on Telegram", () => {
  it("is the user's answer to a needs-decision card: its manager chat gets the transcript as a voice message in the user-words block, the Assistant gets nothing", async () => {
    const cardId = await report({ kind: "needs_decision", title: "Ship option one or option two for NX-6844?", body: "Needs your decision." });
    const card = await cardOnPhone("NX-6844");
    const from = received.length;
    const processedBefore = processed.length;
    voiceReplyTo(card.message_id);

    const ack = await until(() => lastWith("word for word"));
    await idle(manager);
    expect(ack.text).toContain("voiceproj");

    // Whisper got the real Ogg Opus bytes.
    expect(processed.length).toBe(processedBefore + 1);
    expect(Buffer.from(processed.at(-1)!.audio).equals(Buffer.from(OGG))).toBe(true);

    const toManager = to(manager, from);
    expect(toManager).toHaveLength(1);
    const blocks = decodeMessageBlocks(toManager[0]!.message);
    expect(blocks.userWords).toMatchObject({ cardId, channel: "telegram" });
    // The voice part PPM wrote: its marker, the note that the words may be misheard, the transcript.
    const { before, voice: part } = splitVoiceMessage(blocks.content);
    expect(before).toBe("");
    expect(part?.transcript).toBe(TRANSCRIPT);
    expect(part?.durationSec).toBe(4);
    expect(blocks.content).toContain(VOICE_NOTE);
    // The stored audio is the voice note itself, under PPM's uploads folder.
    expect(Buffer.from(readFileSync(part!.path)).equals(Buffer.from(OGG))).toBe(true);
    // Nothing went to the Assistant as a message of its own.
    expect(heard(assistant, from)).toHaveLength(0);

    expect(assistantCards.get(cardId)!.status).toBe("answered");
    // The status said where it goes; the note after reading does not claim "Sent".
    const status = fake.sent(PHONE).find((m) => m.history.some((t) => t.includes(VOICE_ANSWERS_TEXT)))!;
    expect(status.text.startsWith("🎙 Transcript")).toBe(true);
    expect(status.text).not.toContain("Sent");
  });

  it("answers an urgent card the same way, after the user presses Send on the review card", async () => {
    review = true;
    const cardId = await report({ kind: "urgent", title: "Deploy blocked on NX-6845", body: "Needs you now." });
    const card = await cardOnPhone("NX-6845");
    const from = received.length;
    voiceReplyTo(card.message_id);
    const reviewCard = await until(() => fake.sent(PHONE).find((m) => m.text.includes("Transcript") && fake.buttons(PHONE, m.message_id).length));
    expect(to(manager, from)).toHaveLength(0);
    const send = fake.buttons(PHONE, reviewCard.message_id).flat().find((b) => b.text === "Send")!;
    fake.pressButton(PHONE, PHONE, reviewCard.message_id, send.callback_data!);
    await until(() => to(manager, from).length > 0);
    await idle(manager);
    const blocks = decodeMessageBlocks(to(manager, from)[0]!.message);
    expect(blocks.userWords?.cardId).toBe(cardId);
    expect(splitVoiceMessage(blocks.content).voice?.transcript).toBe(TRANSCRIPT);
    expect(heard(assistant, from)).toHaveLength(0);
  });

  it("is refused by a card already decided, exactly as typed words are", async () => {
    const cardId = await report({ kind: "needs_decision", title: "Rename the NX-6846 setting?", body: "Needs your decision." });
    const card = await cardOnPhone("NX-6846");
    expect(assistantCards.transition(cardId, "answered", { by: "user", channel: "ppm", at: clock, ok: true }).ok).toBe(true);
    const from = received.length;
    const sentBefore = fake.sent(PHONE).length;
    voiceReplyTo(card.message_id);
    await until(() => fake.sent(PHONE).slice(sentBefore).find((m) => m.text.includes(CLOSED_CARD_NOT_SENT)));
    await assistantTelegramBridge.settle();
    expect(to(manager, from)).toHaveLength(0);
    expect(heard(assistant, from)).toHaveLength(0);
  });

  it("asks before answering a withdrawn card, and Send anyway forwards the voice", async () => {
    const cardId = await report({ kind: "needs_decision", title: "Pick a date for NX-6847", body: "Needs your decision." });
    const card = await cardOnPhone("NX-6847");
    expect(assistantCards.transition(cardId, "dismissed", {
      by: "manager", channel: "chat", at: clock, withdrawn: { sessionId: manager, reason: "Settled in another card" },
    }).ok).toBe(true);
    const from = received.length;
    const sentBefore = fake.sent(PHONE).length;
    voiceReplyTo(card.message_id);
    const question = await until(() => fake.sent(PHONE).slice(sentBefore).find((m) => fake.buttons(PHONE, m.message_id).flat().some((b) => b.text === "Send anyway")));
    expect(to(manager, from)).toHaveLength(0);
    const anyway = fake.buttons(PHONE, question.message_id).flat().find((b) => b.text === "Send anyway")!;
    fake.pressButton(PHONE, PHONE, question.message_id, anyway.callback_data!);
    await until(() => to(manager, from).length > 0);
    await idle(manager);
    const blocks = decodeMessageBlocks(to(manager, from)[0]!.message);
    expect(blocks.userWords?.cardId).toBe(cardId);
    expect(splitVoiceMessage(blocks.content).voice?.transcript).toBe(TRANSCRIPT);
    expect(heard(assistant, from)).toHaveLength(0);
  });

  it("goes to the Assistant as a voice message when the card has no manager chat (the morning digest)", async () => {
    const digest = assistantCards.create({ kind: "digest", projectName: null, projectPath: null, sessionId: null, title: "Morning digest", body: "Nothing urgent." });
    // The digest's message on the phone, as the outbound side records a card it sent.
    const messageId = 9_900_001;
    addCardTelegramRef(digest.id, { chatId: String(PHONE), messageId });
    const from = received.length;
    voiceReplyTo(messageId);
    await until(() => heard(assistant, from).length > 0);
    await idle(assistant);
    const text = decodeMessageBlocks(heard(assistant, from)[0]!.message).content;
    expect(text.startsWith("(My reply to the morning digest card.)")).toBe(true);
    expect(splitVoiceMessage(text).voice?.transcript).toBe(TRANSCRIPT);
    expect(to(manager, from)).toHaveLength(0);
  });

  it("still goes to the Assistant when it replies to a message that is no card", async () => {
    const from = received.length;
    voiceReplyTo(9_900_777);
    await until(() => heard(assistant, from).length > 0);
    await idle(assistant);
    const blocks = decodeMessageBlocks(heard(assistant, from)[0]!.message);
    expect(splitVoiceMessage(blocks.content).voice?.transcript).toBe(TRANSCRIPT);
    expect(to(manager, from)).toHaveLength(0);
  });
});
