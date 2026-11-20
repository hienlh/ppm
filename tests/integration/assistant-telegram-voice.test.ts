/**
 * Voice messages to the PPM Assistant's bot, end to end through the real bridge: a fake Bot API
 * plays the phone, the real chat layer runs the Assistant session, a scripted provider records what
 * reached it, and a stand-in for Whisper + the clean-up answers when the test lets it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { existsSync } from "node:fs";
import { providerRegistry } from "../../src/providers/registry.ts";
import { getDb, upsertApprovedPairing } from "../../src/services/db.service.ts";
import { configService } from "../../src/services/config.service.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { AssistantTelegramBridge } from "../../src/services/assistant-telegram/assistant-telegram.service.ts";
import type { TelegramVoiceDeps, VoiceProcessInput, VoiceProcessResult } from "../../src/services/assistant-telegram/assistant-telegram-voice-deps.ts";
import { WHISPER_MISSING_TEXT } from "../../src/services/assistant-telegram/assistant-telegram-voice-card.ts";
import { getUploadsDir } from "../../src/services/chat-upload-storage.service.ts";
import { splitVoiceMessage } from "../../src/shared/voice-message.ts";
import { startFakeTelegram } from "../helpers/fake-telegram-bot-api.ts";
import type { AIProvider, ChatEvent, SendMessageOpts } from "../../src/types/chat.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

const P = "stub-telegram-voice";
const received: Array<{ sessionId: string; message: string; images: number }> = [];

providerRegistry.register({
  id: P, name: "Voice stub", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: `tgv-${crypto.randomUUID()}`, providerId: P, title: "", createdAt: new Date().toISOString() }; },
  async resumeSession(id: string) { return { id, providerId: P, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    received.push({ sessionId, message, images: opts?.images?.length ?? 0 });
    yield { type: "text", content: `Echo ${received.length}` };
    yield { type: "done", sessionId };
  },
  resolveApproval() {},
  abortQuery() {},
} as unknown as AIProvider);

// ── A stand-in for Whisper + Haiku, held at a gate until the test opens it ───────────
let enabled = true;
let review = true;
let result: VoiceProcessResult;
let failure: unknown = null;
let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};
const processed: VoiceProcessInput[] = [];
const learned: Array<{ project: string; before: string; after: string }> = [];
const holdProcessing = () => { gate = new Promise((resolve) => { openGate = resolve; }); };

const voice: TelegramVoiceDeps = {
  enabled: () => enabled,
  reviewBeforeSend: () => review,
  async process(input) {
    processed.push(input);
    await gate;
    if (failure) throw failure;
    return result;
  },
  async learn(input) {
    learned.push(input);
    return [{ word: "Hono", from: "hô nô", at: new Date().toISOString() }];
  },
};

const originalAssistant = configService.get("assistant");
const bridge = new AssistantTelegramBridge();

beforeAll(async () => {
  getDb().query("DELETE FROM config WHERE key = 'assistant_telegram_state'").run();
  configService.set("assistant", { ...originalAssistant, default_provider: P });
  // Registers chatControl(), which the bridge delivers through.
  await import("../../src/server/ws/chat.ts");
  await bridge.start({
    token: fake.token, client: { editIntervalMs: 0, sleep: async () => {} }, debounceMs: 30, pollTimeoutS: 1,
    scaleDelay: (ms: number) => ms / 1000, voice,
    sessionLink: async (providerId: string, sessionId: string) => `http://localhost:8080/assistant?session=${providerId}/${sessionId}`,
  });
});

afterAll(async () => {
  await bridge.stop();
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
  configService.set("assistant", originalAssistant);
});

beforeEach(() => {
  enabled = true;
  review = true;
  failure = null;
  gate = Promise.resolve();
  result = { raw: "deploy the hono app", text: "Deploy the Hono app.", cleaned: true, transcribeMs: 5, cleanupMs: 5 };
});

let nextChat = 8_300_000;
function phone(): number {
  const id = nextChat++;
  upsertApprovedPairing(String(id), String(id), `Phone ${id}`);
  return id;
}

const until = <T>(check: () => T | undefined | null | false, ms = 5000) => fake.waitFor(check, ms);
const byId = (chat: number, id: number) => fake.sent(chat).find((m) => m.message_id === id);
const statusOf = (chat: number) => fake.sent(chat).find((m) => [m.text, ...m.history].some((t) => t.startsWith("🎙 Voice message")));
const cardOf = async (chat: number) => until(() => fake.sent(chat).find((m) => m.text.includes("Transcript ·") && fake.buttons(chat, m.message_id).length));
const press = (chat: number, messageId: number, label: string) => {
  const button = fake.buttons(chat, messageId).flat().find((b) => b.text === label)!;
  fake.pressButton(chat, chat, messageId, button.callback_data!);
};
/** Every message the provider got since `from`, for a test that starts a fresh chat. */
const since = (from: number) => received.slice(from);

describe("voice messages on the Assistant's Telegram bot", () => {
  it("is refused as before while the feature is off", async () => {
    enabled = false;
    const chat = phone();
    fake.pushVoice(chat, chat);
    await until(() => fake.lastText(chat) === "I can read text and photos only.");
    expect(processed).toHaveLength(0);
  });

  it("shows a review card, and Send delivers one message ending with the voice part", async () => {
    const chat = phone();
    const start = received.length;
    fake.pushVoice(chat, chat, { duration: 42 });
    const card = await cardOf(chat);
    expect(card.history[0]).toBe("🎙 Voice message — transcribing…");
    expect(card.text).toContain("Transcript · cleaned");
    expect(card.html).toContain("<blockquote>Deploy the Hono app.</blockquote>");
    expect(card.text).toContain("Reply to this message with the corrected text to replace it.");
    expect(since(start)).toHaveLength(0);
    press(chat, card.message_id, "Send");
    await until(() => since(start).length === 1);
    const { before, voice: part } = splitVoiceMessage(since(start)[0]!.message);
    expect(before).toBe("");
    expect(part?.transcript).toBe("Deploy the Hono app.");
    expect(part?.durationSec).toBe(42);
    expect(part?.path.startsWith(getUploadsDir())).toBe(true);
    expect(part?.path.endsWith("-telegram-voice.ogg")).toBe(true);
    expect(existsSync(part!.path)).toBe(true);
    await until(() => byId(chat, card.message_id)?.text.startsWith("✅ Sent"));
    expect(fake.buttons(chat, card.message_id)).toEqual([]);
    expect(processed.at(-1)?.project).toBe("__assistant__");
    expect(learned).toHaveLength(0);
  });

  it("replaces the transcript with a reply to the card before Send, and learns from the edit", async () => {
    const chat = phone();
    const start = received.length;
    fake.pushVoice(chat, chat);
    const card = await cardOf(chat);
    fake.pushText(chat, chat, "Deploy the Nxsys app.", "private", {
      reply_to_message: { message_id: card.message_id, from: fake.bot, chat: { id: chat, type: "private" }, date: Math.floor(Date.now() / 1000), text: card.text },
    });
    await until(() => byId(chat, card.message_id)?.text.includes("Transcript · replaced"));
    expect(byId(chat, card.message_id)!.text).toContain("Deploy the Nxsys app.");
    expect(fake.buttons(chat, card.message_id).flat().map((b) => b.text)).toEqual(["Send", "Cancel"]);
    expect(since(start)).toHaveLength(0);
    press(chat, card.message_id, "Send");
    await until(() => since(start).length === 1);
    expect(splitVoiceMessage(since(start)[0]!.message).voice?.transcript).toBe("Deploy the Nxsys app.");
    await until(() => byId(chat, card.message_id)?.text.includes("Learned: Hono"));
    expect(learned.at(-1)).toEqual({ project: "__assistant__", before: "Deploy the Hono app.", after: "Deploy the Nxsys app." });
  });

  it("sends by itself when review is off", async () => {
    review = false;
    const chat = phone();
    const start = received.length;
    fake.pushVoice(chat, chat);
    await until(() => since(start).length === 1);
    expect(splitVoiceMessage(since(start)[0]!.message).voice?.transcript).toBe("Deploy the Hono app.");
    await until(() => statusOf(chat)?.text.startsWith("✅ Sent"));
    expect(fake.sent(chat).some((m) => m.text.includes("Transcript ·"))).toBe(false);
  });

  it("with the clean-up turned off, sends Whisper's text by itself when review is off, with no warning", async () => {
    review = false;
    result = { raw: "deploy the hono app", text: "deploy the hono app", cleaned: false, cleanupSkipped: true, transcribeMs: 5, cleanupMs: 0 };
    const chat = phone();
    const start = received.length;
    fake.pushVoice(chat, chat);
    await until(() => since(start).length === 1);
    expect(splitVoiceMessage(since(start)[0]!.message).voice?.transcript).toBe("deploy the hono app");
    expect(fake.sent(chat).some((m) => m.text.includes("raw") || m.text.includes("Could not tidy"))).toBe(false);
  });

  it("with the clean-up turned off and review on, shows a plain card, not a warning", async () => {
    review = true;
    result = { raw: "deploy the hono app", text: "deploy the hono app", cleaned: false, cleanupSkipped: true, transcribeMs: 5, cleanupMs: 0 };
    const chat = phone();
    fake.pushVoice(chat, chat);
    const card = await until(() => fake.sent(chat).find((m) => m.text.includes("Transcript") && fake.buttons(chat, m.message_id).length));
    expect(card.text).not.toContain("Transcript ·");
    expect(card.text).not.toContain("raw");
    expect(card.text).not.toContain("Could not tidy");
  });

  it("keeps the gather open while the voice is read: a photo sent meanwhile goes in the same message", async () => {
    review = false;
    holdProcessing();
    const chat = phone();
    const start = received.length;
    fake.pushVoice(chat, chat);
    await until(() => statusOf(chat));
    fake.pushPhoto(chat, chat, { caption: "this screen" });
    fake.pushText(chat, chat, "and this text");
    // Several debounces pass: nothing goes while the transcript is not ready.
    // While the voice waits, the poller asks Telegram again every 250 ms: give it two rounds.
    await Bun.sleep(600);
    expect(since(start)).toHaveLength(0);
    openGate();
    await until(() => since(start).length === 1);
    await Bun.sleep(100);
    expect(since(start)).toHaveLength(1);
    const sent = since(start)[0]!;
    expect(sent.images).toBe(1);
    const { before, voice: part } = splitVoiceMessage(sent.message);
    expect(before).toBe("this screen\n\nand this text");
    expect(part?.transcript).toBe("Deploy the Hono app.");
  });

  it("makes a voice that arrives after a photo went its follow-up, a message of its own", async () => {
    review = false;
    const chat = phone();
    const start = received.length;
    fake.pushPhoto(chat, chat, { caption: "the error" });
    await until(() => since(start).length === 1);
    fake.pushVoice(chat, chat);
    await until(() => since(start).length === 2);
    expect(since(start)[0]!.images).toBe(1);
    expect(since(start)[1]!.images).toBe(0);
    expect(splitVoiceMessage(since(start)[1]!.message)).toMatchObject({ before: "", voice: { transcript: "Deploy the Hono app." } });
    expect(statusOf(chat)!.history[0]).toContain("follow-up to the photo sent at");
  });

  it("always shows the card when the clean-up failed, even with review off", async () => {
    review = false;
    result = { raw: "deploy the hono app", text: "deploy the hono app", cleaned: false, cleanupError: "Claude is out of quota until 17:20", transcribeMs: 5, cleanupMs: 0 };
    const chat = phone();
    const start = received.length;
    fake.pushVoice(chat, chat);
    const card = await cardOf(chat);
    expect(card.text).toContain("Transcript · raw");
    expect(card.text).toContain("Claude is out of quota until 17:20");
    expect(card.text).toContain("deploy the hono app");
    await Bun.sleep(100);
    expect(since(start)).toHaveLength(0);
  });

  it("Cancel drops the voice but still sends the photo that came with it", async () => {
    holdProcessing();
    const chat = phone();
    const start = received.length;
    fake.pushVoice(chat, chat);
    await until(() => statusOf(chat));
    fake.pushPhoto(chat, chat);
    await Bun.sleep(600);
    openGate();
    const card = await cardOf(chat);
    expect(card.text).toContain("With it: 1 photo");
    const audio = processed.length;
    press(chat, card.message_id, "Cancel");
    await until(() => since(start).length === 1);
    expect(since(start)[0]!.images).toBe(1);
    expect(splitVoiceMessage(since(start)[0]!.message).voice).toBeNull();
    await until(() => byId(chat, card.message_id)?.text.startsWith("Cancelled"));
    expect(fake.buttons(chat, card.message_id)).toEqual([]);
    expect(processed).toHaveLength(audio);
  });

  it("refuses a voice message over two minutes without reading it", async () => {
    const chat = phone();
    const before = processed.length;
    fake.pushVoice(chat, chat, { duration: 150 });
    await until(() => fake.lastText(chat)?.includes("2:30"));
    expect(fake.lastText(chat)).toContain("up to 2:00");
    expect(processed).toHaveLength(before);
  });

  it("says how to install Whisper when it is missing, and sends nothing", async () => {
    failure = Object.assign(new Error("Whisper is not installed."), { code: "whisper_missing" });
    const chat = phone();
    const start = received.length;
    fake.pushVoice(chat, chat);
    await until(() => statusOf(chat)?.text.includes(WHISPER_MISSING_TEXT));
    await Bun.sleep(100);
    expect(since(start)).toHaveLength(0);
  });
});

