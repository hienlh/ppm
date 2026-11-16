/**
 * Buttons PPM Tasks adds to two of the Assistant's own cards on Telegram:
 *
 * - The handed-off work card (`payload.tasks`): an **Open chat** per task, for the chat doing it.
 * - The "made N task changes while you were away" card (`payload.taskChanges`): an **Open chat**
 *   per task (the chat working on it, else the project's manager) and a real **Undo** per change,
 *   which undoes that history row as the user.
 *
 * An Undo is offered only for a change whose line the Telegram copy actually shows: the body is cut
 * to fit a message, and a button must never stand for a change the user cannot read. Every Undo is
 * its own group, so undoing one leaves the others; a change undone elsewhere answers with why.
 */
import { getSessionProvider } from "../db.service.ts";
import { PpmTaskError } from "../ppm-tasks/ppm-tasks-errors.ts";
import { historyRow, undoChange } from "../ppm-tasks/ppm-tasks-history.ts";
import { getTask } from "../ppm-tasks/ppm-tasks.service.ts";
import { managerSessionFor } from "../ppm-tasks/ppm-tasks-write.ts";
import { formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import type { AssistantCard } from "../../shared/assistant-cards.ts";
import { truncateText } from "../notification-format.ts";
import type { InlineKeyboardButton, TelegramCallbackQuery } from "../telegram/telegram-types.ts";
import type { TelegramBotClient } from "../telegram/telegram-bot-client.ts";
import type { BridgeAction, TaskPress } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import { placeLink, type PlacedLink } from "./assistant-telegram-links.ts";
import { outcomeOf, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { inRows } from "./assistant-telegram-task-card.ts";
import { telegramVisibleLength, TELEGRAM_CARD_ROOM } from "./assistant-telegram-card-kinds.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { buttonText, telegramUserCtx } from "./assistant-telegram-task-common.ts";
import { taskDetail, taskProjectName } from "./assistant-telegram-tasks-deck.ts";

type AwayChange = NonNullable<AssistantCard["payload"]["taskChanges"]>[number];

/** The project a listed change belongs to (an older card's change carries no `projectKey`). */
function changeProject(c: AwayChange): string | null {
  if (c.projectKey) return c.projectKey;
  const taskId = c.taskId ?? (c.historyId !== null ? historyRow(c.historyId)?.taskId : null);
  return (taskId ? getTask(taskId)?.projectKey : null) ?? null;
}

/**
 * The "while you were away" card as Telegram shows it. Its listed changes are written again from
 * `payload.taskChanges`: in full with "undo #id" (which is what an Undo button is matched against),
 * except for a project whose details stay off the phone, which gets the task's ref and title only —
 * no detail of the change and, since the change is not shown, no Undo. A change whose project PPM
 * cannot tell is treated as title-only. Any other card is returned as it is.
 */
export function cardForTelegram<T extends Pick<AssistantCard, "payload" | "body">>(card: T): T {
  const changes = card.payload.taskChanges;
  if (!changes?.length) return card;
  const lines = changes.map((c) => {
    const projectKey = changeProject(c);
    const undo = c.historyId !== null ? ` · undo #${c.historyId}` : "";
    if (projectKey && taskDetail(projectKey) === "full") return `- ${c.summary}${undo}`;
    const task = c.taskId ? getTask(c.taskId) : null;
    if (!task) return `- A settings change${projectKey ? ` in ${taskProjectName(projectKey)}` : ""} (details in PPM)`;
    return `- ${c.ref ?? formatTaskRef(task.number, taskProjectName(task.projectKey))} "${task.title.replace(/\s+/g, " ")}" (details in PPM)`;
  });
  const more = card.payload.taskChangesMore ? [`- …and ${card.payload.taskChangesMore} more (see each task's History in PPM)`] : [];
  return { ...card, body: ["Made in a turn PPM started, not one you wrote in:", ...lines, ...more].join("\n") };
}

/** Most Open chat buttons and Undo buttons one card carries. */
export const CARD_OPEN_CHATS_MAX = 8;
export const CARD_UNDOS_MAX = 25;

export interface TaskCardExtras {
  /** One per task, a URL button when it can be one (else a line in the text). */
  links: PlacedLink[];
  undos: number[];
}

type ChatLink = (project: string, providerId: string | null, sessionId: string) => Promise<string>;

/** What the card's tasks are and which chats work on them; null for a card that is not about tasks. */
export async function taskCardExtras(card: Pick<AssistantCard, "payload" | "projectName">, chatLink: ChatLink): Promise<TaskCardExtras | null> {
  const handed = card.payload.tasks ?? [];
  const changes = card.payload.taskChanges ?? [];
  if (!handed.length && !changes.length) return null;
  const chats: Array<{ ref: string; project: string; sessionId: string }> = [];
  const seen = new Set<string>();
  for (const t of handed) {
    if (seen.has(t.taskId)) continue;
    seen.add(t.taskId);
    const task = getTask(t.taskId);
    const project = task ? taskProjectName(task.projectKey) : card.projectName;
    if (project) chats.push({ ref: t.ref, project, sessionId: t.sessionId });
  }
  for (const c of changes) {
    const taskId = c.taskId ?? (c.historyId !== null ? historyRow(c.historyId)?.taskId : null);
    const task = taskId ? getTask(taskId) : null;
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    const sessionId = task.workingSessionId ?? managerSessionFor(task.projectKey);
    const project = taskProjectName(task.projectKey);
    if (sessionId) chats.push({ ref: formatTaskRef(task.number, project), project, sessionId });
  }
  const links = await Promise.all(chats.slice(0, CARD_OPEN_CHATS_MAX).map(async (c) => {
    const url = await chatLink(c.project, getSessionProvider(c.sessionId), c.sessionId).catch(() => null);
    return url ? placeLink(url, `Open chat · ${buttonText(c.ref, 30)}`) : null;
  }));
  return { links: links.filter((l): l is PlacedLink => l !== null), undos: changes.flatMap((c) => (c.historyId !== null ? [c.historyId] : [])).slice(0, CARD_UNDOS_MAX) };
}

/** The rows these extras add under a card in one chat, and the links that go in its text instead. */
export function taskCardRows(
  extras: TaskCardExtras, cardId: string, chatId: string, html: string, codes: ButtonCodes<BridgeAction>,
): { rows: InlineKeyboardButton[][]; inline: string[] } {
  // "· undo #123" is how the card's text names each change (`unattendedCard`); #12 must not match #120.
  const shown = extras.undos.filter((id) => new RegExp(`undo #${id}(?![0-9])`).test(html));
  const undo = shown.map((historyId) => ({
    text: `↶ Undo #${historyId}`,
    callback_data: codes.mint(chatId, undoGroup(cardId, chatId, historyId), { kind: "task", ref: cardId, op: "undo_history", historyId }),
  }));
  const buttons = extras.links.flatMap((l) => (l.button ? [l.button] : []));
  // A link that cannot be a button goes in the text, only while the card still fits one message.
  const inline: string[] = [];
  let length = telegramVisibleLength(html);
  for (const l of extras.links) {
    if (!l.inline) continue;
    const added = telegramVisibleLength(l.inline) + 1;
    if (length + added > TELEGRAM_CARD_ROOM) break;
    inline.push(l.inline);
    length += added;
  }
  return { rows: [...inRows(undo, 3), ...inRows(buttons, 2)], inline };
}

const undoGroup = (cardId: string, chatId: string, historyId: number): string => `task-undo:${cardId}:${chatId}:${historyId}`;

/** Undoes one listed change as the user; takes its button off the card. The toast to show. */
export function pressTaskCardUndo(
  chatId: string, press: TaskPress, group: string, cq: TelegramCallbackQuery,
  deps: { codes: ButtonCodes<BridgeAction>; queue: AssistantTelegramSendQueue; now?: () => number },
): string {
  if (press.historyId === undefined || group !== undoGroup(press.ref, chatId, press.historyId)) return "This button is no longer valid.";
  deps.codes.dropGroup(group);
  let toast: string;
  try {
    undoChange(press.historyId, telegramUserCtx("Undo from Telegram"), (deps.now ?? (() => assistantClock.now()))());
    toast = `Undone #${press.historyId}`;
  } catch (e) {
    toast = e instanceof PpmTaskError ? `Not undone: ${truncateText(e.message, 120)}` : "Could not undo; see PPM's log.";
  }
  const message = cq.message;
  const markup = message?.reply_markup;
  if (message && markup) {
    // The button goes whatever the answer: undone, or refused for a reason that will not change.
    const rows = markup.inline_keyboard.map((row) => row.filter((b) => b.callback_data !== cq.data)).filter((row) => row.length);
    let attempts = 0;
    deps.queue.enqueue(chatId, {
      final: true, label: "undo button",
      run: async (client: TelegramBotClient) => outcomeOf(await client.editMessageReplyMarkup(chatId, message.message_id, { inline_keyboard: rows }), ++attempts),
    });
  }
  return toast;
}
