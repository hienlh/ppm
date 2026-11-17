/**
 * What a `/tasks` deck's message shows for its current view, and the buttons under it. The caller
 * hands in `key`, which mints a button's code; this file only decides which buttons there are.
 *
 * - card: Undo of the last status press (when there is one), the project's status buttons, paging,
 *   and the project filter.
 * - result (after a status press): Undo, then either "Tell manager now / Next turn" (the deck moves
 *   on only once that is answered) or "Next task ›", and "Show open children" when there are any.
 * - children: the open children, with Back.
 * - empty: why there is nothing, with Undo and the filter.
 */
import type { InlineKeyboardButton } from "../telegram/telegram-types.ts";
import type { TaskPress } from "./assistant-telegram-actions.ts";
import { listStatuses } from "../ppm-tasks/ppm-tasks-project-config.ts";
import {
  childrenHtml, deckCardHtml, deckEmptyHtml, inRows, statusChoices, statusResultHtml,
} from "./assistant-telegram-task-card.ts";
import {
  deckSnoozedCount, enabledTaskProjects, openChildren, showableTask, taskDetail, taskFacts, taskProjectName, todayYmd, type Deck,
} from "./assistant-telegram-tasks-deck.ts";
import { buttonText } from "./assistant-telegram-task-common.ts";
import { formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import { MESSAGE_ABOUT_TASK_LABEL } from "./assistant-telegram-task-message.ts";

export type KeyMaker = (text: string, press: Omit<TaskPress, "kind" | "ref">) => InlineKeyboardButton;

/** Most project buttons in the filter row, besides All. */
const FILTER_PROJECTS_MAX = 11;

/**
 * The card for the task at the deck's index, dropping tasks gone since the deck was made; past the
 * end it starts over, and with nothing left it is the empty view.
 */
export function cardAt(deck: Deck, note?: string): Deck["view"] {
  if (deck.index >= deck.taskIds.length) deck.index = 0;
  while (deck.index < deck.taskIds.length) {
    const task = showableTask(deck.taskIds[deck.index]!);
    // Snoozed since the deck was made: out of the daily list, so out of the deck too.
    if (task && !task.snoozed) return { kind: "card", taskId: task.id, revision: task.revision, ...(note ? { note } : {}) };
    deck.taskIds.splice(deck.index, 1);
    if (deck.index >= deck.taskIds.length) deck.index = 0;
  }
  return { kind: "empty", finished: false };
}

/** The deck's message as it stands now. */
export function drawDeck(deck: Deck, key: KeyMaker, now: number): { html: string; rows: InlineKeyboardButton[][] } {
  // A task gone since (deleted, its project switched off) gives way to the next one there is.
  const shown = deck.view.kind === "empty" ? null : deck.view.taskId;
  if (shown ? !showableTask(shown) : deck.index < deck.taskIds.length) deck.view = cardAt(deck);
  const undoRow = deck.undo ? [[key(`↶ Undo: ${buttonText(deck.undo.title, 32)}`, { op: "undo" })]] : [];
  const total = deck.taskIds.length;
  const pos = { index: Math.min(deck.index, Math.max(total - 1, 0)), total };
  const view = deck.view;
  const ctxOf = (projectKey: string) => ({ detail: taskDetail(projectKey), today: todayYmd(now), now });

  if (view.kind === "card") {
    const task = showableTask(view.taskId)!;
    // The buttons stand for what is drawn: a press is checked against this revision.
    deck.view = { ...view, revision: task.revision };
    const html = deckCardHtml(taskFacts(task), pos, ctxOf(task.projectKey), view.note, deckSnoozedCount(deck.projectKey));
    const statuses = statusChoices(listStatuses(task.projectKey), task.statusId)
      .map((s) => key(buttonText(s.name, 24), { op: "status", taskId: task.id, statusId: s.id }));
    const paging = total > 1 ? [[key("‹", { op: "prev" }), key(`${pos.index + 1} / ${total}`, { op: "position" }), key("›", { op: "next_page" })]] : [];
    const about = [[key(MESSAGE_ABOUT_TASK_LABEL, { op: "about", taskId: task.id })]];
    return { html, rows: [...undoRow, ...inRows(statuses, 3), ...about, ...paging, ...filterRows(deck, key)] };
  }
  if (view.kind === "result") {
    const task = showableTask(view.taskId)!;
    const html = statusResultHtml(taskFacts(task), pos, view.change);
    const children = view.change.openChildren > 0 ? [[key(`Show open children (${view.change.openChildren})`, { op: "children" })]] : [];
    const rows = view.askTell
      ? [[key("↶ Undo", { op: "undo" })], [key("Tell manager now", { op: "tell" }), key("Next turn", { op: "later" })], ...children]
      : [[key("↶ Undo", { op: "undo" }), key("Next task ›", { op: "next" })], ...children];
    return { html, rows };
  }
  if (view.kind === "children") {
    const task = showableTask(view.taskId);
    const parent = task ? { ref: formatTaskRef(task.number, taskProjectName(task.projectKey)), title: task.title } : { ref: null, title: "this task" };
    return { html: childrenHtml(parent, openChildren(view.taskId)), rows: [[key("‹ Back", { op: "back" })]] };
  }
  const name = deck.projectKey ? taskProjectName(deck.projectKey) : null;
  return { html: deckEmptyHtml(name, view.finished, deckSnoozedCount(deck.projectKey)), rows: [...undoRow, ...filterRows(deck, key)] };
}

/** "All" and each project with Tasks on, the current one marked; none when there is only one. */
function filterRows(deck: Deck, key: KeyMaker): InlineKeyboardButton[][] {
  const projects = enabledTaskProjects();
  if (projects.length < 2) return [];
  const mark = (on: boolean, text: string) => (on ? `● ${text}` : text);
  const buttons = [
    key(mark(deck.projectKey === null, "All"), { op: "filter", projectKey: null }),
    ...projects.slice(0, FILTER_PROJECTS_MAX).map((p) => key(mark(deck.projectKey === p.projectKey, buttonText(p.name, 20)), { op: "filter", projectKey: p.projectKey })),
  ];
  return inRows(buttons, 4);
}
