/**
 * The reminder for cards nobody answered, against the fake Bot API: one message for cards due
 * together, one reminder per card ever, the switch, quiet hours, and a Telegram that delivers a
 * message but times out before saying so (the morning one reminder arrived five times).
 */
import { describe, expect, it } from "bun:test";
import { connectChat, freshChat, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import {
  CardReminders, GATHER_MS, REMINDER_HTML, REMINDER_LIST_MAX, reminderListHtml, type CardReminderSettings, type ReminderRequest,
} from "../../../../src/services/assistant-telegram/assistant-telegram-card-reminders.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "../../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import { TelegramBotClient } from "../../../../src/services/telegram/telegram-bot-client.ts";
import { TELEGRAM_API_BASE_ENV } from "../../../../src/services/telegram/telegram-api-base.ts";
import type { AssistantClock } from "../../../../src/services/assistant-wake/assistant-clock.ts";
import { stripTelegramHtml } from "../../../../src/services/telegram/telegram-html-format.ts";

const fake = useFakeTelegram();
const MIN = 60_000;

/** A clock whose timers run only when the test moves time past them, in the order they are due. */
function manualClock(start = 1_000_000) {
  let now = start;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const clock: AssistantClock = {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = Math.max(now, next.at);
      next.live = false;
      next.fn();
    }
    now = target;
  };
  return { clock, advance, now: () => now };
}

/** A client that gives up on `sendMessage` after 100 ms, so a held answer is a timeout. */
function impatientClient(): TelegramBotClient {
  return new TelegramBotClient(fake.token, { editIntervalMs: 0, sleep: async () => {}, sendTimeoutMs: 100 });
}

/** `n` silent cards in a fresh chat, as the bridge sends them. */
async function silentCards(n: number, queue: AssistantTelegramSendQueue) {
  const chat = connectChat(freshChat());
  for (let i = 0; i < n; i++) {
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: `🔔 card ${i + 1}` }, { label: "card", silent: true }));
  }
  await queue.whenIdle();
  return { chat, ids: fake.sent(Number(chat)).map((m) => m.message_id) };
}

function setup(opts: { quietEnd?: () => number | null; settings?: () => CardReminderSettings } = {}) {
  const queue = queueFor(impatientClient());
  const c = manualClock();
  const reminders = new CardReminders({
    queue, clock: c.clock, quietEnd: opts.quietEnd ?? (() => null), delayMs: 5 * MIN,
    ...(opts.settings ? { settings: opts.settings } : {}),
  });
  return { queue, c, reminders };
}

const card = (chat: string, messageId: number, i: number, waiting: () => boolean = () => true): ReminderRequest => ({
  chatId: chat, messageId, label: "needs_decision card", stillWaiting: waiting,
  project: "Nxsys", title: `Decision ${i}`, url: `https://ppm.example.com/assistant?card=${i}`,
});

describe("cards due together", () => {
  it("are one message, a line each linking into PPM", async () => {
    const { queue, c, reminders } = setup();
    const { chat, ids } = await silentCards(5, queue);
    ids.forEach((id, i) => {
      reminders.schedule(card(chat, id, i + 1));
      c.advance(10_000); // sent over 40 seconds, as a manager sends a batch
    });
    c.advance(5 * MIN);
    await queue.whenIdle();
    const sent = fake.sent(Number(chat)).slice(5);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.silent).toBe(false);
    expect(sent[0]!.reply_to).toBeUndefined();
    expect(sent[0]!.text.split("\n")[0]).toBe("⏰ Still waiting for you: 5 cards");
    for (let i = 1; i <= 5; i++) {
      expect(sent[0]!.text).toContain(`• Nxsys · Decision ${i}`);
      expect(sent[0]!.html).toContain(`<a href="https://ppm.example.com/assistant?card=${i}">Nxsys · Decision ${i}</a>`);
    }
    expect(reminders.pending()).toBe(0);
  });

  it("keeps the reply to the card when only one is due", async () => {
    const { queue, c, reminders } = setup();
    const { chat, ids } = await silentCards(1, queue);
    reminders.schedule(card(chat, ids[0]!, 1));
    c.advance(5 * MIN);
    await queue.whenIdle();
    const reminder = fake.sent(Number(chat))[1]!;
    expect(reminder.text).toBe(stripTelegramHtml(REMINDER_HTML));
    expect(reminder.reply_to).toBe(ids[0]);
  });

  it("are separate messages when they come due further apart than the gathering window", async () => {
    const { queue, c, reminders } = setup();
    const { chat, ids } = await silentCards(2, queue);
    reminders.schedule(card(chat, ids[0]!, 1));
    c.advance(GATHER_MS + MIN);
    reminders.schedule(card(chat, ids[1]!, 2));
    c.advance(30 * MIN);
    await queue.whenIdle();
    const sent = fake.sent(Number(chat)).slice(2);
    expect(sent.map((m) => m.reply_to)).toEqual([ids[0], ids[1]]);
  });

  it("never pull a card in sooner than half its delay, so a card sent seconds ago is not nudged", async () => {
    const queue = queueFor(impatientClient());
    const c = manualClock();
    const reminders = new CardReminders({ queue, clock: c.clock, quietEnd: () => null, settings: () => ({ enabled: true, minutes: 1 }) });
    const { chat, ids } = await silentCards(2, queue);
    reminders.schedule(card(chat, ids[0]!, 1));
    c.advance(45_000);
    reminders.schedule(card(chat, ids[1]!, 2)); // due 45 s after the first: more than half a minute
    c.advance(15_000);
    await queue.whenIdle();
    expect(fake.sent(Number(chat)).slice(2).map((m) => m.reply_to)).toEqual([ids[0]]);
    c.advance(45_000);
    await queue.whenIdle();
    expect(fake.sent(Number(chat)).slice(2).map((m) => m.reply_to)).toEqual([ids[0], ids[1]]);
  });

  it("leave out a card answered or withdrawn before the reminder", async () => {
    const { queue, c, reminders } = setup();
    const { chat, ids } = await silentCards(3, queue);
    const open = [true, false, true];
    ids.forEach((id, i) => reminders.schedule(card(chat, id, i + 1, () => open[i]!)));
    c.advance(5 * MIN);
    await queue.whenIdle();
    const sent = fake.sent(Number(chat)).slice(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("2 cards");
    expect(sent[0]!.text).not.toContain("Decision 2");
  });

  it("names how many more there are past the list's length", () => {
    const cards = Array.from({ length: REMINDER_LIST_MAX + 3 }, (_, i) => card("1", i + 1, i + 1));
    const text = stripTelegramHtml(reminderListHtml(cards));
    expect(text.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(REMINDER_LIST_MAX);
    expect(text).toContain("…and 3 more in PPM");
  });

  it("escape a title and drop a link Telegram cannot open", () => {
    const html = reminderListHtml([
      { ...card("1", 1, 1), title: "a < b & c", url: "http://localhost:8080/x" },
      { ...card("1", 2, 2), project: null },
    ]);
    expect(html).toContain("• Nxsys · a &lt; b &amp; c\n");
    expect(html).not.toContain("localhost");
    expect(html).toContain(">Decision 2</a>");
  });
});

describe("one reminder per card", () => {
  it("never reminds about a card twice, scheduled again or not", async () => {
    const { queue, c, reminders } = setup();
    const { chat, ids } = await silentCards(1, queue);
    reminders.schedule(card(chat, ids[0]!, 1));
    reminders.schedule(card(chat, ids[0]!, 1));
    c.advance(5 * MIN);
    await queue.whenIdle();
    reminders.schedule(card(chat, ids[0]!, 1));
    c.advance(120 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(2);
  });
});

describe("the switch", () => {
  it("sends nothing while reminders are off", async () => {
    const { queue, c, reminders } = setup({ settings: () => ({ enabled: false, minutes: 5 }) });
    const { chat, ids } = await silentCards(3, queue);
    ids.forEach((id, i) => reminders.schedule(card(chat, id, i + 1)));
    expect(reminders.pending()).toBe(0);
    c.advance(60 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(3);
  });

  it("drops what is pending when turned off before the reminder is due", async () => {
    let on = true;
    const { queue, c, reminders } = setup({ settings: () => ({ enabled: on, minutes: 5 }) });
    const { chat, ids } = await silentCards(2, queue);
    ids.forEach((id, i) => reminders.schedule(card(chat, id, i + 1)));
    on = false;
    c.advance(5 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(2);
    expect(reminders.pending()).toBe(0);
  });

  it("waits the minutes it is set to", async () => {
    const queue = queueFor(impatientClient());
    const c = manualClock();
    const reminders = new CardReminders({ queue, clock: c.clock, quietEnd: () => null, settings: () => ({ enabled: true, minutes: 20 }) });
    const { chat, ids } = await silentCards(1, queue);
    reminders.schedule(card(chat, ids[0]!, 1));
    c.advance(20 * MIN - 1);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(1);
    c.advance(1);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(2);
  });
});

describe("quiet hours", () => {
  it("hold every reminder, then send one message for what still waits once they end", async () => {
    let quietUntil: number | null = null;
    const { queue, c, reminders } = setup({ quietEnd: () => (quietUntil !== null && c.now() < quietUntil ? quietUntil : null) });
    const { chat, ids } = await silentCards(4, queue);
    quietUntil = c.now() + 2 * 60 * MIN;
    const open = [true, true, false, true];
    // Due at different times inside the quiet window: ten minutes apart.
    ids.forEach((id, i) => {
      reminders.schedule(card(chat, id, i + 1, () => open[i]!));
      c.advance(10 * MIN);
    });
    c.advance(60 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(4);
    open[1] = false; // answered during the night
    c.advance(60 * MIN);
    await queue.whenIdle();
    const sent = fake.sent(Number(chat)).slice(4);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("2 cards");
    expect(sent[0]!.text).toContain("Decision 1");
    expect(sent[0]!.text).toContain("Decision 4");
    expect(sent[0]!.text).not.toContain("Decision 2");
    c.advance(24 * 60 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(5);
  });

  it("send nothing at their end when every card was answered", async () => {
    let quiet = true;
    let waiting = true;
    const { queue, c, reminders } = setup({ quietEnd: () => (quiet ? c.now() + 30 * MIN : null) });
    const { chat, ids } = await silentCards(2, queue);
    ids.forEach((id, i) => reminders.schedule(card(chat, id, i + 1, () => waiting)));
    c.advance(10 * MIN);
    waiting = false;
    quiet = false;
    c.advance(60 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(2);
    expect(reminders.pending()).toBe(0);
  });
});

describe("a Telegram that delivers but does not answer", () => {
  it("gets a reminder once, however many times it would have been retried", async () => {
    const { queue, c, reminders } = setup();
    const { chat, ids } = await silentCards(1, queue);
    reminders.schedule(card(chat, ids[0]!, 1));
    // The morning of 26/11: Telegram took the message and lost the answer. Before, that was retried
    // four times, each one delivered; now the first lost answer ends it.
    fake.delayNextAnswer("sendMessage", 400);
    c.advance(5 * MIN);
    await queue.whenIdle();
    await Bun.sleep(500);
    expect(fake.sent(Number(chat)).filter((m) => m.reply_to === ids[0])).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "sendMessage" && Number(call.body.chat_id) === Number(chat) && (call.body.reply_parameters as { message_id?: number } | undefined)?.message_id === ids[0])).toHaveLength(1);
  });

  it("sends a card at most twice when its answers keep getting lost", async () => {
    const queue = queueFor(impatientClient());
    const chat = connectChat(freshChat());
    fake.delayNextAnswer("sendMessage", 400);
    fake.delayNextAnswer("sendMessage", 400);
    let dropped: string | null = null;
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "🔔 card" }, { label: "card", onDropped: (why) => { dropped = why; } }));
    await queue.whenIdle();
    await Bun.sleep(500);
    expect(fake.sent(Number(chat)).filter((m) => m.text === "🔔 card")).toHaveLength(2);
    expect(dropped).toContain("may have arrived");
  });

  it("sends a card once more after one lost answer, so it arrives (twice) rather than not at all", async () => {
    const queue = queueFor(impatientClient());
    const chat = connectChat(freshChat());
    fake.delayNextAnswer("sendMessage", 400);
    let sentId: number | null = null;
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "🔔 card" }, { label: "card", onSent: (m) => { sentId = m.message_id; } }));
    await queue.whenIdle();
    await Bun.sleep(500);
    const copies = fake.sent(Number(chat)).filter((m) => m.text === "🔔 card");
    expect(copies).toHaveLength(2);
    expect(sentId).toBe(copies[1]!.message_id);
  });

  it("tells a timeout (may have arrived) from a refused connection (never sent)", async () => {
    const client = new TelegramBotClient(fake.token, { editIntervalMs: 0, sleep: async () => {} });
    const failure = (e: unknown) => (client as unknown as { networkFailure: (w: string, e: unknown, s: boolean) => { maybeSent?: true } })
      .networkFailure("sendMessage", e, true);
    const refused = await fetch("http://127.0.0.1:1/").catch((e: Error) => e);
    expect(failure(refused).maybeSent).toBeUndefined();
    expect(failure(new DOMException("The operation timed out.", "TimeoutError")).maybeSent).toBe(true);
    const unreachable = Object.assign(new Error("connect ENETUNREACH 149.154.167.220:443"), { code: "ENETUNREACH" });
    expect(failure(unreachable).maybeSent).toBeUndefined();
  });

  it("reads a gateway timeout page as possibly delivered, and a bad gateway as not", async () => {
    let status = 504;
    const gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<html>gateway</html>", { status, headers: { "content-type": "text/html" } }) });
    const before = process.env[TELEGRAM_API_BASE_ENV];
    process.env[TELEGRAM_API_BASE_ENV] = `http://127.0.0.1:${gateway.port}`;
    try {
      const client = new TelegramBotClient(fake.token, { editIntervalMs: 0, sleep: async () => {} });
      expect(await client.sendMessage(1, "x")).toMatchObject({ ok: false, errorCode: null, maybeSent: true });
      status = 502;
      const bad = await client.sendMessage(1, "x");
      expect(bad).toMatchObject({ ok: false, errorCode: 502 });
      expect("maybeSent" in bad).toBe(false);
    } finally {
      process.env[TELEGRAM_API_BASE_ENV] = before;
      void gateway.stop(true);
    }
  });
});
