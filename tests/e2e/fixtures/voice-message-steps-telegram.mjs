// Scenario E of the voice-message e2e: voice messages to the PPM Assistant's Telegram bot, through the
// real bridge and the fake Bot API (tests/e2e/fixtures/fake-telegram-server.ts). The fake plays the
// phone; the fixture's scripted provider records what the Assistant session received. API-level
// checks only: the review card is found and pressed through the Bot API the bridge calls.
import assert from "node:assert/strict";
import { until } from "./voice-message-helpers.mjs";

/** The private chat the fixture connected (its chat id is its user id). */
export const TG_CHAT = 777;
const CLEANED = "OK, giờ em sửa cái hô nô middleware cho Bun.serve đi.";
const VOICE_MARKER = /\[Voice message \(\d+:\d{2}\), transcribed below; the audio needs no opening: /;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runTelegramScenario(ctx) {
  const { kit, install, control, ogg } = ctx;
  const post = (path, body) => fetch(control + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => { const j = await r.json(); assert.ok(r.ok, `${path}: ${JSON.stringify(j)}`); return j; });
  const chatView = async () => (await (await fetch(`${control}/chat?id=${TG_CHAT}`)).json()).sent;
  const turns = async () => (await install.turns());
  const hasSend = (m) => m.reply_markup?.inline_keyboard?.flat().some((b) => b.text === "Send");

  /** The next review card the bot shows (one whose message id was not seen before). */
  async function waitForCard(seen) {
    return until("a review card with Send", async () => {
      const cards = (await chatView()).filter((m) => hasSend(m) && !seen.has(m.message_id));
      return cards.length ? cards[cards.length - 1] : null;
    }, 60000, 200);
  }
  async function pressSend(card) {
    const button = card.reply_markup.inline_keyboard.flat().find((b) => b.text === "Send");
    await post("/press", { chatId: TG_CHAT, userId: TG_CHAT, messageId: card.message_id, data: button.callback_data });
  }
  const cardIds = async () => new Set((await chatView()).filter(hasSend).map((m) => m.message_id));

  /** What the bot showed and what it called, for a failure's message: the bridge's own words are the evidence. */
  async function diagnose() {
    const bot = (await chatView()).map((m) => (m.text ?? "").replace(/\s+/g, " ").slice(0, 140));
    const calls = await (await fetch(`${control}/calls?from=0`)).json().catch(() => ({ calls: [] }));
    const failed = (calls.calls ?? []).filter((c) => c.failed).map((c) => `${c.method}: ${c.failed}`).slice(-5);
    return JSON.stringify({ botMessages: bot.slice(-6), failedCalls: failed });
  }
  /** Runs one step; a failure is rethrown with the bot's evidence attached. */
  async function step(label, fn) {
    try {
      return await fn();
    } catch (e) {
      throw new Error(`${label}: ${e.message}\n  evidence: ${await diagnose()}`);
    }
  }
  const scenario = (label, fn) => kit.scenario(label, () => step(label, fn));

  await scenario("E1 voice, then a photo while it is being transcribed: one message, review on", async () => {
    const before = (await turns()).length;
    const seen = await cardIds();
    await post("/voice", { chatId: TG_CHAT, userId: TG_CHAT, duration: 2, mime: "audio/ogg", bytesBase64: ogg });
    // While Whisper is still running (its stand-in sleeps 2 s), the photo joins the voice's bundle.
    await post("/photo", { chatId: TG_CHAT, userId: TG_CHAT, caption: "Màn hình lỗi đây" });
    const card = await waitForCard(seen);
    await pressSend(card);
    await until("the message reached the Assistant", async () => (await turns()).length > before, 60000);
    await sleep(3000);
    const sent = (await turns()).slice(before);
    assert.equal(sent.length, 1, `ONE message to the Assistant, got ${sent.length}: ${JSON.stringify(sent.map((s) => s.message.slice(0, 80)))}`);
    const message = sent[0].message;
    assert.ok(message.includes("Màn hình lỗi đây"), "the photo's caption is in the message");
    assert.ok(message.includes("[Attached image") || sent[0].images > 0, "the photo is in the message");
    assert.match(message, VOICE_MARKER);
    assert.ok(message.indexOf("Màn hình lỗi đây") < message.search(VOICE_MARKER), "the voice marker comes after the caption");
    assert.ok(message.endsWith(CLEANED), `the transcript is last: ${JSON.stringify(message.slice(-100))}`);
    kit.record("E1: the Assistant received one message with the photo, its caption, then the voice marker and transcript");
  });

  await scenario("E2 a photo sent alone first, then a voice: two messages", async () => {
    const before = (await turns()).length;
    await post("/photo", { chatId: TG_CHAT, userId: TG_CHAT, caption: "Thêm ảnh nữa" });
    await until("the photo reached the Assistant on its own", async () => (await turns()).length > before, 60000);
    // Past the gather debounce (300 ms in this fixture): the photo has gone and the voice is a follow-up.
    await sleep(2500);
    const midway = (await turns()).length;
    const seen = await cardIds();
    await post("/voice", { chatId: TG_CHAT, userId: TG_CHAT, duration: 2, mime: "audio/ogg", bytesBase64: ogg });
    const card = await waitForCard(seen);
    await pressSend(card);
    await until("the voice reached the Assistant", async () => (await turns()).length > midway, 60000);
    await sleep(2000);
    const sent = (await turns()).slice(before);
    assert.equal(sent.length, 2, `the photo message and the voice message, got ${sent.length}`);
    assert.ok(!VOICE_MARKER.test(sent[0].message), "the photo went without a voice marker");
    assert.ok(sent[0].message.includes("Thêm ảnh nữa"), "the photo's caption went with the photo");
    assert.match(sent[1].message, VOICE_MARKER);
    assert.ok(!sent[1].message.includes("Thêm ảnh nữa"), "the voice message does not repeat the photo's caption");
    assert.ok(sent[1].message.endsWith(CLEANED), "the voice message ends with its transcript");
    kit.record("E2: a photo sent alone, then the voice as its own message");
  });
}
