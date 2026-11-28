/**
 * The pinned card desk against a fake Bot API, with the real client, send lane and button codes:
 * sent once and pinned, edited in place as cards come and go, its own buttons moving between
 * cards, `/cards` moving it down, a desk the user deleted sent again, a send that may have
 * arrived not repeated, a restart editing the same message, and the cards' codes kept alive.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { TelegramBotClient } from "../../src/services/telegram/telegram-bot-client.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { AssistantTelegramSendQueue } from "../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import { ButtonCodes, CODE_TTL_MS } from "../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction, DeskPress } from "../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { AssistantTelegramCardsDesk, DESK_TICK_MS, DESK_TIMING } from "../../src/services/assistant-telegram/assistant-telegram-cards-desk.ts";
import { memoryCardDeskStore, type CardDeskStore } from "../../src/services/assistant-telegram/assistant-telegram-cards-desk-store.ts";
import { MOVED_DESK_HTML, OFF_DESK_HTML, type DeskEntry } from "../../src/services/assistant-telegram/assistant-telegram-cards-desk-draw.ts";
import { stripTelegramHtml } from "../../src/services/telegram/telegram-html-format.ts";
import type { AssistantClock } from "../../src/services/assistant-wake/assistant-clock.ts";
import { startFakeTelegram } from "../helpers/fake-telegram-bot-api.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

afterAll(() => {
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
});

/** A clock whose timers run when the test says so. */
function manualClock(): AssistantClock & { at: number; fire(): void; advance?(ms: number): void } {
  let timers: Array<() => void> = [];
  return {
    at: 0,
    now() { return this.at; },
    setTimer(fn) { timers.push(fn); return () => { timers = timers.filter((t) => t !== fn); }; },
    fire() { const due = timers; timers = []; for (const fn of due) fn(); },
  };
}

interface Rig {
  chat: number;
  chatId: string;
  desk: AssistantTelegramCardsDesk;
  codes: ButtonCodes<BridgeAction>;
  queue: AssistantTelegramSendQueue;
  clock: ReturnType<typeof manualClock>;
  store: CardDeskStore;
  on: { value: boolean };
  idle(): Promise<void>;
}

let nextChat = 9_100_000;
/** No pacing: every change is drawn at once, so a test sees each one. */
const AT_ONCE = { debounceMs: 0, maxWaitMs: 0, removeDelayMs: 0, minGapMs: 0 };

function rig(opts: {
  store?: CardDeskStore; sendTimeoutMs?: number; chat?: number; on?: boolean; timing?: Partial<typeof AT_ONCE>;
  clock?: ReturnType<typeof manualClock>;
  /** Every wait the send lane takes, as Telegram asked for it (ms). */
  laneWaits?: number[];
  /** How long the lane really sleeps for a wait (default: a thousandth of it). */
  scaleDelay?: (ms: number) => number;
} = {}): Rig {
  const chat = opts.chat ?? nextChat++;
  const clock = opts.clock ?? manualClock();
  clock.at = 10 * 60 * 60_000;
  const client = new TelegramBotClient(fake.token, { editIntervalMs: 0, sleep: async () => {}, ...(opts.sendTimeoutMs ? { sendTimeoutMs: opts.sendTimeoutMs } : {}) });
  const codes = new ButtonCodes<BridgeAction>({ now: () => clock.now() });
  const queue = new AssistantTelegramSendQueue(client, {
    canSend: () => true, scaleDelay: (ms) => { opts.laneWaits?.push(ms); return opts.scaleDelay ? opts.scaleDelay(ms) : ms / 1000; },
  });
  const store = opts.store ?? memoryCardDeskStore();
  const on = { value: opts.on ?? true };
  const desk = new AssistantTelegramCardsDesk({ queue, codes, store, clock, enabled: () => on.value, timing: { ...AT_ONCE, ...opts.timing } });
  return { chat, chatId: String(chat), desk, codes, queue, clock, store, on, idle: () => queue.whenIdle() };
}

/** A card the desk lists, with an Allow minted in the card's own group, as the card modules do. */
function card(r: Rig, n: number, over: Partial<DeskEntry> & { waiting?: { value: boolean } } = {}): DeskEntry {
  const group = `card:${r.chatId}|req-${n}`;
  const allow = { text: "Allow", callback_data: r.codes.mint(r.chatId, group, { kind: "card", sessionId: "s", requestId: `req-${n}`, op: "allow" }) };
  const waiting = over.waiting ?? { value: true };
  return {
    key: `card:req-${n}`, icon: "🔐", project: "nxsys", title: `Deploy ${n}`, since: r.clock.now() - n * 60_000,
    messageId: 50 + n, stillWaiting: () => waiting.value,
    view: () => ({ html: `🔐 <b>Allow deploy ${n}?</b>`, rows: [[allow]] }), groups: [group], ...over,
  };
}

const deskMessages = (r: Rig) => fake.sent(r.chat).filter((m) => m.text.startsWith("🔔") || m.text.startsWith("✅"));
const visible = (r: Rig, id: number) => fake.sent(r.chat).find((m) => m.message_id === id)!;
const buttonTexts = (r: Rig, id: number) => fake.buttons(r.chat, id).map((row) => row.map((b) => b.text));

/** Presses one of the desk's own buttons the way the inbound router does. */
function pressDesk(r: Rig, id: number, text: string): string {
  const data = fake.buttons(r.chat, id).flat().find((b) => b.text === text)?.callback_data;
  const found = r.codes.peek(data, r.chatId);
  if (!found.ok || found.action.kind !== "desk") return "This button is no longer valid.";
  return r.desk.press(r.chatId, found.action as DeskPress, found.group);
}

describe("the pinned card desk", () => {
  let r: Rig;
  beforeEach(() => { r = rig(); });

  it("is sent once, silently, pinned, and lists every card with the oldest shown whole", async () => {
    // Cards arrive oldest first, as they do: the higher the number, the longer it has waited.
    r.desk.put(r.chatId, card(r, 3));
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const desks = deskMessages(r);
    expect(desks.length).toBe(1);
    const desk = desks[0]!;
    expect(desk.silent).toBe(true);
    expect(fake.pins(r.chat)).toEqual([desk.message_id]);
    expect(r.store.get(r.chatId)).toBe(desk.message_id);
    expect(desk.text).toContain("Waiting for you (2)");
    expect(desk.text).toContain("▸ 1. 🔐 nxsys · Deploy 3 3m");
    expect(desk.text).toContain("Allow deploy 3?");
    expect(buttonTexts(r, desk.message_id)).toEqual([["Allow"], ["• 1 •", "2"], ["↩ Go to the card's message"]]);
    // The Allow on the desk is the card's own code: pressing it is pressing the card.
    const allow = fake.buttons(r.chat, desk.message_id)[0]![0]!.callback_data;
    expect(r.codes.peek(allow, r.chatId)).toMatchObject({ ok: true, action: { kind: "card", requestId: "req-3", op: "allow" } });
  });

  it("moves between cards with its own buttons, and a press on an older version is no longer valid", async () => {
    r.desk.put(r.chatId, card(r, 2));
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const id = deskMessages(r)[0]!.message_id;
    const stale = fake.buttons(r.chat, id).flat().find((b) => b.text === "2")!.callback_data;
    expect(pressDesk(r, id, "2")).toBe("2 of 2");
    await r.idle();
    expect(visible(r, id).text).toContain("Allow deploy 1?");
    expect(buttonTexts(r, id)[1]).toEqual(["1", "• 2 •"]);
    expect(r.codes.peek(stale, r.chatId).ok).toBe(false);
    // Edited in place: still one desk, still the one pinned.
    expect(deskMessages(r).length).toBe(1);
    expect(fake.pins(r.chat)).toEqual([id]);
  });

  it("drops an answered card at once, one that stopped waiting at the next change, and says when nothing is left", async () => {
    const quiet = { value: true };
    r.desk.put(r.chatId, card(r, 3));
    r.desk.put(r.chatId, card(r, 2, { waiting: quiet }));
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const id = deskMessages(r)[0]!.message_id;
    r.desk.remove(r.chatId, "card:req-3");
    await r.idle();
    expect(visible(r, id).text).toContain("Waiting for you (2)");
    // The card that was shown is gone: the one in its place is shown next.
    expect(visible(r, id).text).toContain("Allow deploy 2?");
    quiet.value = false;
    r.desk.changed(r.chatId);
    await r.idle();
    expect(visible(r, id).text).toContain("Waiting for you (1)");
    expect(buttonTexts(r, id)).toEqual([["Allow"], ["↩ Go to the card's message"]]);
    r.desk.remove(r.chatId, "card:req-1");
    await r.idle();
    expect(visible(r, id).text).toStartWith("✅ Nothing is waiting for you.");
    expect(fake.buttons(r.chat, id)).toEqual([]);
    expect(fake.pins(r.chat)).toEqual([id]);
  });

  it("keeps showing the card being read when another one arrives, even an urgent one", async () => {
    r.desk.put(r.chatId, card(r, 2));
    await r.idle();
    const id = deskMessages(r)[0]!.message_id;
    r.desk.put(r.chatId, card(r, 9, { urgent: true, icon: "⚠️", title: "Prod down" }));
    await r.idle();
    expect(visible(r, id).text).toContain("Waiting for you (2)");
    expect(visible(r, id).text).toContain("1. ⚠️ nxsys · Prod down");
    expect(visible(r, id).text).toContain("Allow deploy 2?");
  });

  it("skips a draw that would change nothing", async () => {
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const edits = () => fake.calls.filter((c) => c.method === "editMessageText" && Number(c.body.chat_id) === r.chat).length;
    const before = edits();
    r.desk.changed(r.chatId);
    r.desk.changed(r.chatId);
    await r.idle();
    expect(edits()).toBe(before);
  });

  it("takes a reply to the desk as a reply to the card it shows", async () => {
    r.desk.put(r.chatId, card(r, 4));
    await r.idle();
    const id = deskMessages(r)[0]!.message_id;
    // Written a while after the card came up by itself: it answers that card.
    expect(r.desk.replyFor(r.chatId, id, { sentAt: r.clock.now() + 5_000, text: "go" })).toEqual({ to: 54, key: "card:req-4", why: "one card shown" });
    // Written before the list showed anything: nothing was seen, so the words are kept and the user asked.
    expect(r.desk.replyFor(r.chatId, id, { sentAt: r.clock.now() - 5_000, text: "go" }))
      .toEqual({ ask: [{ key: "card:req-4", label: "🔐 nxsys · Deploy 4" }], ended: [] });
    expect(r.desk.replyFor(r.chatId, id + 1000, { sentAt: r.clock.now(), text: "go" })).toBeNull();
  });

  it("goes to the card's own message with a line quoting it", async () => {
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const id = deskMessages(r)[0]!.message_id;
    expect(pressDesk(r, id, "↩ Go to the card's message")).toBe("Tap the quote to go to the card.");
    await r.idle();
    const line = fake.sent(r.chat).at(-1)!;
    expect(line.reply_to).toBe(51);
    expect(line.text).toContain("Deploy 1");
  });

  it("/cards moves it to the bottom: the old one unpinned and pointing down, the new one pinned", async () => {
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const old = deskMessages(r)[0]!.message_id;
    expect(r.desk.resend(r.chatId)).toBeNull();
    await r.idle();
    expect(visible(r, old).text).toBe(stripTelegramHtml(MOVED_DESK_HTML));
    expect(fake.buttons(r.chat, old)).toEqual([]);
    const now = r.store.get(r.chatId)!;
    expect(now).toBeGreaterThan(old);
    expect(fake.pins(r.chat)).toEqual([now]);
    expect(visible(r, now).text).toContain("Allow deploy 1?");
  });

  it("/cards with nothing waiting says so and sends nothing", async () => {
    expect(r.desk.resend(r.chatId)).toBe("✅ Nothing is waiting for you.");
    await r.idle();
    expect(fake.sent(r.chat)).toEqual([]);
  });

  it("sends a new desk and pins it when the user deleted the old one", async () => {
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const old = deskMessages(r)[0]!.message_id;
    const client = new TelegramBotClient(fake.token, { editIntervalMs: 0 });
    expect((await client.deleteMessage(r.chat, old)).ok).toBe(true);
    r.desk.put(r.chatId, card(r, 2));
    await r.idle();
    const now = r.store.get(r.chatId)!;
    expect(now).not.toBe(old);
    expect(fake.pins(r.chat)).toContain(now);
    expect(visible(r, now).text).toContain("Waiting for you (2)");
  });

  it("is never sent while switched off, and comes down when switched off", async () => {
    r.on.value = false;
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    expect(fake.sent(r.chat)).toEqual([]);
    expect(r.desk.messageOf(r.chatId)).toBeNull();
    r.on.value = true;
    await r.desk.refresh();
    await r.idle();
    const id = deskMessages(r)[0]!.message_id;
    expect(r.desk.messageOf(r.chatId)).toBe(id);
    r.on.value = false;
    await r.desk.refresh();
    await r.idle();
    expect(visible(r, id).text).toBe(stripTelegramHtml(OFF_DESK_HTML));
    expect(fake.pins(r.chat)).toEqual([]);
    expect(r.store.get(r.chatId)).toBeNull();
  });
});

describe("the pinned card desk, after review", () => {
  it("routes a reply at once to the card the user moved to by pressing, and one to a moved desk by what it showed", async () => {
    const r = rig();
    r.desk.put(r.chatId, card(r, 2));
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const id = deskMessages(r)[0]!.message_id;
    r.desk.pressedOn(r.chatId, id);
    expect(pressDesk(r, id, "2")).toBe("2 of 2");
    await r.idle();
    expect(r.desk.replyFor(r.chatId, id, { sentAt: r.clock.now(), text: "ok" })).toMatchObject({ to: 51 });
    expect(r.desk.resend(r.chatId)).toBeNull();
    await r.idle();
    // A reply to the list /cards moved down answers what that list showed.
    expect(r.desk.replyFor(r.chatId, id, { sentAt: r.clock.now() + 120_000, text: "ok" })).toMatchObject({ to: 51 });
  });

  it("records and pins nothing when the bridge stops while the desk is on its way", async () => {
    const r = rig();
    fake.delayNextAnswer("sendMessage", 400);
    r.desk.put(r.chatId, card(r, 1));
    await Bun.sleep(100);
    r.desk.stop();
    await r.idle();
    expect(r.store.get(r.chatId)).toBeNull();
    expect(fake.pins(r.chat)).toEqual([]);
  });

  it("unpins a desk Telegram will not let it edit before sending the new one", async () => {
    const r = rig();
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const old = deskMessages(r)[0]!.message_id;
    fake.failNext("editMessageText", { code: 400, description: "Bad Request: message can't be edited" });
    r.desk.put(r.chatId, card(r, 2));
    await r.idle();
    const now = r.store.get(r.chatId)!;
    expect(now).not.toBe(old);
    expect(fake.pins(r.chat)).toEqual([now]);
  });

  it("keeps drawing when a card's view cannot be read", async () => {
    const r = rig();
    r.desk.put(r.chatId, card(r, 2, { view: () => { throw new Error("broken"); } }));
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    const id = deskMessages(r)[0]!.message_id;
    expect(visible(r, id).text).toContain("cannot be shown here");
    expect(pressDesk(r, id, "2")).toBe("2 of 2");
    await r.idle();
    expect(visible(r, id).text).toContain("Allow deploy 1?");
  });

  it("drops cards that ended while it was switched off, and lists the rest when turned on", async () => {
    const r = rig({ on: false });
    const gone = { value: true };
    r.desk.put(r.chatId, card(r, 2, { waiting: gone }));
    r.desk.put(r.chatId, card(r, 1));
    gone.value = false;
    r.clock.fire();
    await r.desk.refresh();
    await r.idle();
    expect(r.desk.waiting(r.chatId).map((e) => e.key)).toEqual(["card:req-1"]);
    expect(fake.sent(r.chat)).toEqual([]);
    r.on.value = true;
    await r.desk.refresh();
    await r.idle();
    expect(deskMessages(r)[0]!.text).toContain("Waiting for you (1)");
  });
});

/** A clock whose timers run in due order as the test moves time forward. */
function steppingClock(): ReturnType<typeof manualClock> {
  let timers: Array<{ at: number; fn: () => void }> = [];
  const c = {
    at: 0,
    now() { return c.at; },
    setTimer(fn: () => void, ms: number) {
      const t = { at: c.at + Math.max(0, ms), fn };
      timers.push(t);
      return () => { timers = timers.filter((x) => x !== t); };
    },
    fire() { c.advance(0); },
    advance(ms: number) {
      const to = c.at + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= to).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        c.at = due.at;
        due.fn();
      }
      c.at = to;
    },
  };
  return c;
}

describe("the pinned card desk, paced", () => {
  const editCalls = (r: Rig) => fake.calls.filter((c) => c.method === "editMessageText" && Number(c.body.chat_id) === r.chat);
  const edits = (r: Rig) => editCalls(r).filter((c) => !c.failed).length;
  const count = (r: Rig, id: number) => Number(visible(r, id).text.match(/Waiting for you \((\d+)\)/)?.[1] ?? 0);

  /** Moves time on in 100 ms steps, letting each draw reach Telegram, until `ok`; the time it took. */
  async function until(r: Rig, ok: () => boolean, limitMs = 60_000): Promise<number> {
    const start = r.clock.now();
    for (;;) {
      await r.idle();
      if (ok()) return r.clock.now() - start;
      if (r.clock.now() - start >= limitMs) throw new Error(`not within ${limitMs} ms`);
      r.clock.advance!(100);
    }
  }

  /** Lets `ms` pass in 100 ms steps, each draw reaching Telegram on the way. */
  async function pass(r: Rig, ms: number): Promise<void> {
    const end = r.clock.now() + ms;
    while (r.clock.now() < end) {
      r.clock.advance!(100);
      await r.idle();
    }
  }

  /** A desk listing `n` cards (Deploy n shown), drawn, with the clock well past its last edit. */
  async function deskWith(n: number, over: { laneWaits?: number[]; scaleDelay?: (ms: number) => number } = {}): Promise<{ r: Rig; id: number }> {
    const r = rig({ clock: steppingClock(), timing: DESK_TIMING, ...over });
    for (let i = n; i >= 1; i--) r.desk.put(r.chatId, card(r, i));
    await until(r, () => deskMessages(r).length === 1);
    const id = deskMessages(r)[0]!.message_id;
    await pass(r, 10_000);
    return { r, id };
  }

  it("takes an answered card off within two seconds, even right after the last edit", async () => {
    const { r, id } = await deskWith(3);
    r.desk.remove(r.chatId, "card:req-3");
    expect(await until(r, () => count(r, id) === 2)).toBeLessThan(2_000);
    // A second answer straight after that edit still keeps Telegram's pace, and stays under 2 s.
    r.desk.remove(r.chatId, "card:req-2");
    expect(await until(r, () => count(r, id) === 1)).toBeLessThan(2_000);
  });

  it("takes several cards that end together off in one edit", async () => {
    const { r, id } = await deskWith(3);
    const before = edits(r);
    r.desk.remove(r.chatId, "card:req-3");
    r.desk.remove(r.chatId, "card:req-2");
    r.desk.removeEverywhere("card:req-1");
    expect(await until(r, () => visible(r, id).text.startsWith("✅"))).toBeLessThan(2_000);
    expect(edits(r)).toBe(before + 1);
  });

  it("holds a new card a few seconds so a burst is one edit, and never more than five", async () => {
    const { r, id } = await deskWith(1);
    const before = edits(r);
    const from = r.clock.now();
    r.desk.put(r.chatId, card(r, 2));
    // Another card every second: the first one is still shown 5 s after it came, with the ones since.
    let n = 2;
    const shown = await until(r, () => {
      if ((r.clock.now() - from) % 1_000 === 0 && r.clock.now() > from && n < 9) r.desk.put(r.chatId, card(r, ++n));
      return count(r, id) > 1;
    });
    expect(shown).toBeLessThanOrEqual(5_000);
    expect(shown).toBeGreaterThanOrEqual(3_000);
    expect(edits(r)).toBe(before + 1);
  });

  it("shows a lone new card after three seconds", async () => {
    const { r, id } = await deskWith(1);
    r.desk.put(r.chatId, card(r, 2));
    expect(await until(r, () => count(r, id) === 2)).toBe(3_000);
  });

  it("does not let a new card hold back a card that ended", async () => {
    const { r, id } = await deskWith(2);
    r.desk.put(r.chatId, card(r, 3));
    r.clock.advance!(500);
    r.desk.remove(r.chatId, "card:req-2");
    r.desk.put(r.chatId, card(r, 4));
    expect(await until(r, () => !visible(r, id).text.includes("Deploy 2"))).toBeLessThan(2_000);
    expect(visible(r, id).text).toContain("Deploy 4");
  });

  it("keeps editing while the user writes: a reply is matched against what they saw", async () => {
    const { r, id } = await deskWith(2);
    const writingFrom = r.clock.now();
    // While the user writes to the card shown (Deploy 2), a card arrives and is listed.
    r.desk.put(r.chatId, card(r, 3));
    expect(await until(r, () => count(r, id) === 3)).toBeLessThanOrEqual(5_000);
    expect(visible(r, id).text).toContain("Allow deploy 2?");
    await pass(r, 10_000);
    expect(r.desk.replyFor(r.chatId, id, { sentAt: writingFrom + 15_000, text: "go ahead" }))
      .toEqual({ to: 52, key: "card:req-2", why: "one card shown" });
  });

  it("does not hand a reply to the next card when the one the user was reading is answered meanwhile", async () => {
    const { r, id } = await deskWith(2);
    const writingFrom = r.clock.now();
    expect(visible(r, id).text).toContain("Allow deploy 2?");
    // Answered in PPM while the user writes: the desk moves on to Deploy 1 within two seconds.
    r.desk.remove(r.chatId, "card:req-2");
    expect(await until(r, () => visible(r, id).text.includes("Allow deploy 1?"))).toBeLessThan(2_000);
    await pass(r, 8_000);
    const route = r.desk.replyFor(r.chatId, id, { sentAt: writingFrom + 10_000, text: "go ahead" });
    expect(route).toEqual({ ask: [{ key: "card:req-1", label: "🔐 nxsys · Deploy 1" }], ended: [expect.stringContaining("Deploy 2")] });
  });

  it("draws at once what the user does on the list", async () => {
    const { r, id } = await deskWith(2);
    expect(pressDesk(r, id, "2")).toBe("2 of 2");
    await r.idle();
    expect(visible(r, id).text).toContain("Allow deploy 1?");
  });

  it("after a 429 waits what Telegram asked and sends the newest list, not the refused one again", async () => {
    const laneWaits: number[] = [];
    // The lane really sleeps 400 ms for it: long enough to end a second card meanwhile.
    const { r, id } = await deskWith(3, { laneWaits, scaleDelay: (ms) => (ms === 7_000 ? 400 : ms / 1000) });
    fake.failNext("editMessageText", { code: 429, retryAfter: 7 });
    r.desk.remove(r.chatId, "card:req-3");
    // The refused edit is not repeated by the client: the lane waits 7 s.
    r.clock.advance!(300);
    await fake.waitFor(() => editCalls(r).some((c) => c.failed === 429));
    // Another card ends while the lane waits: it rides on the one edit that follows.
    r.desk.remove(r.chatId, "card:req-2");
    await until(r, () => count(r, id) === 1);
    expect(laneWaits).toContain(7_000);
    expect(editCalls(r).slice(-2).map((c) => c.failed ?? "ok")).toEqual([429, "ok"]);
    expect(visible(r, id).history.some((h) => h.includes("Waiting for you (2)"))).toBe(false);
  });

  it("brings the desk up to date at once after a restart", async () => {
    const store = memoryCardDeskStore();
    const first = rig({ store });
    first.desk.put(first.chatId, card(first, 2));
    first.desk.put(first.chatId, card(first, 1));
    await first.idle();
    const id = deskMessages(first)[0]!.message_id;
    first.desk.stop();
    // Deploy 2 ended while PPM was down; the new process draws with the real pacing.
    const second = rig({ store, chat: first.chat, clock: steppingClock(), timing: DESK_TIMING });
    second.desk.put(second.chatId, card(second, 1));
    await second.desk.start([second.chatId]);
    expect(await until(second, () => count(second, id) === 1)).toBe(0);
    second.desk.stop();
  });
});

describe("the pinned card desk, over time", () => {
  it("keeps the listed cards' codes alive past their day, and brings ages up to date", async () => {
    const r = rig();
    r.desk.put(r.chatId, card(r, 1));
    await r.desk.start([]);
    await r.idle();
    const id = deskMessages(r)[0]!.message_id;
    const allow = fake.buttons(r.chat, id)[0]![0]!.callback_data;
    r.clock.at += CODE_TTL_MS - DESK_TICK_MS;
    r.clock.fire();
    await r.idle();
    expect(visible(r, id).text).toContain("23h");
    r.clock.at += 2 * DESK_TICK_MS;
    expect(r.codes.peek(allow, r.chatId).ok).toBe(true);
    r.desk.stop();
  });

  it("after a restart edits the same message, with nothing new sent", async () => {
    const store = memoryCardDeskStore();
    const first = rig({ store });
    first.desk.put(first.chatId, card(first, 1));
    await first.idle();
    const id = deskMessages(first)[0]!.message_id;
    first.desk.stop();

    const second = rig({ store, chat: first.chat });
    second.desk.put(second.chatId, card(second, 2));
    await second.desk.start([]);
    await second.idle();
    expect(deskMessages(second).map((m) => m.message_id)).toEqual([id]);
    expect(visible(second, id).text).toContain("Allow deploy 2?");
    second.desk.stop();
  });

  it("does not send a desk again that may have arrived: its buttons die, and the next change sends a fresh one", async () => {
    const r = rig({ sendTimeoutMs: 200 });
    fake.delayNextAnswer("sendMessage", 800);
    r.desk.put(r.chatId, card(r, 1));
    await r.idle();
    await Bun.sleep(900);
    const arrived = deskMessages(r);
    expect(arrived.length).toBe(1);
    expect(r.store.get(r.chatId)).toBeNull();
    expect(fake.pins(r.chat)).toEqual([]);
    expect(pressDesk(r, arrived[0]!.message_id, "↩ Go to the card's message")).toBe("This button is no longer valid.");
    r.desk.put(r.chatId, card(r, 2));
    await r.idle();
    const desks = deskMessages(r);
    expect(desks.length).toBe(2);
    expect(fake.pins(r.chat)).toEqual([desks[1]!.message_id]);
  });
});
