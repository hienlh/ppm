/**
 * "Quiet while I'm at PPM" in the senders that are not the session's own conversation: the
 * Assistant's cards (a manager's decision, its other reports), a chat's database approval notice
 * and a watch report. Each is silent while the user is at PPM; a decision sent silently is
 * reminded about once, with a sound, if it still waits five minutes later.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import { AssistantTelegramManagerCards } from "../../../../src/services/assistant-telegram/assistant-telegram-manager-cards.ts";
import { AssistantTelegramDbNotices } from "../../../../src/services/assistant-telegram/assistant-telegram-db-notices.ts";
import { AssistantTelegramRelay } from "../../../../src/services/assistant-telegram/assistant-telegram-relay.ts";
import { AssistantTelegramCards } from "../../../../src/services/assistant-telegram/assistant-telegram-cards.ts";
import { BridgeStateStore } from "../../../../src/services/assistant-telegram/assistant-telegram-state.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import { CardReminders, REMINDER_HTML, TelegramSilence } from "../../../../src/services/assistant-telegram/assistant-telegram-silence.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { createDbAttentionEvents } from "../../../../src/services/db-ai-tools/db-attention-events.ts";
import { watchEvents } from "../../../../src/services/assistant-watch/watch-events.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import { stripTelegramHtml } from "../../../../src/services/telegram/telegram-html-format.ts";
import type { AssistantClock } from "../../../../src/services/assistant-wake/assistant-clock.ts";
import type { AssistantCard } from "../../../../src/shared/assistant-cards.ts";
import type { DbExecuteApprovalInput } from "../../../../src/shared/db-ai-tools.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
const MIN = 60_000;

beforeEach(() => { getDb().query("DELETE FROM clawbot_paired_chats").run(); });
const detach: Array<() => void> = [];
afterEach(() => { for (const off of detach.splice(0)) off(); });

/** Presence, the switch and the reminders' clock, all the test's. */
function world(opts: { atPpm: boolean; on?: boolean }) {
  let now = 50_000_000;
  const state = { lastInput: opts.atPpm ? now : null as number | null, on: opts.on !== false };
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const clock: AssistantClock = {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
  };
  const silence = new TelegramSilence({
    enabled: () => state.on,
    idleMs: (n) => (state.lastInput === null ? null : n - state.lastInput),
    now: () => now,
    windowMs: 5 * MIN,
  });
  const queue = queueFor(client);
  const reminders = new CardReminders({ queue, clock, quietEnd: () => null, delayMs: 5 * MIN });
  detach.push(() => reminders.clear());
  return {
    state, silence, queue, reminders,
    advance(ms: number) {
      now += ms;
      for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); }
    },
  };
}

const reminderText = stripTelegramHtml(REMINDER_HTML);
const pairs = (chat: string) => fake.sent(Number(chat)).map((m) => [m.text.split("\n")[0], m.silent, m.reply_to ?? null]);

function managerCard(over: Partial<AssistantCard>): AssistantCard {
  return {
    id: crypto.randomUUID(), kind: "needs_decision", projectName: "nxsys", projectKey: "k", sessionId: null,
    title: "Ship the fix today?", body: "Staging is green.", status: "open", answer: null,
    provenance: "Written by the nxsys manager AI", createdAt: 1, updatedAt: 1, payload: {},
    ...over,
  };
}

function managerCards(w: ReturnType<typeof world>, chat: string, open: Set<string>) {
  return new AssistantTelegramManagerCards({
    queue: w.queue, codes: new ButtonCodes<BridgeAction>(),
    chatLink: async () => "http://localhost:8080/x", sessionLink: async () => "http://localhost:8080/assistant",
    relayCard: () => {}, isShowing: () => false, recipients: () => [chat], detailOf: () => "full",
    silence: w.silence, reminders: w.reminders, isOpen: (id) => open.has(id),
  });
}

describe("the Assistant's own cards", () => {
  it("send a manager's decision silently while the user is at PPM, then remind once with a sound", async () => {
    const chat = connectChat(freshChat());
    const w = world({ atPpm: true });
    const card = managerCard({});
    const open = new Set([card.id]);
    managerCards(w, chat, open).send([card], "While you were away: 1 item");
    await fake.waitFor(() => fake.sent(Number(chat)).length === 2);
    await w.queue.whenIdle();
    const [header, sent] = fake.sent(Number(chat));
    expect(header!.silent).toBe(true);
    expect(sent!.silent).toBe(true);
    w.advance(5 * MIN);
    await w.queue.whenIdle();
    expect(pairs(chat).at(-1)).toEqual([reminderText, false, sent!.message_id]);
    w.advance(30 * MIN);
    await w.queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(3);
  });

  it("do not remind about a decision answered in time, nor about a report that asks nothing", async () => {
    const chat = connectChat(freshChat());
    const w = world({ atPpm: true });
    const decision = managerCard({});
    const done = managerCard({ kind: "done", title: "Released 0.25.1" });
    const open = new Set([decision.id, done.id]);
    managerCards(w, chat, open).send([decision, done]);
    await fake.waitFor(() => fake.sent(Number(chat)).length === 2);
    await w.queue.whenIdle();
    expect(fake.sent(Number(chat)).map((m) => m.silent)).toEqual([true, true]);
    open.delete(decision.id);
    w.advance(5 * MIN);
    await w.queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(2);
  });

  it("ring for an urgent card even while the user is at PPM, with no reminder", async () => {
    const chat = connectChat(freshChat());
    const w = world({ atPpm: true });
    const urgent = managerCard({ kind: "urgent", title: "Staging is down" });
    const done = managerCard({ kind: "done", title: "Released 0.25.1" });
    managerCards(w, chat, new Set([urgent.id, done.id])).send([urgent, done]);
    await fake.waitFor(() => fake.sent(Number(chat)).length === 2);
    await w.queue.whenIdle();
    // The urgent one rings; the report beside it, sent the same moment, stays silent.
    expect(fake.sent(Number(chat)).map((m) => m.silent)).toEqual([false, true]);
    w.advance(5 * MIN);
    await w.queue.whenIdle();
    expect(fake.sent(Number(chat))).toHaveLength(2);
  });

  it("ring as before when the user is away from PPM, or the switch is off", async () => {
    for (const w of [world({ atPpm: false }), world({ atPpm: true, on: false })]) {
      const chat = connectChat(freshChat());
      const card = managerCard({});
      managerCards(w, chat, new Set([card.id])).send([card]);
      await fake.waitFor(() => fake.sent(Number(chat)).length === 1);
      await w.queue.whenIdle();
      expect(fake.sent(Number(chat))[0]!.silent).toBe(false);
      w.advance(5 * MIN);
      await w.queue.whenIdle();
      expect(fake.sent(Number(chat))).toHaveLength(1);
    }
  });
});

const INPUT: DbExecuteApprovalInput = {
  connectionId: 3, connectionName: "Prod", dbType: "postgres", group: "Live", color: null, readonly: true,
  database: "billing", sql: "UPDATE invoices SET paid = true WHERE id = 42", reason: "Paid by wire", expectedRows: 1,
  passwordRequired: true,
};

describe("a chat's database approval notice", () => {
  function setup(w: ReturnType<typeof world>, waiting: Set<string>) {
    const events = createDbAttentionEvents();
    const n = new AssistantTelegramDbNotices({
      queue: w.queue, events, chatLink: async () => "http://localhost:8080/x",
      describe: () => ({ project: "billing-api", providerId: "claude", title: "Fix invoices" }),
      quiet: {
        clock: { now: () => 0, setTimer: () => () => {} },
        quietEnd: () => null,
        stillWaiting: (_s, requestId) => waiting.has(requestId),
      },
      silence: w.silence, reminders: w.reminders,
    });
    n.attach();
    detach.push(() => n.detach());
    return events;
  }

  it("is silent while the user is at PPM, and reminded about once if the change still waits", async () => {
    const chat = connectChat(freshChat());
    const w = world({ atPpm: true });
    const waiting = new Set(["r1"]);
    const events = setup(w, waiting);
    events.emit("approval_shown", { sessionId: "chat-1", requestId: "r1", input: INPUT, expiresAt: 30 * MIN });
    await fake.waitFor(() => fake.sent(Number(chat)).length === 1);
    await w.queue.whenIdle();
    const notice = fake.sent(Number(chat))[0]!;
    expect(notice.silent).toBe(true);
    // Its own reminder before it gives up is a notice too: silent while the user is here.
    events.emit("approval_reminder", { sessionId: "chat-1", requestId: "r1", input: INPUT, expiresAt: 30 * MIN });
    await fake.waitFor(() => fake.sent(Number(chat)).length === 2);
    await w.queue.whenIdle();
    expect(fake.sent(Number(chat))[1]!.silent).toBe(true);
    w.advance(5 * MIN);
    await w.queue.whenIdle();
    expect(pairs(chat).at(-1)).toEqual([reminderText, false, notice.message_id]);
  });

  it("gets no reminder once the change stopped waiting, and rings when the user is away", async () => {
    const away = connectChat(freshChat());
    const w = world({ atPpm: false });
    const events = setup(w, new Set());
    events.emit("approval_shown", { sessionId: "chat-1", requestId: "r2", input: INPUT, expiresAt: 30 * MIN });
    await fake.waitFor(() => fake.sent(Number(away)).length === 1);
    await w.queue.whenIdle();
    expect(fake.sent(Number(away))[0]!.silent).toBe(false);
    w.advance(5 * MIN);
    await w.queue.whenIdle();
    expect(fake.sent(Number(away))).toHaveLength(1);
  });
});

describe("a card the user asked for with /status", () => {
  it("rings and gets no reminder even while the user is at PPM, unlike the same card sent unasked", async () => {
    const w = world({ atPpm: true });
    const cards = new AssistantTelegramCards({
      queue: w.queue, state: new BridgeStateStore({ offset: 0, chats: {} }), codes: new ButtonCodes<BridgeAction>(), now: Date.now,
      sessionLink: async () => "http://localhost:8080/assistant", chatLink: async () => "http://localhost:8080/x",
      silence: w.silence, reminders: w.reminders,
    });
    const relayed = (requestId: string, askedOnPhone: boolean) => ({
      targetSessionId: "t", targetProject: "api", targetProvider: "claude", targetTitle: "Deploy",
      card: { requestId, tool: "Bash", input: { command: "make deploy" }, isQuestion: false }, ...(askedOnPhone ? { askedOnPhone } : {}),
    });
    const asked = connectChat(freshChat());
    const unasked = connectChat(freshChat());
    cards.relayed(asked, relayed("r-asked", true));
    cards.relayed(unasked, relayed("r-unasked", false));
    await fake.waitFor(() => fake.sent(Number(asked)).length === 1 && fake.sent(Number(unasked)).length === 1);
    await w.queue.whenIdle();
    expect(fake.sent(Number(asked))[0]!.silent).toBe(false);
    expect(fake.sent(Number(unasked))[0]!.silent).toBe(true);
    w.advance(5 * MIN);
    await w.queue.whenIdle();
    expect(fake.sent(Number(asked))).toHaveLength(1);
    expect(pairs(unasked).at(-1)).toEqual([reminderText, false, fake.sent(Number(unasked))[0]!.message_id]);
  });
});

describe("a watch report", () => {
  it("is silent while the user is at PPM, rings while they are away, and is never reminded about", async () => {
    for (const atPpm of [true, false]) {
      getDb().query("DELETE FROM clawbot_paired_chats").run();
      const chat = connectChat(freshChat());
      const w = world({ atPpm });
      const events = watchEvents;
      const relay = new AssistantTelegramRelay({
        queue: w.queue, chatLink: async () => "http://localhost:8080/x", relayCard: () => {},
        boundChats: () => [], providerOf: () => "claude", events, silence: w.silence,
      });
      relay.attach();
      events.emit("watch_reported", {
        watchId: "w", assistantSessionId: "a", targetSessionId: "t", targetProject: "api", targetTitle: "Deploy", kind: "done", text: "All green.",
      });
      await fake.waitFor(() => fake.sent(Number(chat)).length === 1);
      await w.queue.whenIdle();
      relay.detach();
      expect(fake.sent(Number(chat))[0]!.silent).toBe(atPpm);
      w.advance(5 * MIN);
      await w.queue.whenIdle();
      expect(fake.sent(Number(chat))).toHaveLength(1);
    }
  });
});
