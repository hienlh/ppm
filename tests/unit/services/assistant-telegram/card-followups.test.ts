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
  FOLLOWUP_CUT_NOTE, FOLLOWUP_STOPPED_NOTE, FOLLOWUP_TITLE_ONLY_NOTE, formatCardFollowup,
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
import { AssistantTelegramManagerCards } from "../../../../src/services/assistant-telegram/assistant-telegram-manager-cards.ts";
import { sendMessageTask } from "../../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import { CARD_FOLLOWUP_LOUD_MS, CARD_FOLLOWUP_MAX_CHARS } from "../../../../src/shared/assistant-limits.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
beforeEach(() => { getDb().query("DELETE FROM clawbot_paired_chats").run(); });

const base = { overflow: false, detail: "full" as const, projectName: "ppm", newCards: [], url: null };
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

  it("names the new card the manager opened in that turn, and links back to the chat", () => {
    const publicLink = formatCardFollowup({ ...base, text: "It costs a lot.", newCards: [{ title: "Run it anyway? ~40% <quota>" }], url: "https://ppm.example.com/x" });
    expect(visible(publicLink.html)).toContain("It also opened a new card: Run it anyway? ~40% <quota>");
    expect(publicLink.markup?.inline_keyboard[0]![0]).toMatchObject({ text: "Open in PPM", url: "https://ppm.example.com/x" });
    expect(publicLink.fallbackHtml).toContain("https://ppm.example.com/x");
    const lan = formatCardFollowup({ ...base, text: "ok", url: "http://localhost:8080/x" });
    expect(lan.markup).toBeUndefined();
    expect(visible(lan.html)).toContain("Open in PPM: http://localhost:8080/x");
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

  it("keeps a PPM reply's answer in PPM during quiet hours, for a card never sent to Telegram, and for a chat cut off", () => {
    const chat = connectChat(freshChat());
    expect(sink({ atPpm: false, quiet: true, refs: [{ chatId: chat, messageId: 3 }] }).s.targets(delivery({ channel: "ppm" }))).toEqual([]);
    expect(sink({ atPpm: false }).s.targets(delivery({ channel: "ppm" }))).toEqual([]);
    expect(sink({ atPpm: false }).s.targets(delivery({ channel: "telegram", chatId: "9999999999" }))).toEqual([]);
  });
});
