/**
 * Cards on their way to the phone: sent at once outside quiet hours, held inside them (all but an
 * urgent card), and sent after one "While you were away" header when the window ends — skipping
 * cards that stopped waiting. Also the window's end across midnight and a clock change, and the
 * (chat, message) pairs a reply is matched on.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { getCardRow } from "../../../src/services/assistant-cards/assistant-cards-db.ts";
import {
  addCardTelegramRef, findCardByTelegramRef, listHeldCardRows, setCardOutbound,
} from "../../../src/services/assistant-cards/assistant-cards-outbound-db.ts";
import { awayHeader, createCardOutbound, type CardOutboundSink } from "../../../src/services/assistant-cards/card-outbound.ts";
import { quietWindowEnd } from "../../../src/services/assistant-wake/wake-quiet-hours.ts";
import type { AssistantCard } from "../../../src/shared/assistant-cards.ts";

let now = Date.UTC(2026, 10, 10, 15, 0, 0);
let quietUntil: number | null = null;
const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
const advance = (ms: number) => {
  now += ms;
  for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); }
};
const cards = createAssistantCards({ now: () => now, projects: () => [{ name: "api", path: "/p/api" }], announce: () => {} });
const sent: Array<{ ids: string[]; header?: string }> = [];
const changed: AssistantCard[] = [];
let ready = true;
const sink: CardOutboundSink = {
  ready: () => ready,
  send: (list, header) => sent.push({ ids: list.map((c) => c.id), ...(header ? { header } : {}) }),
  changed: (card) => changed.push(card),
};
const gate = createCardOutbound({
  cards,
  clock: { now: () => now, setTimer: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } },
  quietEnd: () => (quietUntil !== null && now < quietUntil ? quietUntil : null),
  held: listHeldCardRows,
  row: getCardRow,
  setOutbound: (id, o, at) => { setCardOutbound(id, o, at); },
});
const card = (kind: AssistantCard["kind"], title: string) =>
  cards.create({ kind, projectName: "api", projectPath: "/p/api", sessionId: "mgr", title });
const outbound = (id: string) => getCardRow(id)!.outbound;

beforeEach(() => {
  gate.detach();
  getDb().run("DELETE FROM assistant_cards");
  sent.length = 0; changed.length = 0; timers.length = 0; quietUntil = null; ready = true;
  gate.attach(sink);
});

describe("the outbound gate", () => {
  it("sends a card at once outside quiet hours, and tells the phone when it stops waiting", () => {
    const c = card("needs_decision", "Ship it?");
    expect(sent).toEqual([{ ids: [c.id] }]);
    expect(outbound(c.id)).toBe("sent");
    cards.transition(c.id, "dismissed", { by: "user", channel: "ppm", at: now });
    expect(changed.map((x) => x.status)).toEqual(["dismissed"]);
  });

  it("holds every card but an urgent one in quiet hours, then sends one header and the held cards, skipping gone ones", () => {
    quietUntil = now + 8 * 60 * 60_000;
    const done = card("done", "Nightly done");
    const urgent = card("urgent", "Prod down");
    const decision = card("needs_decision", "Third urgent, held as a decision");
    const approval = cards.create({ kind: "approval", projectName: "api", projectPath: "/p/api", sessionId: "mgr", title: "Bash", payload: { requestId: "r1" } });
    expect(sent).toEqual([{ ids: [urgent.id] }]);
    expect([done, decision, approval].map((c) => outbound(c.id))).toEqual(["held", "held", "held"]);
    cards.transition(approval.id, "gone", { by: "ppm", channel: "ppm", at: now, note: "No longer waiting" });
    advance(8 * 60 * 60_000);
    expect(sent.at(-1)).toEqual({ ids: [done.id, decision.id], header: awayHeader(2) });
    expect(outbound(approval.id)).toBe("skipped");
    expect(outbound(done.id)).toBe("sent");
  });

  it("sends what a window that ended while the bridge was down held, when it starts again", () => {
    quietUntil = now + 60_000;
    const c = card("failed", "Deploy failed");
    gate.detach(sink);
    advance(2 * 60_000);
    expect(sent).toEqual([]);
    gate.attach(sink);
    expect(sent).toEqual([{ ids: [c.id], header: awayHeader(1) }]);
  });

  it("skips a card no chat can see", () => {
    ready = false;
    expect(outbound(card("done", "x").id)).toBe("skipped");
  });
});

describe("when a quiet window ends", () => {
  const night = { enabled: true, start: "22:00", end: "07:00" };
  it("runs past midnight to the end time in the user's zone", () => {
    const at = Date.UTC(2026, 10, 10, 16, 30); // 23:30 in Asia/Saigon
    expect(new Date(quietWindowEnd(at, night, "Asia/Saigon")!).toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(quietWindowEnd(Date.UTC(2026, 10, 10, 5, 0), night, "Asia/Saigon")).toBeNull(); // 12:00
  });

  it("ends at the same wall-clock time across a change to summer time", () => {
    const at = Date.UTC(2026, 2, 28, 23, 0); // 23:00 GMT; the clocks go forward at 01:00
    expect(new Date(quietWindowEnd(at, night, "Europe/London")!).toISOString()).toBe("2026-03-29T06:00:00.000Z"); // 07:00 BST
  });

  it("handles a window inside one day", () => {
    const day = { enabled: true, start: "12:00", end: "13:30" };
    expect(new Date(quietWindowEnd(Date.UTC(2026, 10, 10, 12, 10), day, "UTC")!).toISOString()).toBe("2026-11-10T13:30:00.000Z");
  });
});

describe("matching a reply to a card", () => {
  it("matches on the chat and the message id together", () => {
    const c = card("needs_decision", "Reply to me");
    addCardTelegramRef(c.id, { chatId: "100", messageId: 7 });
    addCardTelegramRef(c.id, { chatId: "100", messageId: 7 });
    expect(getCardRow(c.id)!.telegramRefs).toEqual([{ chatId: "100", messageId: 7 }]);
    expect(findCardByTelegramRef("100", 7)?.id).toBe(c.id);
    expect(findCardByTelegramRef("200", 7)).toBeNull();
    expect(findCardByTelegramRef("100", 8)).toBeNull();
  });
});
