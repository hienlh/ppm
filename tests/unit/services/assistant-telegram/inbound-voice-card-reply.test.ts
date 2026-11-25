/**
 * The router sends a voice message's transcript where typed words to the same message would go:
 * a question card that takes words, one of the Assistant's cards, a task's chat; the Assistant only
 * when none of them takes it. The audio is a real Ogg Opus voice note, fetched from the fake Bot API.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clientFor, connectChat, freshChat, queueFor, texts, useFakeTelegram } from "./bridge-test-kit.ts";
import { AssistantTelegramInbound } from "../../../../src/services/assistant-telegram/assistant-telegram-inbound.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import type { CardReplyMessage } from "../../../../src/services/assistant-telegram/assistant-telegram-card-replies.ts";
import type { TaskWordsMessage } from "../../../../src/services/assistant-telegram/assistant-telegram-task-message.ts";
import type { TypedAnswerMessage } from "../../../../src/services/assistant-telegram/assistant-telegram-typed-answers.ts";
import type { TelegramVoiceDeps } from "../../../../src/services/assistant-telegram/assistant-telegram-voice-deps.ts";
import { VOICE_ANSWERS_TEXT, VOICE_FORWARDED_TEXT } from "../../../../src/services/assistant-telegram/assistant-telegram-voice-card.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
const OGG = new Uint8Array(readFileSync(join(import.meta.dir, "../../../fixtures/voice/card-reply-synth.ogg")));
const TRANSCRIPT = "Go ahead with option two, but run the smoke tests first.";

let reviewFirst = false;
const voiceDeps = (heard: Uint8Array[]): TelegramVoiceDeps => ({
  enabled: () => true, reviewBeforeSend: () => reviewFirst, whisperReady: () => true, enable: () => {},
  async process(input) {
    heard.push(input.audio);
    return { raw: TRANSCRIPT, text: TRANSCRIPT, cleaned: false, cleanupSkipped: true, transcribeMs: 1, cleanupMs: 0 };
  },
  async learn() { return []; },
});

interface Probes {
  cardMessage?: (replyTo: number) => boolean;
  wantsTyped?: (replyTo?: number) => boolean;
  typed?: (m: TypedAnswerMessage) => string | null;
  replyToCard?: (m: CardReplyMessage) => boolean;
  taskAim?: (replyTo?: number) => { taskId: string; to: "working" } | null;
}

function router(p: Probes) {
  const calls = { typed: [] as TypedAnswerMessage[], cards: [] as CardReplyMessage[], tasks: [] as TaskWordsMessage[], heard: [] as Uint8Array[] };
  const queue = queueFor(client);
  const r = new AssistantTelegramInbound({
    client, token: fake.token, queue, codes: new ButtonCodes<BridgeAction>(),
    debounceMs: () => 0, delivered: () => {}, pressCard: () => "", switchSession: () => "", relayCard: () => {},
    typedAnswer: (_c, m) => { calls.typed.push(m); return p.typed?.(m) ?? null; },
    wantsTypedAnswer: (_c, replyTo) => p.wantsTyped?.(replyTo) ?? false,
    isCardMessage: (_c, id) => p.cardMessage?.(id) ?? false,
    replyToCard: async (_c, m) => { calls.cards.push(m); return p.replyToCard?.(m) ?? true; },
    taskWords: {
      wants: (_c, replyTo) => p.taskAim?.(replyTo) ?? null,
      take: async (_c, m) => { calls.tasks.push(m); },
    },
    voice: voiceDeps(calls.heard),
  });
  return { r, calls, queue };
}

const now = () => Math.floor(Date.now() / 1000);
const replyExtra = (chat: number, messageId: number) => ({ reply_to_message: { message_id: messageId, chat: { id: chat, type: "private" }, date: now() } });

async function voiceTo(r: AssistantTelegramInbound, queue: ReturnType<typeof queueFor>, chat: number, extra: Record<string, unknown> = {}) {
  r.dispatch(fake.pushVoice(chat, chat, { bytes: OGG, duration: 4, extra }));
  await r.settle();
  await queue.whenIdle();
}

describe("a voice message that answers a card, in the router", () => {
  it("answers one of the Assistant's cards with its transcript and the stored audio", async () => {
    const chat = Number(connectChat(freshChat()));
    const { r, calls, queue } = router({ cardMessage: (id) => id === 41 });
    await voiceTo(r, queue, chat, replyExtra(chat, 41));
    expect(calls.cards).toHaveLength(1);
    const card = calls.cards[0]!;
    expect(card).toMatchObject({ text: TRANSCRIPT, replyToMessageId: 41, notTheUsers: false });
    expect(card.voice?.durationSec).toBe(4);
    // The audio stored for the message is the voice note Telegram handed over, byte for byte.
    expect(Buffer.from(readFileSync(card.voice!.path)).equals(Buffer.from(OGG))).toBe(true);
    expect(Buffer.from(calls.heard[0]!).equals(Buffer.from(OGG))).toBe(true);
    // A question card is asked first, with the transcript, as for typed words.
    expect(calls.typed).toEqual([{ text: TRANSCRIPT, replyToMessageId: 41, notTheUsers: false, hasPhoto: false }]);
    const status = fake.sent(chat).find((m) => m.history.some((t) => t.includes(VOICE_ANSWERS_TEXT)));
    expect(status?.text.startsWith("🎙 Transcript")).toBe(true);
  });

  it("answers a question card that takes words, and goes nowhere else", async () => {
    const chat = Number(connectChat(freshChat()));
    const { r, calls, queue } = router({ wantsTyped: (to) => to === 52, typed: (m) => `✅ Answer sent: <b>${m.text}</b>` });
    await voiceTo(r, queue, chat, replyExtra(chat, 52));
    expect(calls.typed).toEqual([{ text: TRANSCRIPT, replyToMessageId: 52, notTheUsers: false, hasPhoto: false }]);
    expect(calls.cards).toEqual([]);
    expect(texts(fake, chat)).toContain(`✅ Answer sent: ${TRANSCRIPT}`);
  });

  it("answers the question ✏️ Other was pressed on, with no reply at all", async () => {
    const chat = Number(connectChat(freshChat()));
    const { r, calls, queue } = router({ wantsTyped: (to) => to === undefined, typed: () => "✅ Answer sent" });
    await voiceTo(r, queue, chat);
    expect(calls.typed).toEqual([{ text: TRANSCRIPT, notTheUsers: false, hasPhoto: false }]);
  });

  it("goes to the task's chat when it replies to a task card", async () => {
    const chat = Number(connectChat(freshChat()));
    const { r, calls, queue } = router({ taskAim: (to) => (to === 63 ? { taskId: "t-1", to: "working" } : null) });
    await voiceTo(r, queue, chat, replyExtra(chat, 63));
    expect(calls.tasks).toHaveLength(1);
    expect(calls.tasks[0]).toMatchObject({ text: TRANSCRIPT, replyToMessageId: 63, notTheUsers: false, hasPhoto: false });
    expect(existsSync(calls.tasks[0]!.voice!.path)).toBe(true);
  });

  it("tries the next place typed words would go when the card it was read for no longer takes it", async () => {
    const chat = Number(connectChat(freshChat()));
    // The Assistant, last in line, is not reached here: this test runs no chat service.
    const { r, calls, queue } = router({ cardMessage: () => true, replyToCard: () => false, taskAim: () => ({ taskId: "t-2", to: "working" }) });
    await voiceTo(r, queue, chat, replyExtra(chat, 74));
    expect(calls.cards).toHaveLength(1);
    expect(calls.tasks).toHaveLength(1);
    expect(calls.tasks[0]!.text).toBe(TRANSCRIPT);
  });

  it("is not a card's answer when it replies to anything else: no card path is asked to take it", async () => {
    const chat = Number(connectChat(freshChat()));
    const { r, calls, queue } = router({});
    // Read and held for review, so it never reaches the Assistant (no chat service runs here).
    reviewFirst = true;
    try { await voiceTo(r, queue, chat, replyExtra(chat, 85)); } finally { reviewFirst = false; }
    expect(calls.typed).toEqual([]);
    expect(calls.cards).toEqual([]);
    expect(calls.tasks).toEqual([]);
    expect(texts(fake, chat).some((t) => t.includes(VOICE_ANSWERS_TEXT))).toBe(false);
  });

  it("refuses a forwarded voice message before reading it, card or not", async () => {
    const chat = Number(connectChat(freshChat()));
    const { r, calls, queue } = router({ cardMessage: () => true });
    await voiceTo(r, queue, chat, { ...replyExtra(chat, 96), forward_origin: { type: "user", date: now(), sender_user: { id: 5, is_bot: false, first_name: "Other" } } });
    expect(calls.heard).toEqual([]);
    expect(calls.cards).toEqual([]);
    expect(fake.lastText(chat)).toBe(VOICE_FORWARDED_TEXT);
  });
});
