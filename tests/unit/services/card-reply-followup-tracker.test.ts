/**
 * Which manager turn answers a reply on a card: followed by the reply's client id, never "the next
 * turn end" — words queued behind a running turn, other turns in between, a turn named before the
 * send returned, a provider that names nothing. Only the turn's final top-level text is the answer.
 */
import { describe, expect, it } from "bun:test";
import {
  answerOf, createFollowupTracker, cutFollowupText, FOLLOWUP_BUFFER_MAX, isThrowawayBlock, type FollowupResult,
} from "../../../src/services/assistant-cards/card-reply-followup-tracker.ts";
import { deliverCardFollowup } from "../../../src/services/assistant-cards/card-reply-followup.ts";
import type { AssistantCard, CardFollowUp } from "../../../src/shared/assistant-cards.ts";
import { CARD_FOLLOWUP_MAX_CHARS } from "../../../src/shared/assistant-limits.ts";

const S = "manager-1";
const ID = "card-11111111-2222-4333-8444-555555555555";

function setup(opts: { idle?: () => boolean } = {}) {
  const delivered: FollowupResult[] = [];
  const timers: Array<{ fn: () => void; live: boolean }> = [];
  const aliases = new Map<string, string>();
  // The chat's latest turn id, as `liveState().turnId` keeps it: moved by every `turn_started`.
  let turn = "turn-0";
  let turns = 0;
  const t = createFollowupTracker({
    canonical: (id) => aliases.get(id) ?? id,
    isIdle: opts.idle ?? (() => true),
    turnId: () => turn,
    now: () => 1_000,
    setTimer: (fn) => { const timer = { fn, live: true }; timers.push(timer); return () => { timer.live = false; }; },
    deliver: (r) => delivered.push(r),
  });
  const runTimers = () => { for (const x of timers.splice(0)) if (x.live) x.fn(); };
  const say = (text: string, session = S) => t.onStream(session, { type: "text", content: text });
  /** A turn opens; `clientMessageId` names the message that opened it, when the provider says. */
  const named = (clientMessageId?: string, session = S) => {
    turn = `turn-${++turns}`;
    t.onStream(session, { type: "turn_started", turnId: turn, ...(clientMessageId ? { clientMessageId } : {}) });
  };
  return { t, delivered, runTimers, say, named, aliases };
}

const origin = { channel: "telegram" as const, chatId: "42", replyTo: 7 };

describe("following the turn a card reply opened", () => {
  it("sends the named turn's final text once: text before its last tool call is not the answer", () => {
    const { t, delivered, say, named } = setup();
    const h = t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S });
    h.attach("started");
    named(ID);
    say("Let me check the quota…");
    t.onStream(S, { type: "tool_use", tool: "Bash", toolUseId: "x" });
    t.onStream(S, { type: "tool_result", output: "SECRET TOOL OUTPUT" });
    t.onStream(S, { type: "thinking", content: "hidden thoughts" });
    t.onStream(S, { type: "text", content: "subagent words", parentToolUseId: "x" });
    say("It will cost a lot: ");
    say("~40% of the weekly quota.");
    t.onTurnEnded(S);
    expect(delivered).toEqual([{
      cardId: "c1", origin, sessionId: S, text: "It will cost a lot: ~40% of the weekly quota.", overflow: false, newCards: [],
    }]);
    // At most one follow-up per reply.
    named(ID); say("again"); t.onTurnEnded(S);
    expect(delivered).toHaveLength(1);
    expect(t.size()).toBe(0);
  });

  it("keeps an answer written before the new card's tool call, and drops the 'Card sent.' after it", () => {
    const { t, delivered, say, named } = setup();
    t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S }).attach("started");
    named(ID);
    say("No: it costs ~40% of the weekly quota (55% left).");
    t.onStream(S, { type: "tool_use", tool: "mcp__ppm-sessions__report_to_assistant" });
    t.onStream(S, { type: "tool_result", output: "{}" });
    say("Card sent.");
    t.onTurnEnded(S);
    expect(delivered.map((d) => d.text)).toEqual(["No: it costs ~40% of the weekly quota (55% left)."]);
  });

  it("sends nothing when all the turn wrote around its tool calls is an acknowledgement", () => {
    const { t, delivered, named, say } = setup();
    t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S }).attach("started");
    named(ID);
    t.onStream(S, { type: "tool_use", tool: "mcp__ppm-sessions__report_to_assistant" });
    say("Card sent.");
    t.onTurnEnded(S);
    expect(delivered).toHaveLength(0);
    expect(t.size()).toBe(0);
  });

  it("joins every real block, and lets the earliest give way when they do not fit", () => {
    const { t, delivered, named, say } = setup();
    t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S }).attach("started");
    named(ID);
    say("Tests pass: 40 of 40.");
    t.onStream(S, { type: "tool_use", tool: "Bash" });
    say("Done: PR #12 updated.");
    t.onTurnEnded(S);
    expect(delivered[0]).toMatchObject({ text: "Tests pass: 40 of 40.\n\nDone: PR #12 updated.", overflow: false });
    expect(answerOf({ blocks: ["a".repeat(CARD_FOLLOWUP_MAX_CHARS), "", "Answer: 42."], size: 0, sawTool: true, overflow: false }))
      .toEqual({ text: "Answer: 42.", overflow: true });
    expect(isThrowawayBlock("Card sent.")).toBe(true);
    expect(isThrowawayBlock("Đúng không?")).toBe(false);
    expect(isThrowawayBlock("Costs 40%.")).toBe(false);
  });

  it("gathers each reply's own answer, so a second reply joining the turn does not wipe the first's", () => {
    const { t, delivered, say, runTimers } = setup();
    const a = t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S });
    a.attach("inserted");
    say("For your first reply: it takes 12 hours. ");
    const b = t.expect({ cardId: "c2", clientMessageId: "card-b", origin, sessionId: S });
    b.attach("inserted");
    say("For the second: 5 minutes.");
    t.onTurnEnded(S);
    runTimers();
    const byCard = Object.fromEntries(delivered.map((d) => [d.cardId, d.text]));
    expect(byCard.c1).toContain("12 hours");
    expect(byCard.c2).toBe("For the second: 5 minutes.");
  });

  it("waits through other turns when the words were queued, and answers with the turn that opened with them", () => {
    const { t, delivered, say, named, runTimers } = setup();
    const h = t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S });
    h.attach("queued");
    say("finishing the running turn");
    t.onTurnEnded(S);
    runTimers();
    named("card-other"); say("a schedule's turn"); t.onTurnEnded(S);
    runTimers();
    t.onStream(S, { type: "turn_started", turnId: "u" }); say("another chat's message"); t.onTurnEnded(S);
    runTimers();
    expect(delivered).toHaveLength(0);
    named(ID);
    say("Answer to your reply.");
    t.onTurnEnded(S);
    expect(delivered.map((d) => d.text)).toEqual(["Answer to your reply."]);
  });

  it("keeps a turn named before the send returned", () => {
    const { t, delivered, say, named } = setup();
    const h = t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S });
    named(ID);
    say("Fast answer.");
    h.attach("started");
    t.onTurnEnded(S);
    expect(delivered.map((d) => d.text)).toEqual(["Fast answer."]);
  });

  it("judges an unnamed turn that ended before the send returned, once the chat is still idle after the grace", () => {
    const { t, delivered, say, runTimers } = setup();
    const h = t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S });
    say("Unnamed answer.");
    t.onTurnEnded(S);
    h.attach("started");
    expect(delivered).toHaveLength(0);
    runTimers();
    expect(delivered.map((d) => d.text)).toEqual(["Unnamed answer."]);
  });

  it("takes an unnamed reply that joined a running turn from after the words, once the chat is idle on the same turn", () => {
    const { t, delivered, say, runTimers, named } = setup();
    named("schedule-1");
    say("before the words arrived");
    const h = t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S });
    say("still before");
    h.attach("inserted");
    say("After your words: no, it costs 40%.");
    t.onTurnEnded(S);
    runTimers();
    expect(delivered.map((d) => d.text)).toEqual(["After your words: no, it costs 40%."]);
  });

  it("judges an unnamed inserted reply once: another turn that runs after it never answers it", () => {
    let idle = false;
    const { t, delivered, say, runTimers, named } = setup({ idle: () => idle });
    named("schedule-1");
    const h = t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S });
    h.attach("inserted");
    say("After your words: no.");
    t.onTurnEnded(S);
    runTimers(); // another turn started meanwhile: the words' turn is not known, so nothing is sent
    expect(delivered).toHaveLength(0);
    say("Second turn answer.");
    t.onTurnEnded(S);
    idle = true;
    runTimers();
    expect(delivered).toHaveLength(0);
  });

  it("sends nothing when another sender's named turn opens within the grace, though the chat is idle when it ends", () => {
    let idle = false;
    const { t, delivered, say, runTimers, named } = setup({ idle: () => idle });
    named("schedule-1");
    say("schedule turn A working");
    t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S }).attach("inserted");
    say("A's answer after the words");
    t.onTurnEnded(S);
    // Within the grace the Assistant's message opens turn B, named with its own id.
    named("assistant-xyz");
    runTimers();
    say("B: reply to the Assistant about client Foo Ltd tax");
    t.onTurnEnded(S);
    idle = true;
    runTimers();
    expect(delivered).toHaveLength(0);
    // Still the reply's own turn may name it later, and that turn answers it.
    named(ID);
    say("Answer to your reply: 40%.");
    t.onTurnEnded(S);
    expect(delivered.map((d) => d.text)).toEqual(["Answer to your reply: 40%."]);
  });

  it("sends nothing when the turn that ended is not the one running when the words went in", () => {
    const { t, delivered, say, runTimers, named } = setup();
    named("schedule-1");
    const h = t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S });
    h.attach("inserted");
    named("other"); // the provider said a new turn opened, and it is not the reply's
    say("Someone else's answer.");
    t.onTurnEnded(S);
    runTimers();
    expect(delivered).toHaveLength(0);
  });

  it("sends nothing for a turn with no text, a stopped send, or a builtin that left the turn running", () => {
    const { t, delivered, say, named } = setup();
    const a = t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S });
    a.attach("started");
    named(ID);
    t.onStream(S, { type: "tool_use", tool: "Bash" });
    t.onTurnEnded(S);
    const b = t.expect({ cardId: "c2", clientMessageId: "card-b", origin, sessionId: S });
    b.abandon();
    const c = t.expect({ cardId: "c3", clientMessageId: "card-c", origin, sessionId: S });
    c.attach("started");
    named("card-c");
    say("partial");
    t.onTurnEnded(S, { turnStillRunning: true });
    expect(delivered).toHaveLength(0);
    say(" answer");
    t.onTurnEnded(S);
    expect(delivered.map((d) => [d.cardId, d.text])).toEqual([["c3", "partial answer"]]);
  });

  it("sends a stopped turn's partial text as nothing: only that it stopped, for a named or an unnamed reply", () => {
    const { t, delivered, say, named, runTimers } = setup();
    t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S }).attach("inserted");
    say("half a sentence of an unrelated tas");
    t.onTurnEnded(S, { outcome: "stopped" });
    runTimers();
    t.expect({ cardId: "c2", clientMessageId: "card-b", origin, sessionId: S }).attach("started");
    named("card-b");
    say("Partial answer: it co");
    t.onTurnEnded(S, { outcome: "failed" });
    expect(delivered.map((d) => [d.cardId, d.text, d.stopped])).toEqual([["c1", "", true], ["c2", "", true]]);
  });

  it("names the cards the manager opened in that turn, and no other chat's", () => {
    const { t, delivered, say, named } = setup();
    t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S }).attach("started");
    named(ID);
    t.onCardCreated({ id: "n1", title: "Run the full suite? It costs ~40%", sessionId: S });
    t.onCardCreated({ id: "x", title: "elsewhere", sessionId: "other" });
    say("It will cost a lot. New card above.");
    t.onTurnEnded(S);
    expect(delivered[0]!.newCards).toEqual([{ id: "n1", title: "Run the full suite? It costs ~40%" }]);
  });

  it("marks an answer longer than it keeps, and follows a chat the provider renamed", () => {
    const { t, delivered, say, named, aliases } = setup();
    t.expect({ cardId: "c1", clientMessageId: ID, origin, sessionId: S }).attach("started");
    named(ID);
    say("x".repeat(FOLLOWUP_BUFFER_MAX + 10));
    aliases.set(S, "thread-9");
    t.onMigrated(S, "thread-9");
    t.onTurnEnded("thread-9");
    expect(delivered[0]).toMatchObject({ overflow: true, sessionId: "thread-9" });
    expect(delivered[0]!.text.length).toBe(FOLLOWUP_BUFFER_MAX);
  });
});

describe("cutFollowupText", () => {
  it("keeps short text whole and cuts long text without splitting a surrogate pair", () => {
    expect(cutFollowupText("  hi  ", 10)).toEqual({ text: "hi", truncated: false });
    expect(cutFollowupText("hi", 10, true)).toEqual({ text: "hi", truncated: true });
    const cut = cutFollowupText(`${"a".repeat(9)}😀tail`, 10);
    expect(cut).toEqual({ text: "a".repeat(9), truncated: true });
  });
});

describe("deliverCardFollowup", () => {
  const card = { id: "c1", projectName: "ppm", status: "answered" } as AssistantCard;

  it("keeps the cut answer on the card and hands it on; a sink that throws is contained", () => {
    const stored: CardFollowUp[] = [];
    const sent: unknown[] = [];
    const cards = { get: () => card, setFollowUp: (_id: string, f: CardFollowUp) => { stored.push(f); return true; } };
    const result: FollowupResult = { cardId: "c1", origin: { channel: "ppm" }, sessionId: S, text: "y".repeat(CARD_FOLLOWUP_MAX_CHARS + 5), overflow: false, newCards: [] };
    deliverCardFollowup({ cards, now: () => 5, sink: () => ({ send: (d) => sent.push(d) }) }, result);
    expect(stored).toEqual([{ text: "y".repeat(CARD_FOLLOWUP_MAX_CHARS), truncated: true, at: 5 }]);
    expect(sent).toHaveLength(1);
    expect(() => deliverCardFollowup({ cards, now: () => 5, sink: () => ({ send: () => { throw new Error("boom"); } }) }, result)).not.toThrow();
  });

  it("keeps nothing on the card for a stopped turn, and tells only a reply typed on Telegram", () => {
    const stored: CardFollowUp[] = [];
    const sent: Array<{ stopped?: true; origin: { channel: string } }> = [];
    const cards = { get: () => card, setFollowUp: (_id: string, f: CardFollowUp) => { stored.push(f); return true; } };
    const stopped = (o: FollowupResult["origin"]): FollowupResult => ({ cardId: "c1", origin: o, sessionId: S, text: "", overflow: false, newCards: [], stopped: true });
    deliverCardFollowup({ cards, now: () => 5, sink: () => ({ send: (d) => sent.push(d) }) }, stopped({ channel: "ppm" }));
    deliverCardFollowup({ cards, now: () => 5, sink: () => ({ send: (d) => sent.push(d) }) }, stopped(origin));
    expect(stored).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ stopped: true, origin: { channel: "telegram" } });
  });

  it("does nothing for a card that is gone", () => {
    let called = false;
    deliverCardFollowup({
      cards: { get: () => null, setFollowUp: () => { called = true; return true; } }, now: () => 1, sink: () => null,
    }, { cardId: "x", origin: { channel: "ppm" }, sessionId: S, text: "t", overflow: false, newCards: [] });
    expect(called).toBe(false);
  });
});
