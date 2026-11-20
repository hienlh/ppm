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
  const typed = (text: string, extra: { replyTo?: number; notTheUsers?: boolean } = {}) =>
    cards.typed(chat, { text, notTheUsers: extra.notTheUsers ?? false, ...(extra.replyTo !== undefined ? { replyToMessageId: extra.replyTo } : {}) });
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
    const cancel = fake.buttons(Number(t.chat), t.lastSent().message_id).flat()[0]!.callback_data;
    expect(t.pressData(cancel)).toBe("Cancelled. Your next message goes to the Assistant.");
    expect(t.typed("not an answer")).toBeNull();
    // A reply to some other message is not for the card either.
    expect(t.typed("about something else", { replyTo: id + 999 })).toBeNull();
    expect(t.typed("", { replyTo: id })).toBe("Send your answer as text.");
    expect(t.typed("Bluebird", { replyTo: id })).toBe("✅ Answer sent: <b>Bluebird</b>");
    expect(answered.at(-1)).toEqual({ sessionId: "s", requestId, answer: { approved: true, answersById: { [questions[0]!.id]: ["Bluebird"] } } });

    const again = await t.show(normalizeClaudeQuestions({ questions: [{ question: "Colour?", options: [{ label: "red" }] }] }));
    await t.press(again.id, OTHER);
    expect(t.typed("teal", { replyTo: t.lastSent().message_id })).toBe("✅ Answer sent: <b>teal</b>");
  });

  it("a question that takes no typed text has no Other and says so to a reply; a Codex one marked other takes words", async () => {
    const t = setup();
    const closed = normalizeCodexQuestions({ questions: [{ id: "target", question: "Where to?", options: [{ label: "staging" }, { label: "prod" }] }] });
    const { id } = await t.show(closed);
    expect(t.labels(id)).toEqual([["staging"], ["prod"]]);
    expect(t.typed("somewhere", { replyTo: id })).toBe("This question takes one of its choices only: press one of its buttons.");
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
    // Other armed on question 3, then Back: the words are not taken for question 2.
    await t.press(id, OTHER);
    await t.press(id, "« Back");
    expect(t.typed("late words")).toBe("That answer was for another question. Press ✏️ Other on this one again.");
    await t.queue.whenIdle();
    await t.press(id, "Next »");
    await t.press(id, "tonight");
    expect(t.message(id).text).toContain("→ qa-3 first, then prod");
    expect(t.message(id).text).toContain("→ Only the on-call person");
    const before = answered.length;
    // On the summary, words change nothing: Send, or Back.
    expect(t.typed("extra", { replyTo: id })).toBe("Every question has an answer: press Send, or Back to change one.");
    expect(answered.length).toBe(before);
    expect(await t.press(id, "Send")).toBe("Answer sent.");
    expect(answered.at(-1)).toEqual({ sessionId: "s", requestId, answer: { approved: true, answersById: {
      [q1!]: ["qa-3 first, then prod"], [q2!]: ["Only the on-call person"], [q3!]: ["tonight"],
    } } });
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
