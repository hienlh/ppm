/**
 * The set of decisions as data: what each card offers, when a pick is taken back (the card
 * changed), what "Send all" sends, and how sending one card or all of them reads the server's
 * answers — sent, answered elsewhere, "send anyway?", a draft that is no longer the one picked.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantCard } from "../../../src/shared/assistant-cards";
import {
  answerIsReady, answerLabel, cardVersion, currentPick, decisionTiles, isStaleForReply, nextTabOrder,
  outdatedPicks, projectCounts, sendPlan, type DecisionAnswer, type DecisionPick,
} from "../../../src/web/lib/decision-set/decision-set-model";
import { sendAllDecisions, sendDecision, type DecisionSendApi } from "../../../src/web/lib/decision-set/decision-set-send";

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;

function card(id: string, over: Partial<AssistantCard> = {}, payload: AssistantCard["payload"] = {}): AssistantCard {
  return {
    id, kind: "needs_decision", projectName: "alpha", projectKey: "alpha", sessionId: `s-${id}`,
    title: `Card ${id}`, body: "", payload, status: "open", answer: null, provenance: null,
    okOffered: true, createdAt: NOW - 60_000, updatedAt: NOW - 60_000, ...over,
  };
}

const withOptions = card("o", {}, { options: [{ id: "tonight", label: "Ship tonight" }, { id: "monday", label: "Wait until Monday" }] });
const withDraft = card("d", {}, { draft: { to: "#alpha-team", text: "Weekly status\n• done", sha256: "a".repeat(64) } });
const plain = card("p", { kind: "urgent", projectName: "beta" });
const pickOf = (c: AssistantCard, answer: DecisionAnswer): DecisionPick => ({ answer, version: cardVersion(c) });

describe("what a card offers", () => {
  it("one tile per choice, an OK bound to the draft's hash, or a plain OK", () => {
    expect(decisionTiles(withOptions).map((t) => t.answer)).toEqual([{ kind: "choose", optionId: "tonight" }, { kind: "choose", optionId: "monday" }]);
    expect(decisionTiles(withDraft)).toEqual([expect.objectContaining({ answer: { kind: "ok", draftSha256: "a".repeat(64) }, draftSha256: "a".repeat(64) })]);
    expect(decisionTiles(plain).map((t) => t.answer)).toEqual([{ kind: "ok", draftSha256: null }]);
  });

  it("nothing to press on a card the server does not show whole: words only", () => {
    const hidden = { ...withDraft, okOffered: false };
    expect(decisionTiles(hidden)).toEqual([]);
    expect(answerIsReady(hidden, { kind: "ok", draftSha256: "a".repeat(64) })).toBe(false);
    expect(answerIsReady(hidden, { kind: "reply", text: "change the second line", images: [] })).toBe(true);
  });

  it("a reply needs words or a picture, and a manager chat to go to", () => {
    expect(answerIsReady(plain, { kind: "reply", text: "  ", images: [] })).toBe(false);
    expect(answerIsReady(plain, { kind: "reply", text: "", images: [{ id: "1", name: "a.png", data: "AA==", mediaType: "image/png" }] })).toBe(true);
    expect(answerIsReady({ ...plain, sessionId: null }, { kind: "reply", text: "yes", images: [] })).toBe(false);
  });

  it("an OK that names another draft is not ready", () => {
    expect(answerIsReady(withDraft, { kind: "ok", draftSha256: "b".repeat(64) })).toBe(false);
    expect(answerIsReady(withOptions, { kind: "choose", optionId: "friday" })).toBe(false);
  });
});

describe("a stale draft", () => {
  it("a pick made before the card changed is no longer current, and is named to be cleared", () => {
    const picks = { d: pickOf(withDraft, { kind: "ok", draftSha256: "a".repeat(64) }) };
    const redrafted: AssistantCard = {
      ...withDraft, updatedAt: withDraft.updatedAt + 1000,
      payload: { draft: { to: "#alpha-team", text: "Weekly status\n• done\n• more", sha256: "c".repeat(64) } },
    };
    expect(currentPick(withDraft, picks)).not.toBeNull();
    expect(currentPick(redrafted, picks)).toBeNull();
    expect(outdatedPicks([redrafted], picks)).toEqual(["d"]);
    expect(sendPlan([redrafted], picks)).toEqual([]);
  });

  it("a change the user cannot see (the card's updatedAt alone) keeps the pick", () => {
    const picks = { d: pickOf(withDraft, { kind: "ok", draftSha256: "a".repeat(64) }) };
    const touched = { ...withDraft, updatedAt: withDraft.updatedAt + 60_000 };
    expect(currentPick(touched, picks)).not.toBeNull();
    expect(outdatedPicks([touched], picks)).toEqual([]);
  });

  it("a new recipient for the same draft text is a change", () => {
    const picks = { d: pickOf(withDraft, { kind: "ok", draftSha256: "a".repeat(64) }) };
    const elsewhere = { ...withDraft, payload: { draft: { ...withDraft.payload.draft!, to: "#all-hands" } } };
    expect(outdatedPicks([elsewhere], picks)).toEqual(["d"]);
  });

  it("a card filtered out of view keeps its pick", () => {
    const picks = { d: pickOf(withDraft, { kind: "ok", draftSha256: "a".repeat(64) }) };
    expect(outdatedPicks([], picks)).toEqual([]);
  });
});

describe("send all", () => {
  it("sends every card with a ready pick, in the set's order, and leaves the rest waiting", () => {
    const picks = {
      p: pickOf(plain, { kind: "reply", text: "Roll back", images: [] }),
      o: pickOf(withOptions, { kind: "choose", optionId: "monday" }),
    };
    expect(sendPlan([plain, withOptions, withDraft], picks).map((p) => p.card.id)).toEqual(["p", "o"]);
  });

  it("skips a card that stopped waiting", () => {
    const picks = { o: pickOf(withOptions, { kind: "choose", optionId: "monday" }) };
    expect(sendPlan([{ ...withOptions, status: "answered" }], picks)).toEqual([]);
  });

  it("names each answer as the review shows it", () => {
    expect(answerLabel(withOptions, { kind: "choose", optionId: "tonight" })).toBe("Chose “Ship tonight”");
    expect(answerLabel(withDraft, { kind: "ok", draftSha256: "a".repeat(64) })).toBe("OK — send the draft to #alpha-team");
    expect(answerLabel(plain, { kind: "reply", text: "Roll back", images: [{ id: "1", name: "x", data: "", mediaType: "image/png" }] })).toBe("Reply: “Roll back” + 1 picture");
  });

  it("a reply to a card older than a day is flagged for the review", () => {
    expect(isStaleForReply({ createdAt: NOW - DAY - 1 }, NOW)).toBe(true);
    expect(isStaleForReply({ createdAt: NOW - DAY + 1000 }, NOW)).toBe(false);
  });
});

describe("tab order and counts", () => {
  it("a new card goes to the end; a finished one keeps its place; a forgotten one leaves", () => {
    expect(nextTabOrder(["a", "b", "c"], ["a", "c", "n"], new Set(["b"]))).toEqual(["a", "b", "c", "n"]);
    expect(nextTabOrder(["a", "b", "c"], ["a", "c"], new Set())).toEqual(["a", "c"]);
    // An urgent card arriving does not jump ahead of the tab the user is on.
    expect(nextTabOrder(["a"], ["u", "a"], new Set())).toEqual(["a", "u"]);
  });

  it("says where the waiting cards come from", () => {
    expect(projectCounts([withOptions, withDraft, plain])).toBe("alpha 2 · beta 1");
  });
});

/** A fake of the cards' routes: each call answers from `script`, in order. */
function fakeApi(script: Array<{ ok: AssistantCard } | { error: string; question?: string; card?: AssistantCard }>) {
  const calls: Array<{ op: string; id: string; arg?: unknown; confirmAge?: boolean; images?: number }> = [];
  const next = () => {
    const step = script.shift();
    if (!step) throw new Error("no more answers");
    if ("ok" in step) return Promise.resolve({ card: step.ok });
    return Promise.reject(Object.assign(new Error(step.error), { step }));
  };
  const api: DecisionSendApi = {
    ok: (id, sha) => { calls.push({ op: "ok", id, arg: sha }); return next(); },
    choose: (id, optionId) => { calls.push({ op: "choose", id, arg: optionId }); return next(); },
    reply: (id, text, confirmAge, images) => { calls.push({ op: "reply", id, arg: text, confirmAge, images: images.length }); return next(); },
    refusal: (e) => {
      const step = (e as { step: { error: string; question?: string; card?: AssistantCard } }).step;
      return { error: step.error, ...(step.question ? { question: step.question } : {}), ...(step.card ? { card: step.card } : {}) };
    },
  };
  return { api, calls };
}

describe("send one", () => {
  it("an OK goes with the hash of the draft that was shown", async () => {
    const { api, calls } = fakeApi([{ ok: { ...withDraft, status: "answered" } }]);
    const out = await sendDecision(withDraft, { kind: "ok", draftSha256: "a".repeat(64) }, api);
    expect(out.status).toBe("sent");
    expect(calls).toEqual([{ op: "ok", id: "d", arg: "a".repeat(64) }]);
  });

  it("a card answered on Telegram meanwhile comes back as answered elsewhere, in the server's words", async () => {
    const now = { ...withOptions, status: "answered" as const };
    const { api } = fakeApi([{ error: "already_answered", question: "Already answered on Telegram at 21:16.", card: now }]);
    const out = await sendDecision(withOptions, { kind: "choose", optionId: "monday" }, api);
    expect(out).toEqual({ status: "elsewhere", message: "Already answered on Telegram at 21:16.", card: now });
  });

  it("a draft that changed on the server is a card to look at again", async () => {
    const { api } = fakeApi([{ error: "The draft is not the one this OK was given for; look at the card again." }]);
    const out = await sendDecision(withDraft, { kind: "ok", draftSha256: "a".repeat(64) }, api);
    expect(out.status).toBe("changed");
  });

  it("a day-old card asks first, and Send anyway confirms its age", async () => {
    const old = { ...plain, createdAt: NOW - 2 * DAY };
    const { api, calls } = fakeApi([
      { error: "confirm", question: "This card is from 14 Nov 09:00 — send anyway?", card: old },
      { ok: { ...old, status: "answered" } },
    ]);
    const answer: DecisionAnswer = { kind: "reply", text: "Roll back", images: [] };
    expect(await sendDecision(old, answer, api)).toEqual({ status: "confirm", question: "This card is from 14 Nov 09:00 — send anyway?", card: old });
    expect((await sendDecision(old, answer, api, { confirmAge: true })).status).toBe("sent");
    expect(calls.map((c) => c.confirmAge)).toEqual([false, true]);
  });

  it("a confirm about a card that was answered meanwhile is answered elsewhere, never asked again", async () => {
    const closed = { ...plain, status: "answered" as const };
    const { api, calls } = fakeApi([{ error: "confirm", question: "This card was answered at 21:16 — send anyway?", card: closed }]);
    const out = await sendDecision(plain, { kind: "reply", text: "Roll back", images: [] }, api, { confirmStale: true });
    expect(out.status).toBe("elsewhere");
    expect(calls).toHaveLength(1);
  });

  it("pictures travel with the reply", async () => {
    const { api, calls } = fakeApi([{ ok: { ...plain, status: "answered" } }]);
    const images = [{ id: "1", name: "a.png", data: "AA==", mediaType: "image/png" }];
    await sendDecision(plain, { kind: "reply", text: "", images }, api);
    expect(calls[0]).toEqual({ op: "reply", id: "p", arg: "", confirmAge: false, images: 1 });
  });
});

describe("send all after the review", () => {
  it("one at a time; a card answered elsewhere is skipped and the rest still go; a stale reply is confirmed", async () => {
    const old = { ...plain, createdAt: NOW - 2 * DAY };
    const { api, calls } = fakeApi([
      { error: "already_answered", question: "Already answered on Telegram at 21:16." },
      { error: "confirm", question: "This card is from 14 Nov — send anyway?", card: old },
      { ok: { ...old, status: "answered" } },
      { ok: { ...withDraft, status: "answered" } },
    ]);
    const seen: string[] = [];
    const results = await sendAllDecisions([
      { card: withOptions, answer: { kind: "choose", optionId: "monday" } },
      { card: old, answer: { kind: "reply", text: "Roll back", images: [] } },
      { card: withDraft, answer: { kind: "ok", draftSha256: "a".repeat(64) } },
    ], api, (id, outcome) => seen.push(`${id}:${outcome.status}`));
    expect(seen).toEqual(["o:elsewhere", "p:sent", "d:sent"]);
    expect(calls.map((c) => `${c.op}:${c.id}${c.confirmAge ? ":confirmAge" : ""}`)).toEqual(["choose:o", "reply:p", "reply:p:confirmAge", "ok:d"]);
    expect(results.size).toBe(3);
  });

  it("a failed send does not stop the cards after it", async () => {
    const { api } = fakeApi([{ error: "Not sent: the manager chat cannot be found" }, { ok: { ...plain, status: "answered" } }]);
    const results = await sendAllDecisions([
      { card: withOptions, answer: { kind: "choose", optionId: "tonight" } },
      { card: plain, answer: { kind: "ok", draftSha256: null } },
    ], api, () => {});
    expect(results.get("o")?.status).toBe("failed");
    expect(results.get("p")?.status).toBe("sent");
  });
});
