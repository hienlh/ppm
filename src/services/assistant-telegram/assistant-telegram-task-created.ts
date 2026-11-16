/**
 * A task the PPM Assistant created from a Telegram message comes back to that chat as a card of its
 * own: the task, what happened to the project's manager, and buttons to set urgency, importance
 * and due date, undo the creation, or open it in PPM.
 *
 * Cards are posted when the Assistant's turn ends, not when the task is written: the Assistant asks
 * "Tell the <project> manager now?" during the turn (plan Decision 3), and the card only reports
 * what came of that — "was told" once the manager's news moved past the task's creation, "will see
 * it on its next turn" otherwise. The card never asks a second time.
 *
 * Its buttons act as the user (`via: telegram`), each checked against the revision the card last
 * showed. Only creations in a turn the user wrote from Telegram get a card: an unattended turn's
 * changes are on the "while you were away" card instead.
 */
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { resolveMigratedSession } from "../db.service.ts";
import { telegramChatsBoundTo } from "../assistant-hub/assistant-hub-db.ts";
import { assistantClock, type AssistantClock } from "../assistant-wake/assistant-clock.ts";
import { notificationLink } from "../notification-link.ts";
import { pendingManagerNews } from "../ppm-tasks/ppm-tasks-deliver.ts";
import { PpmTaskError, TaskConflictError } from "../ppm-tasks/ppm-tasks-errors.ts";
import { ppmTasksEvents, type PpmTasksEvent } from "../ppm-tasks/ppm-tasks-events.ts";
import { undoChange } from "../ppm-tasks/ppm-tasks-history.ts";
import { softDeleteTask, updateTask } from "../ppm-tasks/ppm-tasks.service.ts";
import { managerSessionFor } from "../ppm-tasks/ppm-tasks-write.ts";
import { IMPORTANCES, URGENCIES, type TaskPatch } from "../../shared/ppm-tasks.ts";
import { truncateText } from "../notification-format.ts";
import type { InlineKeyboardButton } from "../telegram/telegram-types.ts";
import { canSendTo } from "./assistant-telegram-access.ts";
import type { BridgeAction, TaskPress } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import { placeLink } from "./assistant-telegram-links.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { IMPORTANCE_LABEL, URGENCY_LABEL, createdCardHtml, inRows } from "./assistant-telegram-task-card.ts";
import { GONE_TOAST, editCard, telegramUserCtx } from "./assistant-telegram-task-common.ts";
import { showableTask, taskDetail, taskFacts, taskProjectName, todayYmd } from "./assistant-telegram-tasks-deck.ts";
import { getTask } from "../ppm-tasks/ppm-tasks.service.ts";
import { createLogger } from "../logger.ts";
import { MESSAGE_ABOUT_TASK_LABEL } from "./assistant-telegram-task-message.ts";

const log = createLogger("assistant-telegram");

/** Most cards one turn posts; past that, one line points at `/tasks`. */
export const CREATED_CARDS_PER_TURN = 5;
const MAX_CARDS = 200;
const MAX_SESSIONS = 64;

const DUE_CHOICES: Array<{ value: string; label: string; days: number | null }> = [
  { value: "0", label: "Today", days: 0 },
  { value: "1", label: "Tomorrow", days: 1 },
  { value: "3", label: "In 3 days", days: 3 },
  { value: "7", label: "In a week", days: 7 },
  { value: "none", label: "No due date", days: null },
];

/** `YYYY-MM-DD` `days` after `today`. */
export function addDays(today: string, days: number): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

interface CreatedCard {
  id: string;
  chatId: string;
  messageId: number | null;
  taskId: string;
  createdHistoryId: number;
  /** The task's revision the card shows; a press is checked against it. */
  revision: number;
  managerLine: string | null;
  /** The link to the task in PPM, when it cannot be a button. */
  inlineLink: string | null;
  linkButton: InlineKeyboardButton | null;
  menu: "urgency" | "importance" | "due" | null;
  undone: boolean;
  seq: number;
}

export interface TaskCreatedDeps {
  queue: AssistantTelegramSendQueue;
  codes: ButtonCodes<BridgeAction>;
  clock?: AssistantClock;
  /** The link that opens the task's project in PPM. */
  taskLink?: (projectName: string, taskId: string) => Promise<string>;
  /** Which chats see this Assistant session (bound to it and reachable). */
  chatsOf?: (sessionId: string) => string[];
}

const liveTaskLink = (projectName: string, taskId: string): Promise<string> =>
  notificationLink({ project: projectName, sessionId: "", path: `/project/${encodeURIComponent(projectName)}?openTask=${encodeURIComponent(taskId)}` });

export class AssistantTelegramTaskCreated {
  private readonly cards = new Map<string, CreatedCard>();
  /** Per Assistant session, the tasks it created from Telegram in the turn running now. */
  private readonly pending = new Map<string, Array<{ taskId: string; historyId: number }>>();
  private readonly clock: AssistantClock;
  private offs: Array<() => void> = [];

  constructor(private readonly deps: TaskCreatedDeps) {
    this.clock = deps.clock ?? assistantClock;
  }

  attach(): void {
    if (this.offs.length) return;
    this.offs = [
      ppmTasksEvents.on((e) => this.onTaskEvent(e)),
      chatLifecycle.on("turn_ended", (e) => { if (!e.turnStillRunning) void this.flush(e.sessionId); }),
      chatLifecycle.on("migrated", (e) => {
        const list = this.pending.get(e.oldSessionId);
        if (!list) return;
        this.pending.delete(e.oldSessionId);
        this.pending.set(e.newSessionId, [...(this.pending.get(e.newSessionId) ?? []), ...list]);
      }),
    ];
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.pending.clear();
    this.cards.clear();
  }

  forgetChat(chatId: string): void {
    for (const [id, card] of this.cards) {
      if (card.chatId !== chatId) continue;
      this.deps.codes.dropGroup(groupOf(card));
      this.cards.delete(id);
    }
  }

  private onTaskEvent(e: PpmTasksEvent): void {
    if (e.type !== "task" || e.kind !== "created" || e.actor.kind !== "assistant" || e.via !== "telegram" || e.unattended) return;
    if (!e.actor.sessionId) return;
    const key = resolveMigratedSession(e.actor.sessionId);
    const list = this.pending.get(key) ?? [];
    e.taskIds.forEach((taskId, i) => { if (e.historyIds[i] !== undefined) list.push({ taskId, historyId: e.historyIds[i]! }); });
    this.pending.delete(key);
    this.pending.set(key, list);
    while (this.pending.size > MAX_SESSIONS) this.pending.delete(this.pending.keys().next().value!);
  }

  /** Posts the cards of the tasks this turn created, to the chats that see the session. */
  async flush(sessionId: string): Promise<void> {
    const key = resolveMigratedSession(sessionId);
    const created = this.pending.get(key) ?? this.pending.get(sessionId);
    this.pending.delete(key);
    this.pending.delete(sessionId);
    if (!created?.length) return;
    let chats: string[];
    try {
      chats = (this.deps.chatsOf ?? ((s) => telegramChatsBoundTo(s)))(key).filter(canSendTo);
    } catch (e) {
      log.warn(`created-task cards: could not tell which chats see ${key}: ${(e as Error).message}`);
      return;
    }
    if (!chats.length) return;
    for (const item of created.slice(0, CREATED_CARDS_PER_TURN)) {
      const task = showableTask(item.taskId);
      if (!task) continue;
      const projectName = taskProjectName(task.projectKey);
      const url = await (this.deps.taskLink ?? liveTaskLink)(projectName, task.id).catch(() => null);
      const link = url ? placeLink(url) : {};
      for (const chatId of chats) {
        this.post({
          id: crypto.randomUUID().slice(0, 12), chatId, messageId: null, taskId: task.id, createdHistoryId: item.historyId,
          revision: task.revision, managerLine: this.managerLine(task.projectKey, projectName, item.historyId),
          inlineLink: link.inline ?? null, linkButton: link.button ?? null, menu: null, undone: false, seq: 0,
        });
      }
    }
    const more = created.length - CREATED_CARDS_PER_TURN;
    if (more > 0) {
      for (const chatId of chats) {
        this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html: `…and ${more} more task${more === 1 ? "" : "s"} created. Send /tasks to see them.` }, { label: "created tasks" }));
      }
    }
  }

  /** What became of the manager: told (its news moved past the creation), or not yet. */
  private managerLine(projectKey: string, projectName: string, historyId: number): string | null {
    if (!managerSessionFor(projectKey)) return null;
    const waiting = pendingManagerNews(projectKey, this.clock.now()).history.some((h) => h.id === historyId);
    return waiting ? `The ${projectName} manager will see it on its next turn.` : `The ${projectName} manager chat was told.`;
  }

  private post(card: CreatedCard): void {
    while (this.cards.size >= MAX_CARDS) {
      const [id, old] = this.cards.entries().next().value!;
      this.deps.codes.dropGroup(groupOf(old));
      this.cards.delete(id);
    }
    this.cards.set(card.id, card);
    const { html, rows } = this.draw(card);
    this.deps.queue.enqueue(card.chatId, sendMessageTask(this.deps.queue, card.chatId, {
      html, ...(rows.length ? { markup: { inline_keyboard: rows } } : {}),
    }, {
      label: "created task card",
      onSent: (sent) => { card.messageId = sent.message_id; },
      onDropped: () => { this.deps.codes.dropGroup(groupOf(card)); this.cards.delete(card.id); },
    }));
  }

  private redraw(card: CreatedCard, note?: string): void {
    if (card.messageId === null) return;
    const { html, rows } = this.draw(card, note);
    editCard(this.deps.queue, card.chatId, card.messageId, html, rows);
  }

  private draw(card: CreatedCard, note?: string): { html: string; rows: InlineKeyboardButton[][] } {
    this.deps.codes.dropGroup(groupOf(card));
    card.seq++;
    const group = groupOf(card);
    const key = (text: string, press: Omit<TaskPress, "kind" | "ref">): InlineKeyboardButton =>
      ({ text, callback_data: this.deps.codes.mint(card.chatId, group, { kind: "task", ref: card.id, ...press }) });
    const task = getTask(card.taskId);
    if (!task) return { html: "<i>This task is no longer there.</i>", rows: [] };
    // The buttons stand for what is drawn: a press is checked against this revision.
    card.revision = task.revision;
    const now = this.clock.now();
    const ctx = { detail: taskDetail(task.projectKey), today: todayYmd(now), now };
    let html = createdCardHtml(taskFacts(task), ctx, { managerLine: card.managerLine, ...(note ? { note } : {}), undone: card.undone });
    if (card.undone || task.deletedAt !== null) return { html, rows: [] };
    if (card.inlineLink) html += `\n\n${card.inlineLink}`;
    const linkRow = card.linkButton ? [card.linkButton] : [];
    if (card.menu) {
      const choices = card.menu === "urgency"
        ? URGENCIES.map((u) => ({ value: u, label: URGENCY_LABEL[u], on: task.urgency === u }))
        : card.menu === "importance"
          ? IMPORTANCES.map((i) => ({ value: i, label: IMPORTANCE_LABEL[i], on: task.importance === i }))
          : DUE_CHOICES.map((d) => ({ value: d.value, label: d.label, on: d.days === null ? task.dueDate === null : task.dueDate === addDays(ctx.today, d.days) }));
      const buttons = choices.map((c) => key(c.on ? `● ${c.label}` : c.label, { op: "set", field: card.menu!, value: c.value }));
      return { html, rows: [...inRows(buttons, 3), [key("‹ Back", { op: "back" })]] };
    }
    return {
      html,
      rows: [
        [key("Urgency", { op: "menu", field: "urgency" }), key("Importance", { op: "menu", field: "importance" }), key("Due", { op: "menu", field: "due" })],
        [key("↶ Undo", { op: "undo_created" }), ...linkRow],
        [key(MESSAGE_ABOUT_TASK_LABEL, { op: "about", taskId: card.taskId })],
      ],
    };
  }

  /** The task a created card of this chat shows; null when that message is no such card. */
  taskAt(chatId: string, messageId: number): string | null {
    for (const card of this.cards.values()) if (card.chatId === chatId && card.messageId === messageId && !card.undone) return card.taskId;
    return null;
  }

  /** Whether this press belongs to a created-task card. */
  owns(ref: string): boolean {
    return this.cards.has(ref);
  }

  /** Acts on a created card's button; the toast to show. */
  press(chatId: string, press: TaskPress, group: string): string {
    const card = this.cards.get(press.ref);
    if (!card || card.chatId !== chatId) {
      this.deps.codes.dropGroup(group);
      return GONE_TOAST;
    }
    if (group !== groupOf(card)) return "This button is no longer valid.";
    this.deps.codes.dropGroup(group);
    try {
      return this.act(card, press);
    } catch (e) {
      log.warn(`created task card press ${press.op} failed: ${(e as Error).message}`);
      this.redraw(card);
      return "Something went wrong; see PPM's log.";
    }
  }

  private act(card: CreatedCard, press: TaskPress): string {
    if (press.op === "menu" && press.field) {
      card.menu = press.field;
      this.redraw(card);
      return press.field === "due" ? "Pick a due date" : `Pick the ${press.field}`;
    }
    if (press.op === "back") {
      card.menu = null;
      this.redraw(card);
      return "Back";
    }
    if (press.op === "set" && press.field && press.value !== undefined) return this.set(card, press.field, press.value);
    if (press.op === "undo_created") return this.undoCreated(card);
    this.redraw(card);
    return "This button is no longer valid.";
  }

  private set(card: CreatedCard, field: "urgency" | "importance" | "due", value: string): string {
    let patch: TaskPatch;
    let toast: string;
    if (field === "urgency" && (URGENCIES as readonly string[]).includes(value)) {
      patch = { urgency: value as TaskPatch["urgency"] };
      toast = `Urgency: ${URGENCY_LABEL[value as keyof typeof URGENCY_LABEL]}`;
    } else if (field === "importance" && (IMPORTANCES as readonly string[]).includes(value)) {
      patch = { importance: value as TaskPatch["importance"] };
      toast = `Importance: ${IMPORTANCE_LABEL[value as keyof typeof IMPORTANCE_LABEL]}`;
    } else if (field === "due") {
      const choice = DUE_CHOICES.find((d) => d.value === value);
      if (!choice) { this.redraw(card); return "This button is no longer valid."; }
      patch = { dueDate: choice.days === null ? null : addDays(todayYmd(this.clock.now()), choice.days) };
      toast = choice.days === null ? "No due date" : `Due ${patch.dueDate}`;
    } else {
      this.redraw(card);
      return "This button is no longer valid.";
    }
    card.menu = null;
    try {
      card.revision = updateTask(card.taskId, patch, card.revision, telegramUserCtx()).revision;
    } catch (e) {
      const task = getTask(card.taskId);
      if (task) card.revision = task.revision;
      if (e instanceof TaskConflictError) {
        this.redraw(card, "Changed elsewhere — here is the current state.");
        return "Changed elsewhere";
      }
      this.redraw(card);
      if (e instanceof PpmTaskError) return truncateText(e.message, 150);
      throw e;
    }
    this.redraw(card);
    return toast;
  }

  /**
   * Undoes the creation: the AI change itself when nothing else touched the task, else (only the
   * user's own edits from this card since, i.e. the revision the card shows) the task is deleted.
   */
  private undoCreated(card: CreatedCard): string {
    const task = getTask(card.taskId);
    if (!task || task.deletedAt !== null) {
      card.undone = true;
      this.redraw(card);
      return "Already removed.";
    }
    if (task.revision !== card.revision) {
      card.revision = task.revision;
      this.redraw(card, "Changed elsewhere — here is the current state.");
      return "Changed elsewhere — not undone.";
    }
    const ctx = telegramUserCtx("Undo from Telegram");
    try {
      if (task.revision === 1) undoChange(card.createdHistoryId, ctx, this.clock.now());
      else softDeleteTask(card.taskId, card.revision, ctx, this.clock.now());
    } catch (e) {
      this.redraw(card);
      return e instanceof PpmTaskError ? truncateText(e.message, 150) : "Could not undo; see PPM's log.";
    }
    card.undone = true;
    this.redraw(card);
    return "Undone";
  }
}

const groupOf = (card: CreatedCard): string => `task-created:${card.id}:${card.seq}`;
