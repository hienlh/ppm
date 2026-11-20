/**
 * A chat's question card on Telegram answered in the user's own words, against the fake Bot API:
 * "✏️ Other" arms the chat so its next message is the answer, a reply to the card answers it with
 * nothing pressed, a card asked step by step takes words for the question on screen (several-choice
 * ones too, the words replacing any tick) and still answers only with Send. The answer reaches the
 * chat in the shape its own form sends: the words alone, keyed by question id.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { clientFor, connectChat, freshChat, memoryState, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";
import { chatControl, setChatControl, type ApprovalAnswer, type ChatControl, type LiveApprovalCard } from "../../../../src/services/chat-control/chat-control.ts";
import { AssistantTelegramCards } from "../../../../src/services/assistant-telegram/assistant-telegram-cards.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { normalizeClaudeQuestions, normalizeCodexQuestions, type NormalizedQuestion } from "../../../../src/shared/approval-questions.ts";
import type { TelegramCallbackQuery } from "../../../../src/services/telegram/telegram-types.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);

const answered: Array<{ sessionId: string; requestId: string; answer: ApprovalAnswer }> = [];
let cards!: AssistantTelegramCards;
const previous = chatControl();
setChatControl({
  answerApproval(sessionId, requestId, answer) {
    answered.push({ sessionId, requestId, answer });
    cards.resolved({ sessionId, requestId, approved: answer.approved, reason: "answered", by: "telegram", answers: answer.answersById });
    return "answered";
  },
} as Partial<ChatControl> as ChatControl);
afterAll(() => setChatControl(previous));

const OTHER = "✏️ Other (type it)";

function setup(link = "http://localhost:8080/assistant?session=claude/s") {
  const chat = connectChat(freshChat());
  const queue = queueFor(client);
  const codes = new ButtonCodes<BridgeAction>();
  cards = new AssistantTelegramCards({ queue, state: memoryState(), codes, now: Date.now, sessionLink: async () => link, chatLink: async () => link });
  const show = async (questions: NormalizedQuestion[], relay?: { sessionId: string }) => {
    const full: LiveApprovalCard = { requestId: `req-${crypto.randomUUID()}`, tool: "AskUserQuestion", input: {}, isQuestion: true, questions };
    const before = fake.sent(Number(chat)).length;
    if (relay) cards.relayed(chat, { targetSessionId: relay.sessionId, targetProject: "alpha", targetProvider: "claude", targetTitle: "Merge chat", card: full, manager: true });
    else cards.shown(chat, { sessionId: "s", card: full, projectName: "__assistant__", providerId: "claude" });
    const message = await fake.waitFor(() => fake.sent(Number(chat))[before]);
    await queue.whenIdle();
    return { id: message.message_id, requestId: full.requestId };
  };
  const message = (id: number) => fake.sent(Number(chat)).find((m) => m.message_id === id)!;
  const buttons = (id: number) => fake.buttons(Number(chat), id).flat();
  const labels = (id: number) => fake.buttons(Number(chat), id).map((row) => row.map((b) => b.text));
  const pressData = (data: string | undefined) => {
    const found = codes.peek(data, chat);
    if (!found.ok || found.action.kind !== "card") return "no such button";
    return cards.press(chat, found.action, found.group, {} as TelegramCallbackQuery);
  };
  const press = async (id: number, text: string) => {
    const toast = pressData(buttons(id).find((b) => b.text === text || b.text === `✓ ${text}`)?.callback_data);
    await queue.whenIdle();
    return toast;
  };
  const typed = (text: string, extra: { replyTo?: number; notTheUsers?: boolean; hasPhoto?: boolean } = {}) =>
    cards.typed(chat, {
      text, notTheUsers: extra.notTheUsers ?? false,
      ...(extra.replyTo !== undefined ? { replyToMessageId: extra.replyTo } : {}),
      ...(extra.hasPhoto ? { hasPhoto: true } : {}),
    });
  const lastSent = () => fake.sent(Number(chat)).at(-1)!;
  return { chat, queue, show, message, buttons, labels, press, pressData, typed, lastSent };
}

describe("an answer in the user's own words on Telegram", () => {
  it("Other on a one-question card: the next message answers it, word for word", async () => {
    const t = setup();
    const questions = normalizeClaudeQuestions({ questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] });
    const { id, requestId } = await t.show(questions);
    expect(t.labels(id)).toEqual([["A"], ["B"], ["C"], [OTHER]]);
    expect(t.message(id).text).toContain("press ✏️ Other, or reply to this card");
    // Nothing armed yet: a plain message is not for the card.
    expect(t.typed("hello")).toBeNull();
    expect(await t.press(id, OTHER)).toBe("Type your answer and send it.");
    const prompt = t.lastSent();
    expect(prompt.text).toContain("Type your answer to: Which approach?");
    expect(fake.buttons(Number(t.chat), prompt.message_id).flat().map((b) => b.text)).toEqual(["Cancel"]);
    // Someone else's words (a forward) never answer it.
    expect(t.typed("forwarded", { notTheUsers: true })).toBeNull();
    expect(t.typed("  Neither: do D instead  ")).toBe("✅ Answer sent: <b>Neither: do D instead</b>");
    expect(answered.at(-1)).toEqual({ sessionId: "s", requestId, answer: { approved: true, answersById: { [questions[0]!.id]: ["Neither: do D instead"] } } });
    await t.queue.whenIdle();
    // The card is over: the next message goes to the Assistant again.
    expect(t.typed("and now something else")).toBeNull();
  });

  it("a reply to the card (or to the prompt) answers it; Cancel disarms Other", async () => {
    const t = setup();
    const questions = normalizeClaudeQuestions({ questions: [{ question: "Name?", options: [] }] });
    const { id, requestId } = await t.show(questions);
    expect(t.labels(id)).toEqual([["✏️ Type your answer"]]);
    expect(t.message(id).text).toContain("Reply to this card with your answer");
    await t.press(id, "✏️ Type your answer");
    const prompt = t.lastSent();
    const cancel = fake.buttons(Number(t.chat), prompt.message_id).flat()[0]!.callback_data;
    expect(t.pressData(cancel)).toBe("Cancelled. Your next message goes to the Assistant.");
    await t.queue.whenIdle();
    // The line no longer claims to wait, and its Cancel is gone.
    expect(t.message(prompt.message_id).text).toContain("Cancelled. Your next message goes to the Assistant.");
    expect(t.buttons(prompt.message_id)).toEqual([]);
    expect(t.typed("not an answer")).toBeNull();
    // A reply to some other message is not for the card either.
    expect(t.typed("about something else", { replyTo: id + 999 })).toBeNull();
    // A reply that carries no words, or a photo, goes on to the chat whole, as replies always did.
    expect(t.typed("", { replyTo: id })).toBeNull();
    expect(t.typed("see this", { replyTo: id, hasPhoto: true })).toBeNull();
    expect(t.typed("Bluebird", { replyTo: id })).toBe("✅ Answer sent: <b>Bluebird</b>");
    expect(answered.at(-1)).toEqual({ sessionId: "s", requestId, answer: { approved: true, answersById: { [questions[0]!.id]: ["Bluebird"] } } });

    const again = await t.show(normalizeClaudeQuestions({ questions: [{ question: "Colour?", options: [{ label: "red" }] }] }));
    await t.press(again.id, OTHER);
    expect(t.typed("teal", { replyTo: t.lastSent().message_id })).toBe("✅ Answer sent: <b>teal</b>");
  });

  it("a question that takes no typed text has no Other and leaves a reply to the chat; a Codex one marked other takes words", async () => {
    const t = setup();
    const closed = normalizeCodexQuestions({ questions: [{ id: "target", question: "Where to?", options: [{ label: "staging" }, { label: "prod" }] }] });
    const { id } = await t.show(closed);
    expect(t.labels(id)).toEqual([["staging"], ["prod"]]);
    // Not an answer it can take: the reply goes on to the chat word for word, as before.
    expect(t.typed("somewhere", { replyTo: id })).toBeNull();
    const open = normalizeCodexQuestions({ questions: [{ id: "target", question: "Where to?", isOther: true, options: [{ label: "staging" }] }] });
    const shown = await t.show(open);
    expect(t.labels(shown.id)).toEqual([["staging"], [OTHER]]);
    expect(t.typed("qa-3", { replyTo: shown.id })).toBe("✅ Answer sent: <b>qa-3</b>");
    expect(answered.at(-1)?.answer).toEqual({ approved: true, answersById: { target: ["qa-3"] } });
  });

  it("step by step: Other on every question, several-choice ones too; words replace ticks; only Send answers", async () => {
    const t = setup();
    const questions = normalizeClaudeQuestions({ questions: [
      { question: "Which environment?", header: "Env", options: [{ label: "staging" }, { label: "production" }] },
      { question: "Who should hear?", header: "Notify", multiSelect: true, options: [{ label: "email" }, { label: "Slack" }] },
      { question: "When?", header: "When", options: [{ label: "now" }, { label: "tonight" }] },
    ] });
    const [q1, q2, q3] = questions.map((q) => q.id);
    const { id, requestId } = await t.show(questions);
    expect(t.labels(id)).toEqual([["staging"], ["production"], [OTHER]]);
    expect(await t.press(id, OTHER)).toBe("Type your answer and send it.");
    expect(t.typed("qa-3 first, then prod")).toBe("Got it. Next question.");
    await t.queue.whenIdle();
    expect(t.message(id).text).toContain("Question 2/3");
    expect(t.labels(id)).toEqual([["email"], ["Slack"], [OTHER], ["« Back", "Next »"]]);
    // Several choices: tick one, then answer in words instead (a reply) — the words replace the tick.
    await t.press(id, "email");
    expect(t.typed("Only the on-call person", { replyTo: id })).toBe("Got it. Next question.");
    await t.queue.whenIdle();
    // Back shows the typed answer on its step.
    await t.press(id, "« Back");
    expect(t.message(id).text).toContain("→ Your answer: Only the on-call person");
    await t.press(id, "Next »");
    expect(t.message(id).text).toContain("Question 3/3");
    // Other on question 3, then Back: the wait ends, the line says so, and the next message goes on.
    await t.press(id, OTHER);
    const prompt = t.lastSent();
    await t.press(id, "« Back");
    expect(t.message(prompt.message_id).text).toContain("No longer waiting: the card moved on.");
    expect(t.typed("late words")).toBeNull();
    await t.press(id, "Next »");
    await t.press(id, "tonight");
    expect(t.message(id).text).toContain("→ qa-3 first, then prod");
    expect(t.message(id).text).toContain("→ Only the on-call person");
    const before = answered.length;
    // On the summary a reply is no answer: it goes on to the chat.
    expect(t.typed("extra", { replyTo: id })).toBeNull();
    expect(answered.length).toBe(before);
    expect(await t.press(id, "Send")).toBe("Answer sent.");
    expect(answered.at(-1)).toEqual({ sessionId: "s", requestId, answer: { approved: true, answersById: {
      [q1!]: ["qa-3 first, then prod"], [q2!]: ["Only the on-call person"], [q3!]: ["tonight"],
    } } });
  });

  it("a choice picked after Other ends the wait: the next message is not taken for the question", async () => {
    const t = setup();
    const questions = normalizeClaudeQuestions({ questions: [
      { question: "Which environment?", options: [{ label: "staging" }, { label: "production" }] },
      { question: "When?", options: [{ label: "now" }] },
    ] });
    const { id } = await t.show(questions);
    await t.press(id, OTHER);
    const prompt = t.lastSent();
    expect(await t.press(id, "production")).toBe("Next question.");
    expect(t.message(prompt.message_id).text).toContain("No longer waiting: the card moved on.");
    expect(t.typed("hello Assistant")).toBeNull();
  });

  it("a task's \"next message goes to…\" takes over from Other, and the line says so", async () => {
    const t = setup();
    const { id } = await t.show(normalizeClaudeQuestions({ questions: [{ question: "Ship?", options: [{ label: "yes" }] }] }));
    await t.press(id, OTHER);
    const prompt = t.lastSent();
    cards.stopTyped(t.chat);
    await t.queue.whenIdle();
    expect(t.message(prompt.message_id).text).toContain("No longer waiting: your next message goes elsewhere.");
    expect(t.typed("about the task")).toBeNull();
  });

  it("answers another chat's card in words, and answers that chat", async () => {
    const t = setup();
    const questions = normalizeClaudeQuestions({ questions: [{ question: "Merge?", options: [{ label: "Yes" }, { label: "No" }] }] });
    const { id, requestId } = await t.show(questions, { sessionId: "other-chat" });
    await t.press(id, OTHER);
    expect(t.typed("After CI is green")).toBe("✅ Answer sent: <b>After CI is green</b>");
    expect(answered.at(-1)).toEqual({ sessionId: "other-chat", requestId, answer: { approved: true, answersById: { [questions[0]!.id]: ["After CI is green"] } } });
  });
});

describe("ArmedAnswers", () => {
  it("ends a wait when its window passes, by timer and when asked, and says so once", async () => {
    const { ArmedAnswers } = await import("../../../../src/services/assistant-telegram/assistant-telegram-typed-answers.ts");
    const ended: string[] = [];
    const store = new ArmedAnswers((chatId, _a, why) => ended.push(`${chatId}:${why}`));
    const now = Date.now();
    store.arm("c1", { cardKey: "k1", questionId: "q", until: now + 20, promptMessageId: null, promptHead: "" }, now);
    store.arm("c2", { cardKey: "k2", questionId: "q", until: now + 60_000, promptMessageId: null, promptHead: "" }, now);
    await Bun.sleep(60);
    expect(ended).toEqual(["c1:expired"]);
    expect(store.get("c1", Date.now())).toBeNull();
    expect(store.get("c2", now + 60_001)).toBeNull();
    expect(ended).toEqual(["c1:expired", "c2:expired"]);
    // Pressing Other on another card replaces the wait, and the first is told.
    store.arm("c3", { cardKey: "a", questionId: "q", until: now + 60_000, promptMessageId: null, promptHead: "" }, now);
    store.arm("c3", { cardKey: "b", questionId: "q", until: now + 60_000, promptMessageId: null, promptHead: "" }, now);
    expect(ended.at(-1)).toBe("c3:replaced");
    store.endCard("b", "ended");
    expect(ended.at(-1)).toBe("c3:ended");
  });
});
