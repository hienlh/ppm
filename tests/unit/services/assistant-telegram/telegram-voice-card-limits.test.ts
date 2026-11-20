/**
 * The two ways a Telegram voice card could leave the user with something other than what they
 * see: a replacement too long for the card (the edit fails, the old transcript stays on screen,
 * and Send delivers the new one), and a card that expires with texts or photos gathered with it.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { TelegramVoiceMessages, type VoiceHost } from "../../../../src/services/assistant-telegram/assistant-telegram-voice.ts";
import type { VoiceBundle } from "../../../../src/services/assistant-telegram/assistant-telegram-voice-pending.ts";
import {
  VOICE_REPLACE_MAX_CHARS, VOICE_REPLACE_TOO_LONG_TEXT,
} from "../../../../src/services/assistant-telegram/assistant-telegram-voice-card.ts";
import { CODE_TTL_MS } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { TelegramMessage } from "../../../../src/services/telegram/telegram-types.ts";

const CHAT = "4242";
const CARD_ID = 77;
let now: number;
let shown: string[];
let replies: string[];
let delivered: Array<{ parts: string[]; voicePart: string | null }>;
let dropped: string[];

function harness(): TelegramVoiceMessages {
  const botClient = {
    sendMessage: async (_chat: string, html: string) => { shown.push(html); return { ok: true, result: { message_id: CARD_ID } }; },
    editMessageText: async (_chat: string, _id: number, html: string) => { shown.push(html); return { ok: true, result: true }; },
  };
  const host = {
    client: {
      getFile: async () => ({ ok: true, result: { file_path: "voice/file.oga" } }),
      downloadFile: async () => ({ ok: true, result: new Uint8Array([0x4f, 0x67, 0x67, 0x53]) }),
    },
    queue: { enqueue: (_chat: string, task: { run: (c: unknown) => Promise<unknown> }) => { void task.run(botClient); }, noteSent: () => {} },
    codes: { mint: () => "code", dropGroup: (group: string) => { dropped.push(group); } },
    deps: {
      enabled: () => true,
      reviewBeforeSend: () => true,
      process: async () => ({ raw: "deploy the hono app", text: "Deploy the Hono app.", cleaned: true, transcribeMs: 1, cleanupMs: 1 }),
      learn: async () => [],
    },
    now: () => now,
    reply: (_chat: string, html: string) => { replies.push(html); },
    onLane: (_chat: string, work: () => Promise<void>) => { void work(); },
    release: () => {},
    deliverBundle: async (_chat: string, bundle: VoiceBundle, voicePart: string | null) => { delivered.push({ parts: [...bundle.parts], voicePart }); },
    confirm: () => {},
    recentPhotoAt: () => null,
  } as unknown as VoiceHost;
  return new TelegramVoiceMessages(host);
}

const settle = () => Bun.sleep(20);
const cardShown = () => shown.some((html) => html.includes("Transcript ·"));

async function startWithText(voice: TelegramVoiceMessages): Promise<void> {
  const bundle: VoiceBundle = { updateIds: [1, 2], parts: ["see the log above"], images: [], quote: null };
  voice.start(CHAT, { message_id: 5, voice: { file_id: "f1", duration: 4 } } as unknown as TelegramMessage, bundle);
  for (let i = 0; i < 50 && !cardShown(); i++) await settle();
  expect(cardShown()).toBe(true);
}

const replyToCard = (text: string) =>
  ({ message_id: 9, text, reply_to_message: { message_id: CARD_ID } }) as unknown as TelegramMessage;

beforeEach(() => {
  now = 1_800_000_000_000;
  shown = []; replies = []; delivered = []; dropped = [];
});

describe("Telegram voice card", () => {
  it("refuses a replacement too long for the card, so the card and what Send delivers never differ", async () => {
    const voice = harness();
    await startWithText(voice);
    const before = shown.length;
    expect(voice.replace(CHAT, replyToCard("x".repeat(VOICE_REPLACE_MAX_CHARS + 1)))).toBe(true);
    await settle();
    expect(replies).toEqual([VOICE_REPLACE_TOO_LONG_TEXT]);
    expect(shown).toHaveLength(before);
    // At the limit it is taken, and the card shows it.
    expect(voice.replace(CHAT, replyToCard("y".repeat(VOICE_REPLACE_MAX_CHARS)))).toBe(true);
    await settle();
    expect(shown.at(-1)).toContain("Transcript · replaced");
  });

  it("on expiry sends what came with the voice, without it, and says the card expired", async () => {
    const voice = harness();
    await startWithText(voice);
    now += CODE_TTL_MS + 1;
    // Any later look at the pending cards ends the expired one; a press on it is no longer valid.
    expect(await voice.press(CHAT, { kind: "voice", id: "gone", send: true } as never, "voice:gone")).toBe("This button is no longer valid.");
    await settle();
    expect(delivered).toEqual([{ parts: ["see the log above"], voicePart: null }]);
    expect(shown.at(-1)).toContain("Expired");
    expect(shown.at(-1)).toContain("what came with it was sent without it");
    expect(dropped.some((group) => group.startsWith("voice:") && group !== "voice:gone")).toBe(true);
  });
});
