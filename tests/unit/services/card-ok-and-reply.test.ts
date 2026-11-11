/**
 * The user's OK and own reply on PPM Assistant cards: OK only where the whole decision is shown and
 * nothing hidden, tied to the draft's hash, first OK wins on every surface; a reply to a stale or
 * closed card asks first; a reply to an approval refuses that request; a failed forward opens the
 * card again.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { cardOkOffered } from "../../../src/services/assistant-cards/card-ok-rule.ts";
import { okCard, replyToCard, type CardReplyDeps } from "../../../src/services/assistant-cards/card-reply-actions.ts";
import type { ForwardHow, ForwardResult } from "../../../src/services/assistant-cards/forward-verbatim.ts";
import { createCardDelivery, NOT_DELIVERED_NOTE } from "../../../src/services/assistant-cards/card-delivery.ts";
import { listUndeliveredAnswerRows } from "../../../src/services/assistant-cards/assistant-cards-db.ts";
import { STALE_REPLY_MS } from "../../../src/shared/assistant-limits.ts";
import type { AssistantCard } from "../../../src/shared/assistant-cards.ts";

let now = Date.UTC(2026, 10, 10, 8, 0, 0);
const cards = createAssistantCards({ now: () => now, projects: () => [{ name: "nxsys", path: "/p/nxsys" }], announce: () => {} });
const forwards: Array<{ card: AssistantCard; text: string; how: ForwardHow }> = [];
let fail: string | null = null;
const deps: CardReplyDeps = {
  cards, now: () => now, zone: () => "Asia/Saigon",
  forward: async (card, text, how): Promise<ForwardResult> => {
    if (fail) return { ok: false, error: fail };
    forwards.push({ card, text, how });
    return { ok: true, to: "manager", projectName: "nxsys", sessionId: "mgr" };
  },
};
const web = { channel: "ppm" as const, deviceId: "dev-1" };
const phone = { channel: "telegram" as const, telegramChatId: "42" };
const SHA = "b".repeat(64);

function decision(draftText = "Anh Top ơi, fix xong rồi.", body = "Pension wrong in period 32.") {
  return cards.create({
    kind: "needs_decision", projectName: "nxsys", projectPath: "/p/nxsys", sessionId: "mgr", title: "Slack draft to Top", body,
    payload: { draft: { to: "#culi-devs", text: draftText, sha256: SHA } },
  });
}

beforeEach(() => { getDb().run("DELETE FROM assistant_cards"); forwards.length = 0; fail = null; now += 60_000; });

describe("the OK rule", () => {
  it("is offered when the whole decision fits and nothing is hidden", () => {
    expect(decision().okOffered).toBe(true);
    expect(cardOkOffered({ kind: "done", title: "x", body: "", payload: {} })).toBe(false);
  });

  it("is not offered for a 4000-character draft, or one with a secret in it", () => {
    expect(decision("x".repeat(4000)).okOffered).toBeUndefined();
    expect(decision("key AKIAABCDEFGHIJKLMNOP for the bucket").okOffered).toBeUndefined();
  });
});

describe("OK", () => {
  it("forwards once, with the draft's hash; a second OK from another surface is told who answered", async () => {
    const card = decision();
    const first = await okCard(card.id, { draftSha256: SHA }, phone, deps);
    expect(first.ok).toBe(true);
    expect(forwards).toHaveLength(1);
    expect(forwards[0]!).toMatchObject({ text: "OK", how: { ok: true, draftSha256: SHA, draftTo: "#culi-devs", supersede: false } });
    const second = await okCard(card.id, { draftSha256: SHA }, web, deps);
    expect(second).toMatchObject({ ok: false, status: 409, error: "already_answered" });
    expect(!second.ok && second.question).toMatch(/^Already answered on Telegram at \d\d:\d\d\.$/);
    expect(forwards).toHaveLength(1);
  });

  it("refuses an OK for another draft, and one on a card that does not offer it", async () => {
    expect(await okCard(decision().id, { draftSha256: "c".repeat(64) }, web, deps)).toMatchObject({ ok: false, status: 409 });
    expect(await okCard(decision("x".repeat(4000)).id, { draftSha256: SHA }, web, deps)).toMatchObject({ ok: false, status: 400 });
    expect(forwards).toHaveLength(0);
  });

  it("opens the card again when the words could not be delivered", async () => {
    const card = decision();
    fail = "The session is still starting";
    const res = await okCard(card.id, { draftSha256: SHA }, web, deps);
    expect(res).toMatchObject({ ok: false, status: 502 });
    expect(cards.get(card.id)!.status).toBe("open");
  });
});

describe("delivery of the words", () => {
  const timers: Array<() => void> = [];
  const delivery = () => createCardDelivery({
    cards, undelivered: listUndeliveredAnswerRows, canonical: (id) => id,
    clock: { setTimer: (fn) => { timers.push(fn); return () => {}; } },
  });
  const queuedDeps = (clientMessageId: string): CardReplyDeps => ({
    ...deps,
    forward: async (card, text, how) => {
      forwards.push({ card, text, how });
      return { ok: true, to: "manager", projectName: "nxsys", sessionId: "mgr", delivered: "queued", clientMessageId };
    },
  });

  it("is settled at once for words that started or joined a turn", async () => {
    const card = decision();
    await okCard(card.id, { draftSha256: SHA }, web, deps);
    expect(cards.get(card.id)!.answer).toMatchObject({ ok: true, delivery: "delivered" });
  });

  it("stays pending for words queued behind an approval until the turn opens with them", async () => {
    const tracker = delivery();
    const card = decision();
    await okCard(card.id, { draftSha256: SHA }, phone, queuedDeps("card-1"));
    expect(cards.get(card.id)!.answer).toMatchObject({ delivery: "pending", clientMessageId: "card-1", deliveredTo: "mgr" });
    tracker.turnEnded("mgr");
    tracker.turnBound("card-1");
    expect(cards.get(card.id)!.answer?.delivery).toBe("delivered");
    for (const fire of timers.splice(0)) fire();
    expect(cards.get(card.id)!.status).toBe("answered");
  });

  it("opens the card again, saying so, when the queued words die with the turn they waited on", async () => {
    const tracker = delivery();
    const card = decision();
    await replyToCard(card.id, { text: "send it after lunch" }, phone, queuedDeps("card-2"));
    tracker.turnEnded("mgr");
    for (const fire of timers.splice(0)) fire();
    expect(cards.get(card.id)).toMatchObject({ status: "open", answer: { note: NOT_DELIVERED_NOTE } });
    // Open again for real: a new OK goes through.
    expect((await okCard(card.id, { draftSha256: SHA }, web, deps)).ok).toBe(true);
  });

  it("opens every card still pending at startup: a restart loses what was queued or never sent", () => {
    const card = decision();
    cards.transition(card.id, "answered", { by: "user", channel: "telegram", at: now, ok: true, delivery: "pending" });
    delivery().sweep();
    expect(cards.get(card.id)).toMatchObject({ status: "open", answer: { note: NOT_DELIVERED_NOTE } });
  });
});

describe("a reply", () => {
  it("is forwarded word for word and answers the card", async () => {
    const card = decision();
    const text = "Sửa “chiều nay” thành “sáng mai” 👍";
    const res = await replyToCard(card.id, { text }, phone, deps);
    expect(res).toMatchObject({ ok: true, to: "manager" });
    expect(forwards[0]!.text).toBe(text);
    expect(cards.get(card.id)).toMatchObject({ status: "answered", answer: { channel: "telegram", note: "You replied on Telegram" } });
  });

  it("asks first on a card answered already, then sends when told to, leaving the card as it was", async () => {
    const card = decision();
    await okCard(card.id, { draftSha256: SHA }, web, deps);
    const asked = await replyToCard(card.id, { text: "also cc QA" }, phone, deps);
    expect(asked).toMatchObject({ ok: false, status: 409, error: "confirm" });
    expect(!asked.ok && asked.question).toMatch(/^This card was answered at .* — send anyway\?$/);
    const forced = await replyToCard(card.id, { text: "also cc QA", force: true }, phone, deps);
    expect(forced.ok).toBe(true);
    expect(forwards.at(-1)!).toMatchObject({ text: "also cc QA", how: { supersede: false } });
    expect(cards.get(card.id)!.answer?.ok).toBe(true);
  });

  it("asks first on a card older than a day", async () => {
    const card = decision();
    now += STALE_REPLY_MS + 1;
    expect(await replyToCard(card.id, { text: "late" }, web, deps)).toMatchObject({ ok: false, error: "confirm" });
    expect(forwards).toHaveLength(0);
  });

  it("refuses the request of an approval card it answers", async () => {
    const card = cards.create({
      kind: "approval", projectName: "nxsys", projectPath: "/p/nxsys", sessionId: "mgr", title: "Bash",
      payload: { requestId: "req-1", deciding: { kind: "command", title: "Bash", facts: [], text: "npm publish", complete: true } },
    });
    expect((await replyToCard(card.id, { text: "not yet, run the tests first" }, phone, deps)).ok).toBe(true);
    expect(forwards[0]!.how.supersede).toBe(true);
  });

  it("is refused from PPM on a card with no manager chat, and checked for size", async () => {
    const rules = cards.create({ kind: "rules_change", projectName: "nxsys", projectPath: "/p/nxsys", sessionId: null, title: "Rules change" });
    expect(await replyToCard(rules.id, { text: "fine" }, web, deps)).toMatchObject({ ok: false, status: 400 });
    expect(await replyToCard(decision().id, { text: "x".repeat(9000) }, web, deps)).toMatchObject({ ok: false, status: 400 });
    expect(await replyToCard(decision().id, { text: "   " }, web, deps)).toMatchObject({ ok: false, status: 400 });
  });
});
