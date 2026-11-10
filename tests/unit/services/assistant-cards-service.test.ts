/**
 * The card store and the user's actions on cards: compare-and-set (the second answer learns it was
 * too late), kind and status checks on every action, Allow refused where the request is not shown
 * in full, a stale request resolving with nothing run, paging, waiting counts, the restart sweep.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { answerCard, dismissCard, sweepGoneRequestCards, type CardActionDeps } from "../../../src/services/assistant-cards/assistant-card-actions.ts";
import type { ApprovalAnswer, ChatControl, LiveChatState, ServerOrigin } from "../../../src/services/chat-control/chat-control.ts";

let now = 1_700_000_000_000;
const announced: string[] = [];
const cards = createAssistantCards({
  now: () => now, projects: () => [{ name: "api", path: "/p/api" }, { name: "web", path: "/p/web" }],
  announce: (card) => announced.push(`${card.id}:${card.status}`),
});

function control(result: "answered" | "stale", live: Partial<LiveChatState> | null = null) {
  const calls: Array<{ sessionId: string; requestId: string; answer: ApprovalAnswer; origin: ServerOrigin }> = [];
  const c: ChatControl = {
    sendUserMessage: async () => ({ ok: false, error: "no" }),
    answerApproval: (sessionId, requestId, answer, origin) => { calls.push({ sessionId, requestId, answer, origin }); return result; },
    cancelTurn: () => false,
    liveState: () => (live ? { phase: "idle", running: false, projectName: "", providerId: "claude", queuedCards: 0, ...live } as LiveChatState : null),
    listLive: () => [],
  };
  return { c, calls };
}

const deps = (c: ChatControl): CardActionDeps => ({ cards, control: () => c, now: () => now });

function approval(complete = true, project = "/p/api") {
  return cards.create({
    kind: "approval", projectName: "api", projectPath: project, sessionId: "mgr-1", title: "Bash",
    payload: { requestId: `req-${crypto.randomUUID()}`, deciding: { kind: "command", title: "Bash", facts: [], text: "ls", complete } },
  });
}

beforeEach(() => { getDb().run("DELETE FROM assistant_cards"); announced.length = 0; now += 1000; });

describe("answering", () => {
  it("answers the exact request once; the second answer is already answered", () => {
    const card = approval();
    const { c, calls } = control("answered");
    const first = answerCard(card.id, { decision: "allow" }, deps(c));
    expect(first.ok && first.card.status).toBe("answered");
    expect(calls).toEqual([expect.objectContaining({ sessionId: "mgr-1", requestId: card.payload.requestId, origin: "assistant_card", answer: { approved: true } })]);
    const second = answerCard(card.id, { decision: "deny" }, deps(c));
    expect(second).toEqual(expect.objectContaining({ ok: false, status: 409, error: "already_answered" }));
    expect(calls).toHaveLength(1);
  });

  it("refuses Allow when the card does not show everything, but takes Deny", () => {
    const card = approval(false);
    const { c, calls } = control("answered");
    expect(answerCard(card.id, { decision: "allow" }, deps(c))).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(calls).toHaveLength(0);
    expect(answerCard(card.id, { decision: "deny" }, deps(c)).ok).toBe(true);
  });

  it("resolves a card whose request no longer waits, with nothing run", () => {
    const card = approval();
    const res = answerCard(card.id, { decision: "allow" }, deps(control("stale").c));
    expect(res.ok && res.stale).toBe(true);
    expect(res.ok && res.card.status).toBe("resolved");
  });

  it("checks the card's kind: a report is dismissed, never answered, and an approval never dismissed", () => {
    const report = cards.create({ kind: "done", projectName: "api", projectPath: "/p/api", sessionId: "mgr-1", title: "Shipped" });
    const { c } = control("answered");
    expect(answerCard(report.id, { decision: "allow" }, deps(c))).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(dismissCard(approval().id, deps(c))).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(dismissCard(report.id, deps(c)).ok).toBe(true);
    expect(dismissCard(report.id, deps(c))).toEqual(expect.objectContaining({ status: 409 }));
    expect(answerCard("nope", {}, deps(c))).toEqual(expect.objectContaining({ status: 404 }));
  });

  it("answers a question card by question id", () => {
    const card = cards.create({
      kind: "question", projectName: "api", projectPath: "/p/api", sessionId: "mgr-1", title: "Which?",
      payload: { requestId: "req-q", questions: [{ id: "q1", question: "Which?", multiSelect: false, allowsFreeText: false, options: [{ label: "A" }, { label: "B" }] }] },
    });
    const { c, calls } = control("answered");
    expect(answerCard(card.id, { answersById: { q1: ["C"] } }, deps(c)).ok).toBe(false);
    expect(answerCard(card.id, { answersById: { q1: ["B"] } }, deps(c)).ok).toBe(true);
    expect(calls[0]!.answer).toEqual({ approved: true, answersById: { q1: ["B"] } });
  });
});

describe("listing and counts", () => {
  it("pages newest first, filters by project on the server, and counts what waits", () => {
    approval();
    now += 10;
    cards.create({ kind: "done", projectName: "web", projectPath: "/p/web", sessionId: "mgr-2", title: "Done" });
    now += 10;
    cards.create({ kind: "needs_decision", projectName: "web", projectPath: "/p/web", sessionId: "mgr-2", title: "Pick" });
    const page1 = cards.list({ limit: 2 });
    expect(page1.cards.map((x) => x.title)).toEqual(["Pick", "Done"]);
    expect(page1.nextBefore).not.toBeNull();
    expect(cards.list({ limit: 2, before: page1.nextBefore! }).cards.map((x) => x.title)).toEqual(["Bash"]);
    expect(cards.list({ limit: 10, projectName: "api" }).cards).toHaveLength(1);
    expect(cards.waiting()).toEqual({ total: 2, byProject: { api: 1, web: 1 } });
    expect(cards.list({ limit: 10 }).cards.find((x) => x.kind === "done")!.provenance).toBe("Written by the web manager AI");
  });

  it("gives PPM's own cards no manager provenance line, a failure PPM saw included", () => {
    const seen = cards.create({ kind: "failed", projectName: "api", projectPath: "/p/api", sessionId: "mgr-1", title: "Stopped", payload: { detected: true } });
    const reported = cards.create({ kind: "failed", projectName: "api", projectPath: "/p/api", sessionId: "mgr-1", title: "Deploy failed" });
    expect(seen.provenance).toBeNull();
    expect(reported.provenance).toBe("Written by the api manager AI");
    expect(approval().provenance).toBeNull();
  });
});

describe("the restart sweep", () => {
  it("marks a request card gone only when no live chat shows that request", () => {
    const kept = approval();
    const gone = approval();
    const live = control("stale", { card: { requestId: kept.payload.requestId!, tool: "Bash", input: {}, isQuestion: false } });
    // The live state answers for every session here; only the kept card's request is the one shown.
    const swept = sweepGoneRequestCards(deps(live.c));
    expect(swept).toBe(1);
    expect(cards.get(kept.id)!.status).toBe("open");
    expect(cards.get(gone.id)!.status).toBe("gone");
  });
});
