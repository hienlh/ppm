/**
 * "Quiet while I'm at PPM", checked against the fake Bot API: which messages carry
 * `disable_notification`, when a card left unanswered gets its one reminder with a sound, and the
 * `/quiet` switch.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, memoryState, queueFor, texts, useFakeTelegram } from "./bridge-test-kit.ts";
import { configService } from "../../../../src/services/config.service.ts";
import {
  CardReminders, quietWhileInPpm, REMINDER_HTML, setQuietWhileInPpm, TelegramSilence,
} from "../../../../src/services/assistant-telegram/assistant-telegram-silence.ts";
import { LONG_TURN_MS, PLACEHOLDER, TurnRenderer } from "../../../../src/services/assistant-telegram/assistant-telegram-turn-renderer.ts";
import { turnSilence } from "../../../../src/services/assistant-telegram/assistant-telegram-mirror.ts";
import { sendMessageTask } from "../../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import { parseCommand, quietStatusHtml, runCommand } from "../../../../src/services/assistant-telegram/assistant-telegram-commands.ts";
import type { AssistantClock } from "../../../../src/services/assistant-wake/assistant-clock.ts";
import type { ChatMessageOrigin } from "../../../../src/services/chat-control/chat-control.ts";
import { stripTelegramHtml } from "../../../../src/services/telegram/telegram-html-format.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
const MIN = 60_000;

/** A clock whose timers run only when the test moves time past them. */
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
    now += ms;
    for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); }
  };
  return { clock, advance, now: () => now };
}

/** The user's presence as the test sets it: when they last touched a PPM tab (null: never). */
function silenceAt(state: { now: number; lastInput: number | null; on?: boolean }): TelegramSilence {
  return new TelegramSilence({
    enabled: () => state.on !== false,
    idleMs: (now) => (state.lastInput === null ? null : now - state.lastInput),
    now: () => state.now,
    windowMs: 5 * MIN,
  });
}

const originalClawbot = configService.get("clawbot");
afterEach(() => configService.set("clawbot", originalClawbot as never));

describe("whether the user is at PPM", () => {
  it("counts a PPM tab touched within five minutes, and not one touched longer ago", () => {
    const s = { now: 10 * MIN, lastInput: 6 * MIN };
    const silence = silenceAt(s);
    expect(silence.inPpm()).toBe(true);
    s.now = 11 * MIN;
    expect(silence.inPpm()).toBe(true);
    s.now = 11 * MIN + 1;
    expect(silence.inPpm()).toBe(false);
  });

  it("counts a message typed in PPM even before presence has heard of it", () => {
    const s = { now: 10 * MIN, lastInput: null };
    const silence = silenceAt(s);
    expect(silence.inPpm()).toBe(false);
    silence.notePpmMessage(10 * MIN);
    expect(silence.inPpm()).toBe(true);
    s.now = 16 * MIN;
    expect(silence.inPpm()).toBe(false);
  });

  it("is never at PPM with the switch off", () => {
    const silence = silenceAt({ now: 10 * MIN, lastInput: 10 * MIN, on: false });
    silence.notePpmMessage(10 * MIN);
    expect(silence.inPpm()).toBe(false);
    expect(silence.enabled()).toBe(false);
  });

  it("silences a turn by who started it", () => {
    const s = { now: 10 * MIN, lastInput: null as number | null };
    const silence = silenceAt(s);
    const ask = (origin: ChatMessageOrigin, phase: "draft" | "final") => turnSilence(origin, silence)?.(phase) ?? false;
    // Typed on Telegram: never, whatever presence says.
    s.lastInput = s.now;
    expect(turnSilence("telegram", silence)).toBeUndefined();
    // Typed in PPM: drafts while the switch is on; the final answer only if the user is still here.
    expect(ask("ws", "draft")).toBe(true);
    expect(ask("ws", "final")).toBe(true);
    s.now += 6 * MIN;
    expect(ask("ws", "draft")).toBe(true);
    expect(ask("ws", "final")).toBe(false);
    // Started by PPM itself: while the user is here.
    expect(ask("watch", "final")).toBe(false);
    s.lastInput = s.now;
    expect(ask("watch", "draft")).toBe(true);
    // No silence rule at all (the switch's owner left out): nothing is silent.
    expect(turnSilence("ws", undefined)).toBeUndefined();
  });
});

describe("a silent message on the wire", () => {
  it("carries disable_notification only when the rule says so, asked when it is sent", async () => {
    const chat = connectChat(freshChat());
    const queue = queueFor(client);
    let quiet = true;
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "one" }, { label: "t", silent: () => quiet }));
    await queue.whenIdle();
    quiet = false;
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "two" }, { label: "t", silent: () => quiet }));
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "three" }, { label: "t" }));
    await queue.whenIdle();
    expect(fake.sent(Number(chat)).map((m) => [m.text, m.silent])).toEqual([["one", true], ["two", false], ["three", false]]);
    const call = fake.calls.findLast((c) => c.method === "sendMessage" && c.body.text === "one")!;
    expect(call.body.disable_notification).toBe(true);
    expect("disable_notification" in fake.calls.findLast((c) => c.method === "sendMessage" && c.body.text === "two")!.body).toBe(false);
  });
});

describe("a turn told to be silent", () => {
  function turn(silent: ((phase: "draft" | "final") => boolean) | undefined, origin: ChatMessageOrigin = "ws") {
    const chat = connectChat(freshChat());
    const queue = queueFor(client);
    let now = 5_000_000;
    const r = new TurnRenderer({
      queue, state: memoryState(), chatId: chat, origin, showToolCalls: () => false, now: () => now,
      ...(silent ? { silent } : {}),
    });
    return { r, chat, queue, advance: (ms: number) => { now += ms; } };
  }

  it("sends its draft silently and finishes a long answer in place, not as a new message", async () => {
    const t = turn(() => true);
    t.r.start();
    t.r.text("Working");
    await t.queue.whenIdle();
    t.advance(LONG_TURN_MS + 1);
    t.r.text(" — done.");
    t.r.finish();
    await t.queue.whenIdle();
    const sent = fake.sent(Number(t.chat));
    expect(sent.map((m) => [m.text, m.silent])).toEqual([["Working — done.", true]]);
    expect(fake.deleted.some((m) => m.chat_id === Number(t.chat))).toBe(false);
  });

  it("rings with a new message when the final answer is not silent (the user left PPM)", async () => {
    const t = turn((phase) => phase === "draft");
    t.r.start();
    await t.queue.whenIdle();
    t.advance(LONG_TURN_MS + 1);
    t.r.text("Finished the job.");
    t.r.finish();
    await t.queue.whenIdle();
    expect(fake.sent(Number(t.chat)).map((m) => [m.text, m.silent])).toEqual([["Finished the job.", false]]);
    // The silent draft is gone: only the answer that rang is left.
    expect(fake.deleted.findLast((m) => m.chat_id === Number(t.chat))?.silent).toBe(true);
  });

  it("is untouched with no silence rule (a turn typed on Telegram)", async () => {
    const t = turn(undefined, "telegram");
    t.r.start();
    await t.queue.whenIdle();
    expect(fake.sent(Number(t.chat)).map((m) => [m.text, m.silent])).toEqual([[PLACEHOLDER, false]]);
    t.advance(LONG_TURN_MS + 1);
    t.r.text("Done.");
    t.r.finish();
    await t.queue.whenIdle();
    expect(texts(fake, t.chat)).toEqual(["Done."]);
    expect(fake.sent(Number(t.chat))[0]!.silent).toBe(false);
  });
});

describe("the one reminder for a card left unanswered", () => {
  async function silentCard() {
    const chat = connectChat(freshChat());
    const queue = queueFor(client);
    queue.enqueue(chat, sendMessageTask(queue, chat, { html: "🔐 card" }, { label: "card", silent: true }));
    await queue.whenIdle();
    return { chat, queue, messageId: fake.sent(Number(chat))[0]!.message_id };
  }

  it("replies to the card with a sound once it has waited five minutes", async () => {
    const { chat, queue, messageId } = await silentCard();
    const c = manualClock();
    const reminders = new CardReminders({ queue, clock: c.clock, quietEnd: () => null, delayMs: 5 * MIN });
    reminders.schedule({ chatId: chat, messageId, label: "card", stillWaiting: () => true });
    reminders.schedule({ chatId: chat, messageId, label: "card", stillWaiting: () => true });
    c.advance(5 * MIN - 1);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(1);
    c.advance(1);
    await queue.whenIdle();
    const reminder = fake.sent(Number(chat))[1]!;
    expect(reminder.text).toBe(stripTelegramHtml(REMINDER_HTML));
    expect(reminder.reply_to).toBe(messageId);
    expect(reminder.silent).toBe(false);
    // Once only: neither the duplicate schedule nor more time sends another.
    c.advance(60 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(2);
  });

  it("sends nothing for a card answered in time", async () => {
    const { chat, queue, messageId } = await silentCard();
    const c = manualClock();
    let waiting = true;
    const reminders = new CardReminders({ queue, clock: c.clock, quietEnd: () => null, delayMs: 5 * MIN });
    reminders.schedule({ chatId: chat, messageId, label: "card", stillWaiting: () => waiting });
    waiting = false;
    c.advance(5 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(1);
  });

  it("stays quiet in quiet hours", async () => {
    const { chat, queue, messageId } = await silentCard();
    const c = manualClock();
    const reminders = new CardReminders({ queue, clock: c.clock, quietEnd: () => c.now() + 60 * MIN, delayMs: 5 * MIN });
    reminders.schedule({ chatId: chat, messageId, label: "card", stillWaiting: () => true });
    c.advance(5 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(1);
  });

  it("drops what is pending when the bridge stops", async () => {
    const { chat, queue, messageId } = await silentCard();
    const c = manualClock();
    const reminders = new CardReminders({ queue, clock: c.clock, quietEnd: () => null, delayMs: 5 * MIN });
    reminders.schedule({ chatId: chat, messageId, label: "card", stillWaiting: () => true });
    expect(reminders.pending()).toBe(1);
    reminders.clear();
    c.advance(5 * MIN);
    await queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(1);
  });
});

describe("the switch", () => {
  it("is on unless turned off, and keeps the rest of the row", () => {
    configService.set("clawbot", { enabled: true, show_tool_calls: false, debounce_ms: 700 } as never);
    expect(quietWhileInPpm()).toBe(true);
    setQuietWhileInPpm(false);
    expect(quietWhileInPpm()).toBe(false);
    expect(configService.get("clawbot")).toMatchObject({ enabled: true, show_tool_calls: false, debounce_ms: 700, quiet_while_in_ppm: false });
    setQuietWhileInPpm(true);
    expect(quietWhileInPpm()).toBe(true);
  });

  it("is shown and flipped by /quiet on Telegram", async () => {
    configService.set("clawbot", { enabled: true, show_tool_calls: true, debounce_ms: 0 } as never);
    const replies: Array<{ html: string; markup?: unknown }> = [];
    const codes: boolean[] = [];
    const ctx = {
      chatId: "1", reply: (html: string, markup?: unknown) => { replies.push({ html, markup }); },
      switchCode: () => "x", relayCard: () => {}, quietCode: (on: boolean) => { codes.push(on); return `q${on}`; },
    };
    await runCommand(parseCommand("/quiet")!, ctx);
    expect(replies.at(-1)!.html).toBe(quietStatusHtml(true));
    expect(replies.at(-1)!.markup).toEqual({ inline_keyboard: [[{ text: "Turn off", callback_data: "qfalse" }]] });
    await runCommand(parseCommand("/quiet off")!, ctx);
    expect(quietWhileInPpm()).toBe(false);
    expect(replies.at(-1)!.html).toBe(quietStatusHtml(false));
    await runCommand(parseCommand("/quiet")!, ctx);
    expect(replies.at(-1)!.markup).toEqual({ inline_keyboard: [[{ text: "Turn on", callback_data: "qtrue" }]] });
    await runCommand(parseCommand("/quiet ON")!, ctx);
    expect(quietWhileInPpm()).toBe(true);
    await runCommand(parseCommand("/quiet maybe")!, ctx);
    expect(replies.at(-1)!.html).toContain("/quiet on");
    expect(quietWhileInPpm()).toBe(true);
  });
});
