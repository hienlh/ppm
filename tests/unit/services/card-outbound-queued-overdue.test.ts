/**
 * The outbound gate for cards a chat is stopped on: one queued behind another card of its chat
 * goes to the phone only once it reaches the front, and one left unanswered too long rings once
 * more — or, never sent, is sent now. A schedule's stuck chat rings through quiet hours.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { getCardRow } from "../../../src/services/assistant-cards/assistant-cards-db.ts";
import { listHeldCardRows, listUnsentWaitingCardRows, setCardOutbound } from "../../../src/services/assistant-cards/assistant-cards-outbound-db.ts";
import { createCardOutbound, type CardOutboundSink } from "../../../src/services/assistant-cards/card-outbound.ts";
import type { AssistantCardPayload } from "../../../src/shared/assistant-cards.ts";

let now = Date.UTC(2026, 10, 24, 12, 0, 0);
let quietUntil: number | null = null;
const cards = createAssistantCards({ now: () => now, projects: () => [{ name: "api", path: "/p/api" }], announce: () => {} });
const sent: string[][] = [];
const reminded: string[] = [];
let ready = true;
const sink: CardOutboundSink = {
  ready: () => ready,
  send: (list) => sent.push(list.map((c) => c.id)),
  changed: () => {},
  overdue: (card) => reminded.push(card.id),
};
const gate = createCardOutbound({
  cards,
  clock: { now: () => now, setTimer: () => () => {} },
  quietEnd: () => (quietUntil !== null && now < quietUntil ? quietUntil : null),
  held: listHeldCardRows,
  unsentWaiting: listUnsentWaitingCardRows,
  row: getCardRow,
  setOutbound: (id, o, at) => { setCardOutbound(id, o, at); },
});
const approval = (payload: AssistantCardPayload) =>
  cards.create({ kind: "approval", projectName: "api", projectPath: "/p/api", sessionId: "chat-1", title: "Open a chat", payload });
const outbound = (id: string) => getCardRow(id)!.outbound;

beforeEach(() => {
  gate.detach();
  getDb().run("DELETE FROM assistant_cards");
  sent.length = 0; reminded.length = 0; quietUntil = null; ready = true;
  gate.attach(sink);
});

describe("a card queued behind another of its chat", () => {
  it("is not sent while queued, nor by the catch-up for cards that never went out", () => {
    const c = approval({ requestId: "r2", queued: true });
    expect(sent).toEqual([]);
    expect(outbound(c.id)).toBe("pending");
    gate.catchUp();
    expect(sent).toEqual([]);
  });

  it("goes out once it reaches the front, and only once", () => {
    const c = approval({ requestId: "r2", queued: true });
    cards.patchPayload(c.id, { queued: undefined }, "shown");
    expect(sent).toEqual([[c.id]]);
    expect(outbound(c.id)).toBe("sent");
    expect(getCardRow(c.id)!.payload.queued).toBeUndefined();
    cards.patchPayload(c.id, {}, "shown");
    expect(sent).toEqual([[c.id]]);
  });
});

describe("a card left unanswered too long", () => {
  it("rings once more when it was already sent", () => {
    const c = approval({ requestId: "r1" });
    cards.patchPayload(c.id, { waitingSince: now - 3 * 60_000 }, "overdue");
    expect(reminded).toEqual([c.id]);
  });

  it("is sent now when nothing could carry it when it was made", () => {
    ready = false;
    const c = approval({ requestId: "r1" });
    expect(outbound(c.id)).toBe("skipped");
    ready = true;
    cards.patchPayload(c.id, { waitingSince: now }, "overdue");
    expect(sent).toEqual([[c.id]]);
    expect(reminded).toEqual([]);
  });

  it("waits for quiet hours to end, unless a schedule's chat is stuck on it", () => {
    quietUntil = now + 6 * 60 * 60_000;
    const held = approval({ requestId: "r1" });
    expect(outbound(held.id)).toBe("held");
    cards.patchPayload(held.id, { waitingSince: now }, "overdue");
    expect(sent).toEqual([]);
    cards.patchPayload(held.id, { scheduledTurn: true }, "overdue");
    expect(sent).toEqual([[held.id]]);
  });

  it("is not reminded about once it stopped waiting", () => {
    const c = approval({ requestId: "r1" });
    cards.transition(c.id, "resolved", { by: "user", channel: "chat", at: now });
    expect(cards.patchPayload(c.id, { waitingSince: now }, "overdue")).toBeNull();
    expect(reminded).toEqual([]);
  });
});
