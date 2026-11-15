/**
 * The manager's answer to a card reply on Telegram: what it says (escaped, redacted before the cut,
 * capped at 1500 characters with "see the chat" and a link, nothing but "it answered" for a project
 * whose details stay off the phone, the new card it opened named) and where it goes — under the
 * card the user replied to, with a sound when the reply came from Telegram whatever "quiet while
 * I'm at PPM" or quiet hours say; under each copy of the card, silent while the user is at PPM and
 * not at all in quiet hours, when the reply came from PPM.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import { AssistantTelegramCardFollowups } from "../../../../src/services/assistant-telegram/assistant-telegram-card-followups.ts";
import {
  FOLLOWUP_CUT_NOTE, FOLLOWUP_LABEL, FOLLOWUP_STOPPED_NOTE, FOLLOWUP_TITLE_ONLY_NOTE, formatCardFollowup, formatNewCardPointer,
  NEW_CARD_POINTER_LABEL,
} from "../../../../src/services/assistant-telegram/assistant-telegram-followup-format.ts";
import { TelegramSilence } from "../../../../src/services/assistant-telegram/assistant-telegram-silence.ts";
import type { CardFollowupDelivery } from "../../../../src/services/assistant-cards/card-reply-followup.ts";
import type { FollowupOrigin } from "../../../../src/services/assistant-cards/card-reply-followup-tracker.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import { stripTelegramHtml } from "../../../../src/services/telegram/telegram-html-format.ts";
import { parseTelegramHtml } from "../../../helpers/fake-telegram-bot-api.ts";
import type { AssistantCard } from "../../../../src/shared/assistant-cards.ts";
import type { TelegramCardRef } from "../../../../src/services/assistant-cards/assistant-cards-db.ts";
import { addCardTelegramRef } from "../../../../src/services/assistant-cards/assistant-cards-outbound-db.ts";
import { createAssistantCards } from "../../../../src/services/assistant-cards/assistant-cards.service.ts";
import { AssistantTelegramCardReplies } from "../../../../src/services/assistant-telegram/assistant-telegram-card-replies.ts";
import { AssistantTelegramManagerCards } from "../../../../src/services/assistant-telegram/assistant-telegram-manager-cards.ts";
import { sendMessageTask } from "../../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import { CARD_FOLLOWUP_LOUD_MS, CARD_FOLLOWUP_MAX_CHARS } from "../../../../src/shared/assistant-limits.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
beforeEach(() => { getDb().query("DELETE FROM clawbot_paired_chats").run(); });

const base = { overflow: false, detail: "full" as const, projectName: "ppm", url: null };
const visible = (html: string): string => {
  const parsed = parseTelegramHtml(html);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.text;
};

describe("formatCardFollowup", () => {
  it("escapes the manager's text through the Markdown formatter, so Telegram can parse it", () => {
    const { html } = formatCardFollowup({ ...base, text: "**No** — <script>alert(1)</script> & 40% of the quota" });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<b>No</b>");
    expect(visible(html)).toContain("<script>alert(1)</script> & 40% of the quota");
  });

  it("caps the answer at 1500 characters with 'see the chat', and says so when the turn said more than was kept", () => {
    const long = formatCardFollowup({ ...base, text: "a".repeat(CARD_FOLLOWUP_MAX_CHARS + 300) });
    const text = visible(long.html);
    expect(text).toContain(FOLLOWUP_CUT_NOTE);
    expect(text).not.toContain("a".repeat(CARD_FOLLOWUP_MAX_CHARS + 1));
    expect(visible(formatCardFollowup({ ...base, text: "short", overflow: true }).html)).toContain(FOLLOWUP_CUT_NOTE);
    expect(visible(formatCardFollowup({ ...base, text: "short" }).html)).not.toContain(FOLLOWUP_CUT_NOTE);
  });

  it("redacts a secret before cutting, so no part of it survives the cut", () => {
    const key = `AKIA${"Q".repeat(16)}`;
    const text = `${"b".repeat(CARD_FOLLOWUP_MAX_CHARS - 6)} ${key} more`;
    const out = visible(formatCardFollowup({ ...base, text }).html);
    expect(out).not.toContain("AKIA");
    expect(out).toContain("1 secret-looking value hidden");
    expect(visible(formatCardFollowup({ ...base, text: `use ${key}` }).html)).toContain("[REDACTED]");
  });

  it("shows no answer text for a project whose details stay off the phone", () => {
    const out = visible(formatCardFollowup({ ...base, detail: "title", text: "client NI number QQ123456C" }).html);
    expect(out).toContain(FOLLOWUP_TITLE_ONLY_NOTE);
    expect(out).not.toContain("QQ123456C");
  });

  it("says only that the turn stopped, with the link, whatever the project's detail level", () => {
    for (const detail of ["full", "title"] as const) {
      const out = formatCardFollowup({ ...base, detail, stopped: true, text: "half a sentence", url: "http://localhost:8080/x" });
      expect(visible(out.html)).toContain(FOLLOWUP_STOPPED_NOTE);
      expect(visible(out.html)).not.toContain("half a sentence");
      expect(visible(out.html)).not.toContain("The manager's answer to your reply");
      expect(visible(out.html)).toContain("Open in PPM: http://localhost:8080/x");
    }
  });

  it("links back to the chat: a button on a public address, written out on a local one", () => {
    const publicLink = formatCardFollowup({ ...base, text: "It costs a lot.", url: "https://ppm.example.com/x" });
    expect(publicLink.markup?.inline_keyboard[0]![0]).toMatchObject({ text: "Open in PPM", url: "https://ppm.example.com/x" });
    expect(publicLink.fallbackHtml).toContain("https://ppm.example.com/x");
    const lan = formatCardFollowup({ ...base, text: "ok", url: "http://localhost:8080/x" });
    expect(lan.markup).toBeUndefined();
    expect(visible(lan.html)).toContain("Open in PPM: http://localhost:8080/x");
  });

  it("names a new card in one line by its title only, escaped, with the link", () => {
    const pointer = formatNewCardPointer({ projectName: "ppm", newCards: [{ title: "Run it anyway? ~40% <quota>" }], url: "https://ppm.example.com/x" });
    expect(visible(pointer.html)).toBe(`${NEW_CARD_POINTER_LABEL} Run it anyway? ~40% <quota> · ppm`);
    expect(pointer.markup?.inline_keyboard[0]![0]).toMatchObject({ url: "https://ppm.example.com/x" });
    const many = formatNewCardPointer({ projectName: null, newCards: ["a", "b", "c", "d", "e"].map((title) => ({ title })), url: null });
    expect(visible(many.html)).toBe(`${NEW_CARD_POINTER_LABEL} a, b, c and 2 more`);
  });
});

const REPLIED_AT = 50_000_000;

/** A sink with the test's presence, quiet hours and card copies. */
function sink(opts: { atPpm: boolean; quiet?: boolean; refs?: TelegramCardRef[]; now?: number }) {
  const silence = new TelegramSilence({ enabled: () => true, idleMs: () => (opts.atPpm ? 0 : null), now: () => 1_000_000 });
  const queue = queueFor(client);
  const recorded: Array<{ cardId: string; ref: TelegramCardRef }> = [];
  const s = new AssistantTelegramCardFollowups({
    queue, silence, chatLink: async () => "http://localhost:8080/chat",
    refsOf: () => opts.refs ?? [], detailOf: () => "full", quietEnd: () => (opts.quiet ? 9_999_999 : null),
    recordRef: (cardId, ref) => recorded.push({ cardId, ref }), now: () => opts.now ?? REPLIED_AT,
  });
  return { s, queue, recorded };
}

const card = { id: "card-1", projectName: "ppm", projectKey: "k", status: "answered" } as AssistantCard;
const delivery = (origin: FollowupOrigin): CardFollowupDelivery => ({
  cardId: card.id, origin, sessionId: "mgr", text: "It will cost a lot: ~40% of this week's quota.", overflow: false, newCards: [], card,
  repliedAt: REPLIED_AT,
  stored: { text: "", truncated: false, at: 0 },
});

describe("where the answer goes", () => {
  it("answers a Telegram reply in that chat under the card, with a sound, while the user is at PPM and in quiet hours", async () => {
    const chat = connectChat(freshChat());
    const { s, queue } = sink({ atPpm: true, quiet: true });
    s.send(delivery({ channel: "telegram", chatId: chat, replyTo: 77 }));
    const msg = await fake.waitFor(() => fake.sent(Number(chat))[0]);
    await queue.whenIdle();
    expect(msg).toMatchObject({ reply_to: 77, silent: false });
    expect(stripTelegramHtml(msg!.text)).toContain("It will cost a lot");
  });

  it("rings past quiet rules only within 30 minutes of the reply; a later answer comes silently", () => {
    const chat = connectChat(freshChat());
    const silentOf = (o: { atPpm: boolean; quiet?: boolean; now: number }) =>
      sink(o).s.targets(delivery({ channel: "telegram", chatId: chat, replyTo: 7 })).map((t) => t.silent());
    expect(silentOf({ atPpm: true, quiet: true, now: REPLIED_AT + CARD_FOLLOWUP_LOUD_MS })).toEqual([false]);
    expect(silentOf({ atPpm: false, quiet: true, now: REPLIED_AT + CARD_FOLLOWUP_LOUD_MS + 1 })).toEqual([true]);
    expect(silentOf({ atPpm: true, now: REPLIED_AT + 3 * 60 * 60_000 })).toEqual([true]);
    expect(silentOf({ atPpm: false, now: REPLIED_AT + 3 * 60 * 60_000 })).toEqual([false]);
  });

  it("records the answer as the card's follow-up message, so a reply to it reaches the same manager", async () => {
    const chat = connectChat(freshChat());
    const { s, queue, recorded } = sink({ atPpm: false });
    s.send(delivery({ channel: "telegram", chatId: chat, replyTo: 77 }));
    const msg = await fake.waitFor(() => fake.sent(Number(chat))[0]);
    await queue.whenIdle();
    expect(recorded).toEqual([{ cardId: card.id, ref: { chatId: chat, messageId: msg!.message_id, followUp: true } }]);
  });

  it("sends an OK to the answer, or to the 'stopped' notice, to the replied card and never to the new card the turn opened", async () => {
    const chat = connectChat(freshChat());
    const store = createAssistantCards({ now: () => 1, projects: () => [], announce: () => {} });
    const replied = store.create({ kind: "needs_decision", sessionId: "mgr", title: "Enable verbose logs?" });
    store.transition(replied.id, "answered", { by: "user", channel: "telegram", at: 1 });
    const fresh = store.create({ kind: "needs_decision", sessionId: "mgr", title: "Run the full regression? ~40% quota" });
    addCardTelegramRef(fresh.id, { chatId: chat, messageId: 999_001 });
    const queue = queueFor(client);
    const s = new AssistantTelegramCardFollowups({ queue, chatLink: async () => "", detailOf: () => "full", now: () => REPLIED_AT });
    const asked = { ...delivery({ channel: "telegram", chatId: chat }), card: store.get(replied.id)!, newCards: [{ id: fresh.id, title: fresh.title }] };
    s.send(asked);
    s.send({ ...asked, text: "", stopped: true });
    await fake.waitFor(() => fake.sent(Number(chat)).length === 2);
    await queue.whenIdle();
    const [answerMsg, stoppedMsg] = fake.sent(Number(chat));
    const targets: string[] = [];
    const replies = new AssistantTelegramCardReplies({
      codes: { mint: () => "x", dropGroup: () => {} } as never, reply: () => {},
      replyTo: async (cardId) => { targets.push(cardId); return { ok: false, status: 409, error: "confirm", question: "send anyway?" }; },
    });
    for (const msg of [answerMsg!, stoppedMsg!]) {
      for (const text of ["OK", "Được.", "ok, noted"]) await replies.reply(chat, { text, replyToMessageId: msg.message_id, notTheUsers: false });
    }
    expect(targets).toEqual(Array(6).fill(replied.id));
    expect(store.get(fresh.id)!.status).toBe("open");
  });

  it("never answers under an earlier answer as if it were a copy of the card", async () => {
    const a = connectChat(freshChat());
    const refs: TelegramCardRef[] = [{ chatId: a, messageId: 30, followUp: true }, { chatId: a, messageId: 3 }];
    const { s } = sink({ atPpm: false, refs });
    expect(s.targets(delivery({ channel: "ppm" })).map((t) => t.replyTo)).toEqual([3]);
    expect(s.targets(delivery({ channel: "telegram", chatId: a })).map((t) => t.replyTo)).toEqual([3]);
    expect(sink({ atPpm: false, refs: [refs[0]!] }).s.targets(delivery({ channel: "ppm" }))).toEqual([]);
  });

  it("leaves an earlier answer as it is when the card's copies are rewritten on a change", async () => {
    const chat = connectChat(freshChat());
    const queue = queueFor(client);
    for (const html of ["the card", "the manager's answer"]) queue.enqueue(chat, sendMessageTask(queue, chat, { html }, { label: "t" }));
    await queue.whenIdle();
    const [cardMsg, answerMsg] = fake.sent(Number(chat));
    const store = createAssistantCards({ now: () => 1, projects: () => [], announce: () => {} });
    const made = store.create({ kind: "needs_decision", sessionId: null, title: "Run it?" });
    addCardTelegramRef(made.id, { chatId: chat, messageId: cardMsg!.message_id });
    addCardTelegramRef(made.id, { chatId: chat, messageId: answerMsg!.message_id, followUp: true });
    const dismissed = store.transition(made.id, "dismissed", { by: "user", channel: "ppm", at: 2 }).card!;
    const managerCards = new AssistantTelegramManagerCards({
      queue, codes: { dropGroup: () => {} } as never, chatLink: async () => "", sessionLink: async () => "",
      relayCard: () => {}, isShowing: () => false, detailOf: () => "full",
    });
    managerCards.changed(dismissed);
    await fake.waitFor(() => cardMsg!.history.length === 1);
    await queue.whenIdle();
    expect(answerMsg!.history).toEqual([]);
    expect(answerMsg!.text).toBe("the manager's answer");
  });

  it("finds the card's message in that chat when the reply did not name it (Send anyway)", async () => {
    const chat = connectChat(freshChat());
    const { s, queue } = sink({ atPpm: false, refs: [{ chatId: "other", messageId: 5 }, { chatId: chat, messageId: 12 }] });
    s.send(delivery({ channel: "telegram", chatId: chat }));
    expect(await fake.waitFor(() => fake.sent(Number(chat))[0])).toMatchObject({ reply_to: 12 });
    await queue.whenIdle();
  });

  it("puts a PPM reply's answer under each Telegram copy of the card: silent while the user is at PPM, with a sound when away", async () => {
    const a = connectChat(freshChat());
    const b = connectChat(freshChat());
    const refs = [{ chatId: a, messageId: 3 }, { chatId: b, messageId: 4 }];
    const here = sink({ atPpm: true, refs });
    here.s.send(delivery({ channel: "ppm" }));
    await fake.waitFor(() => fake.sent(Number(a)).length === 1 && fake.sent(Number(b)).length === 1);
    await here.queue.whenIdle();
    expect(fake.sent(Number(a)).at(-1)).toMatchObject({ reply_to: 3, silent: true });
    expect(fake.sent(Number(b)).at(-1)).toMatchObject({ reply_to: 4, silent: true });
    const away = sink({ atPpm: false, refs });
    away.s.send(delivery({ channel: "ppm" }));
    await fake.waitFor(() => fake.sent(Number(a)).length === 2);
    await away.queue.whenIdle();
    expect(fake.sent(Number(a)).at(-1)).toMatchObject({ reply_to: 3, silent: false });
  });

  it("tells a Telegram reply that the turn stopped, under the card with a sound, and never a PPM reply's copies", async () => {
    const chat = connectChat(freshChat());
    const { s, queue } = sink({ atPpm: true, refs: [{ chatId: chat, messageId: 3 }] });
    expect(s.targets({ ...delivery({ channel: "ppm" }), text: "", stopped: true })).toEqual([]);
    s.send({ ...delivery({ channel: "telegram", chatId: chat, replyTo: 3 }), text: "", stopped: true });
    const msg = await fake.waitFor(() => fake.sent(Number(chat))[0]);
    await queue.whenIdle();
    expect(msg).toMatchObject({ reply_to: 3, silent: false });
    expect(stripTelegramHtml(msg!.text)).toContain(FOLLOWUP_STOPPED_NOTE);
  });

  it("sends nothing under a PPM reply's copies when the manager answered with a new card: the card goes out by itself", () => {
    const chat = connectChat(freshChat());
    const { s } = sink({ atPpm: false, refs: [{ chatId: chat, messageId: 3 }] });
    expect(s.targets({ ...delivery({ channel: "ppm" }), newCards: [{ id: "n1", title: "Run it?" }] })).toEqual([]);
  });

  it("keeps a PPM reply's answer in PPM during quiet hours, for a card never sent to Telegram, and for a chat cut off", () => {
    const chat = connectChat(freshChat());
    expect(sink({ atPpm: false, quiet: true, refs: [{ chatId: chat, messageId: 3 }] }).s.targets(delivery({ channel: "ppm" }))).toEqual([]);
    expect(sink({ atPpm: false }).s.targets(delivery({ channel: "ppm" }))).toEqual([]);
    expect(sink({ atPpm: false }).s.targets(delivery({ channel: "telegram", chatId: "9999999999" }))).toEqual([]);
  });
});

/**
 * The case the user reported: a reply on Telegram that the manager answers with a new card plus a
 * closing line. It used to reach the phone twice, as the new card and as "The manager's answer to
 * your reply" saying much the same. Now the card goes under the user's reply and nothing else.
 */
describe("a manager that answers a Telegram reply with a new card", () => {
  const USER_MESSAGE = 4242;

  function bridge(chat: string, opts: { answering: boolean; atPpm?: boolean }) {
    const queue = queueFor(client);
    const silence = new TelegramSilence({ enabled: () => true, idleMs: () => (opts.atPpm ? 0 : null), now: () => 1_000_000 });
    const managerCards = new AssistantTelegramManagerCards({
      queue, codes: { mint: () => "c", dropGroup: () => {} } as never, chatLink: async () => "", sessionLink: async () => "",
      relayCard: () => {}, isShowing: () => false, detailOf: () => "full", recipients: () => [chat], silence,
      answering: () => (opts.answering
        ? [{ origin: { channel: "telegram", chatId: chat, replyTo: 77, messageId: USER_MESSAGE }, repliedAt: REPLIED_AT }]
        : []),
      now: () => REPLIED_AT + 5_000,
    });
    const followups = new AssistantTelegramCardFollowups({
      queue, silence, chatLink: async () => "", detailOf: () => "full", now: () => REPLIED_AT + 9_000,
      refsOf: () => [{ chatId: chat, messageId: 77 }], recordRef: () => {},
      threadedIn: (cardId, chatId) => managerCards.threadedIn(cardId, chatId),
    });
    return { queue, managerCards, followups };
  }

  /** A card the manager made `at` (by default a few seconds after the user's reply). */
  const newCard = (at = REPLIED_AT + 3_000): AssistantCard => {
    const store = createAssistantCards({ now: () => at, projects: () => [], announce: () => {} });
    return store.create({ kind: "needs_decision", sessionId: "mgr", title: "Run the full suite? ~40% quota", body: "Quota is at 60%; a full run takes ~40%." });
  };

  it("never threads a card made before the reply — one held overnight that goes out while the turn runs", async () => {
    const chat = connectChat(freshChat());
    const { queue, managerCards } = bridge(chat, { answering: true, atPpm: true });
    const held = newCard(REPLIED_AT - 8 * 60 * 60_000);
    managerCards.send([held], "While you were away: 1 item");
    await fake.waitFor(() => fake.sent(Number(chat)).length === 2);
    await queue.whenIdle();
    expect(fake.sent(Number(chat)).map((m) => m.reply_to)).toEqual([undefined, undefined]);
    expect(managerCards.threadedIn(held.id, chat)).toBe(false);
  });

  it("names the card in one line under the reply when it was refused after the follow-up counted on it", async () => {
    const chat = connectChat(freshChat());
    const { queue, managerCards, followups } = bridge(chat, { answering: true, atPpm: true });
    const made = newCard();
    fake.failNext("sendMessage", { code: 400, description: "Bad Request: REPLY_MARKUP_TOO_LONG" });
    managerCards.send([made]);
    followups.send(answer(chat, made));
    const pointer = await fake.waitFor(() => fake.sent(Number(chat)).find((m) => !m.failed));
    await queue.whenIdle();
    // Exactly once: the line is queued from inside the refused card's drop, which once started a
    // second loop on the same lane and sent it twice.
    expect(fake.sent(Number(chat)).filter((m) => !m.failed)).toHaveLength(1);
    expect(pointer).toMatchObject({ reply_to: USER_MESSAGE });
    expect(stripTelegramHtml(pointer!.text)).toBe(`${NEW_CARD_POINTER_LABEL} Run the full suite? ~40% quota`);
  });
  const answer = (chat: string, made: AssistantCard): CardFollowupDelivery => ({
    ...delivery({ channel: "telegram", chatId: chat, replyTo: 77, messageId: USER_MESSAGE }),
    text: "Quota is at 60% and a full run takes ~40%, so I opened a card to ask again.",
    newCards: [{ id: made.id, title: made.title }],
  });

  it("sends the card under the user's own message, with a sound while they are at PPM, and no follow-up text", async () => {
    const chat = connectChat(freshChat());
    const { queue, managerCards, followups } = bridge(chat, { answering: true, atPpm: true });
    const made = newCard();
    managerCards.send([made]);
    followups.send(answer(chat, made));
    await fake.waitFor(() => fake.sent(Number(chat))[0]);
    await queue.whenIdle();
    const sent = fake.sent(Number(chat));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ reply_to: USER_MESSAGE, silent: false });
    expect(stripTelegramHtml(sent[0]!.text)).toContain("Run the full suite?");
    expect(stripTelegramHtml(sent[0]!.text)).not.toContain(stripTelegramHtml(FOLLOWUP_LABEL));
  });

  it("names a card that did not go under the reply in one line, never the turn's text", async () => {
    const chat = connectChat(freshChat());
    const { queue, followups } = bridge(chat, { answering: false });
    const made = newCard();
    followups.send(answer(chat, made));
    const msg = await fake.waitFor(() => fake.sent(Number(chat))[0]);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(1);
    expect(msg).toMatchObject({ reply_to: 77 });
    expect(stripTelegramHtml(msg!.text)).toBe(`${NEW_CARD_POINTER_LABEL} Run the full suite? ~40% quota · ppm`);
  });

  it("threads nothing for a card made while no reply is being answered", async () => {
    const chat = connectChat(freshChat());
    const { queue, managerCards } = bridge(chat, { answering: false, atPpm: true });
    const made = newCard();
    managerCards.send([made]);
    const msg = await fake.waitFor(() => fake.sent(Number(chat))[0]);
    await queue.whenIdle();
    expect(msg!.reply_to).toBeUndefined();
    expect(msg!.silent).toBe(true);
    expect(managerCards.threadedIn(made.id, chat)).toBe(false);
  });
});
