/**
 * A question card asked one question at a time, inside one Telegram message.
 *
 * Several questions in one message, with every choice of every question in one column of buttons,
 * left a phone with buttons whose question was cut off — nobody could tell which button answered
 * what. So a card with more than one question, or one question that takes several choices, shows
 * only the question being asked ("Question 2/3", the question, its choices and their
 * descriptions) with that question's buttons under it, each naming its whole choice. Picking a
 * single choice moves on; a question that takes several ticks choices (✓) and moves on with Next;
 * Back returns to the question before. After the last question comes a summary of every answer
 * with Send and Back, and only Send answers the card — all questions at once, never part of them.
 *
 * Moving between steps edits the same message (text and buttons), so the chat does not fill up
 * with one message per question. Every button's code is made once, when the card is shown: the
 * steps only choose which of them to show.
 *
 * This module only draws; `assistant-telegram-cards.ts` holds the state and answers the presses.
 */
import type { NormalizedQuestion } from "../../shared/approval-questions.ts";
import type { InlineKeyboardButton } from "../telegram/telegram-types.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { questionBlock } from "./assistant-telegram-card-format.ts";
import type { CardPress } from "./assistant-telegram-actions.ts";

const LABEL_MAX = 60;
/** How much of a question the summary repeats, and of its answers. */
const SUMMARY_QUESTION_MAX = 200;
const SUMMARY_ANSWER_MAX = 300;

export type Mint = (press: Omit<CardPress, "kind" | "sessionId" | "requestId">) => string;

/** The ticked or picked choices so far, by question id. */
export type Selection = Map<string, string[]>;

/** User text in a card, cut to `max`: secrets hidden before the cut, so a cut cannot split one. */
const shortHtml = (raw: string, max: number) =>
  escapeTelegramHtml(cutChars(redactForTelegram(raw).trim().replace(/\n{3,}/g, "\n\n"), max));

/**
 * Text cut to `max` characters with an ellipsis. Counted in characters, not UTF-16 units: half
 * of an emoji is not valid text, and Telegram refusing it would leave the card stuck on a step.
 */
function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** A button's text: plain, so not escaped, but redacted like everything else sent. */
export function buttonLabel(raw: string): string {
  return cutChars(redactForTelegram(raw), LABEL_MAX);
}

/** One question with one choice is answered with one press; anything else is asked step by step. */
export function asksStepByStep(questions: readonly NormalizedQuestion[]): boolean {
  return !(questions.length === 1 && !questions[0]!.multiSelect);
}

/** Every button of a step-by-step card, made once. */
export interface WizardCodes {
  /** [question][option]: a pick for a one-choice question, a toggle for one that takes several. */
  choices: string[][];
  /** [question]: Next, made only for questions that take several choices. */
  next: (string | null)[];
  /** [step]: Back, made for every step after the first (the summary is step `questions.length`). */
  back: (string | null)[];
  send: string;
}

/** Where a step-by-step card is: its step (`questions.length` is the summary) and its buttons. */
export interface WizardState {
  step: number;
  codes: WizardCodes;
}

export const EARLIER_STEP = "This button is from an earlier step.";
const INVALID = "This button is no longer valid.";

/**
 * A press that does not answer the card: picks or ticks a choice, or moves between questions.
 * Only a button of the step on screen counts. One left over from another step (a double tap while
 * the message was being edited, or a message that fell behind) changes nothing, but asks for a
 * redraw so the message catches up with the card.
 */
export function applyWizardPress(
  questions: readonly NormalizedQuestion[],
  wizard: WizardState,
  selection: Selection,
  press: Pick<CardPress, "op" | "questionId" | "option" | "step">,
): { toast: string; redraw: boolean } {
  if (press.op === "back") {
    if (press.step !== wizard.step || wizard.step === 0) return { toast: EARLIER_STEP, redraw: true };
    wizard.step--;
    return { toast: "Back.", redraw: true };
  }
  const q = questions[wizard.step];
  if (!q || press.questionId !== q.id) return { toast: EARLIER_STEP, redraw: true };
  const movedOn = () => {
    wizard.step++;
    return { toast: wizard.step < questions.length ? "Next question." : "Check your answers, then Send.", redraw: true };
  };
  if (press.op === "next") {
    if (!q.multiSelect) return { toast: INVALID, redraw: false };
    return selection.get(q.id)?.length ? movedOn() : { toast: "Tick at least one choice first.", redraw: false };
  }
  const option = q.options.find((o) => o.label === press.option)?.label;
  if (option === undefined || (press.op !== "pick" && press.op !== "toggle") || (press.op === "pick") === q.multiSelect) {
    return { toast: INVALID, redraw: false };
  }
  if (press.op === "pick") {
    selection.set(q.id, [option]);
    return movedOn();
  }
  const now = selection.get(q.id) ?? [];
  const on = !now.includes(option);
  // Kept in the order the choices are listed, whatever order they were ticked in.
  const next = q.options.map((o) => o.label).filter((l) => (l === option ? on : now.includes(l)));
  if (next.length) selection.set(q.id, next);
  else selection.delete(q.id);
  return { toast: on ? "Ticked." : "Unticked.", redraw: true };
}

export function mintWizardCodes(questions: readonly NormalizedQuestion[], mint: Mint): WizardCodes {
  return {
    choices: questions.map((q) => q.options.map((o) => mint({ op: q.multiSelect ? "toggle" : "pick", questionId: q.id, option: o.label }))),
    next: questions.map((q) => (q.multiSelect ? mint({ op: "next", questionId: q.id }) : null)),
    back: Array.from({ length: questions.length + 1 }, (_, step) => (step > 0 ? mint({ op: "back", step }) : null)),
    send: mint({ op: "send" }),
  };
}

/** A question as the summary repeats it. */
const asked = (q: NormalizedQuestion) => (q.header ? `${q.header} — ${q.question}` : q.question);

/** The text of one step: a question (step < questions.length), or the summary. */
export function wizardStepHtml(questions: readonly NormalizedQuestion[], step: number, selection: Selection, headline: string): string {
  const lines = [`❓ <b>${escapeTelegramHtml(headline)}</b>`];
  const q = questions[step];
  if (q) {
    lines.push(`<b>Question ${step + 1}/${questions.length}</b>`, "", ...questionBlock(q));
    return lines.join("\n");
  }
  lines.push("<b>Your answers</b> — check them, then Send.");
  questions.forEach((x, i) => {
    const answer = selection.get(x.id)?.join(", ");
    lines.push("", `${i + 1}. ${shortHtml(asked(x), SUMMARY_QUESTION_MAX)}`, answer ? `→ <b>${shortHtml(answer, SUMMARY_ANSWER_MAX)}</b>` : "→ <i>not answered</i>");
  });
  return lines.join("\n");
}

/** The buttons of one step. */
export function wizardStepRows(questions: readonly NormalizedQuestion[], step: number, selection: Selection, codes: WizardCodes): InlineKeyboardButton[][] {
  const back = codes.back[step] ? [{ text: "« Back", callback_data: codes.back[step]! }] : [];
  const q = questions[step];
  if (!q) return [[...back, { text: "Send", callback_data: codes.send }]];
  const chosen = selection.get(q.id) ?? [];
  const rows: InlineKeyboardButton[][] = q.options.map((o, i) => [{
    text: `${chosen.includes(o.label) ? "✓ " : ""}${buttonLabel(o.label)}`,
    callback_data: codes.choices[step]![i]!,
  }]);
  const next = codes.next[step] ? [{ text: "Next »", callback_data: codes.next[step]! }] : [];
  if (back.length || next.length) rows.push([...back, ...next]);
  return rows;
}

/**
 * What the message says once the card is no longer waiting: the questions, numbered, without
 * their choices — the line under it says how it ended and what was answered.
 */
export function questionListHtml(questions: readonly NormalizedQuestion[], headline: string): string {
  const lines = [`❓ <b>${escapeTelegramHtml(headline)}</b>`];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${shortHtml(asked(q), SUMMARY_QUESTION_MAX)}`);
  });
  return lines.join("\n");
}

/**
 * The longest each step can get, for the length check made before the card is shown: every
 * question as it is, and the summary with every choice of every question picked.
 */
export function wizardWorstCaseSteps(questions: readonly NormalizedQuestion[], headline: string): string[] {
  const all: Selection = new Map(questions.map((q) => [q.id, q.options.map((o) => o.label)]));
  return Array.from({ length: questions.length + 1 }, (_, step) => wizardStepHtml(questions, step, all, headline));
}
