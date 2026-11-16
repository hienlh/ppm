/**
 * `/tasks` on Telegram: one task per card, changed in place by its buttons, with no AI turn.
 *
 * - A status button writes the task as the user (`via: telegram`), checked against the revision
 *   the card showed: someone else's change in between is never overwritten, the card is redrawn
 *   with "Changed elsewhere" instead.
 * - After a status change in a project with a manager chat, the card asks "Tell manager now?"
 *   (once per task per deck) and moves on only once that is answered; otherwise it moves on to the
 *   next task by itself after two seconds. Undo stays on top of the next card.
 * - Every redraw mints the card's buttons as one new group and drops the last one, so a second
 *   press on an old keyboard (or a press racing the auto-advance) is "no longer valid".
 */
import { assistantClock, type AssistantClock } from "../assistant-wake/assistant-clock.ts";
import { wakeManager, type DeliverOutcome } from "../ppm-tasks/ppm-tasks-deliver.ts";
import { PpmTaskError, TaskConflictError } from "../ppm-tasks/ppm-tasks-errors.ts";
import { listStatuses } from "../ppm-tasks/ppm-tasks-project-config.ts";
import { updateTask } from "../ppm-tasks/ppm-tasks.service.ts";
import { managerSessionFor } from "../ppm-tasks/ppm-tasks-write.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import type { InlineKeyboardButton, TelegramCallbackQuery } from "../telegram/telegram-types.ts";
import type { BridgeAction, TaskPress } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { GONE_TOAST, buttonText, editCard, telegramUserCtx } from "./assistant-telegram-task-common.ts";
import { cardAt, drawDeck } from "./assistant-telegram-tasks-deck-draw.ts";
import {
  DeckStore, clockTime, deckTaskIds, enabledTaskProjects, findTaskProject, openChildren, showableTask, taskProjectName, type Deck,
} from "./assistant-telegram-tasks-deck.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/** How long a status change's result stays before the next task, when nothing is asked. */
export const AUTO_ADVANCE_MS = 2000;

export interface TaskTelegramDeps {
  queue: AssistantTelegramSendQueue;
  codes: ButtonCodes<BridgeAction>;
  /** The Assistant's clock: the auto-advance runs on it, so tests move time instead of waiting. */
  clock?: AssistantClock;
  /** "Tell manager now": one turn into the project's manager chat. */
  wake?: (projectKey: string) => Promise<DeliverOutcome>;
  hasManager?: (projectKey: string) => boolean;
}

export class AssistantTelegramTasks {
  readonly decks = new DeckStore((deck) => this.deps.codes.dropGroup(groupOf(deck)));
  private readonly clock: AssistantClock;

  constructor(private readonly deps: TaskTelegramDeps) {
    this.clock = deps.clock ?? assistantClock;
  }

  private hasManager(projectKey: string): boolean {
    try { return (this.deps.hasManager ?? ((k) => managerSessionFor(k) !== null))(projectKey); } catch { return false; }
  }

  /** `/tasks [project]`: a new deck, sent as a new message. */
  showDeck(chatId: string, args: string, reply: (html: string) => void): void {
    const projects = enabledTaskProjects();
    if (!projects.length) return reply("No project has Tasks switched on. Turn them on in PPM (the project's Tasks settings).");
    let projectKey: string | null = null;
    if (args.trim()) {
      const found = findTaskProject(args, projects);
      if (!found) {
        const names = projects.map((p) => `<code>${escapeTelegramHtml(p.name)}</code>`).join(", ");
        return reply(`No project called "${escapeTelegramHtml(truncateText(args.trim(), 60))}" has Tasks on. Try: ${names}.`);
      }
      projectKey = found.projectKey;
    }
    // One deck per chat: an older one's buttons would only hold codes the bot's other cards need.
    this.forgetChat(chatId);
    const deck = this.decks.create(chatId, projectKey);
    const { html, rows } = this.draw(deck);
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html, ...(rows.length ? { markup: { inline_keyboard: rows } } : {}) }, {
      label: "tasks deck",
      onSent: (sent) => { deck.messageId = sent.message_id; },
      onDropped: () => { this.dropDeck(deck.id); },
    }));
  }

  /** The chat was disconnected: its decks and their buttons go. */
  forgetChat(chatId: string): void {
    for (const deck of this.decks.dropChat(chatId)) this.deps.codes.dropGroup(groupOf(deck));
  }

  stop(): void {
    this.decks.clear();
  }

  private dropDeck(id: string): void {
    const deck = this.decks.drop(id);
    if (deck) this.deps.codes.dropGroup(groupOf(deck));
  }

  /** Acts on a deck button; the toast to show. */
  async press(chatId: string, press: TaskPress, group: string, _cq: TelegramCallbackQuery): Promise<string> {
    const deck = this.decks.get(press.ref, chatId);
    if (!deck) {
      this.deps.codes.dropGroup(group);
      return GONE_TOAST;
    }
    if (press.op === "position") return `Task ${deck.index + 1} of ${deck.taskIds.length}`;
    if (group !== groupOf(deck)) return "This button is no longer valid.";
    this.deps.codes.dropGroup(group);
    try {
      return await this.act(deck, press);
    } catch (e) {
      log.warn(`/tasks press ${press.op} in chat ${chatId} failed: ${(e as Error).message}`);
      this.redraw(deck);
      return "Something went wrong; see PPM's log.";
    }
  }

  private async act(deck: Deck, press: TaskPress): Promise<string> {
    switch (press.op) {
      case "status": return this.changeStatus(deck, press.taskId!, press.statusId!);
      case "tell": return this.tell(deck, true);
      case "later": return this.tell(deck, false);
      case "undo": return this.undo(deck);
      case "next": this.advance(deck); return "Next task";
      case "prev":
      case "next_page": {
        this.cancelAdvance(deck);
        const n = deck.taskIds.length;
        if (n) deck.index = (deck.index + (press.op === "prev" ? n - 1 : 1)) % n;
        this.showCard(deck);
        return `Task ${Math.min(deck.index + 1, n)} of ${n}`;
      }
      case "filter": {
        this.cancelAdvance(deck);
        deck.projectKey = press.projectKey ?? null;
        deck.taskIds = deckTaskIds(deck.projectKey);
        deck.index = 0;
        this.showCard(deck);
        return deck.projectKey ? taskProjectName(deck.projectKey) : "All projects";
      }
      case "children": {
        if (deck.view.kind !== "result") {
          this.redraw(deck);
          return "This button is no longer valid.";
        }
        this.cancelAdvance(deck);
        deck.view = { kind: "children", taskId: deck.view.taskId, back: deck.view };
        this.redraw(deck);
        return "Open child tasks";
      }
      case "back": {
        if (deck.view.kind === "children") deck.view = deck.view.back;
        if (deck.view.kind === "result" && !deck.view.askTell) this.scheduleAdvance(deck);
        this.redraw(deck);
        return "Back";
      }
      default:
        this.redraw(deck);
        return "This button is no longer valid.";
    }
  }

  private changeStatus(deck: Deck, taskId: string, statusId: string): string {
    if (deck.view.kind !== "card" || deck.view.taskId !== taskId) {
      this.redraw(deck);
      return "This button is no longer valid.";
    }
    const task = showableTask(taskId);
    if (!task) {
      this.showCard(deck);
      return "This task is no longer there.";
    }
    let updated;
    try {
      updated = updateTask(taskId, { statusId }, deck.view.revision, telegramUserCtx());
    } catch (e) {
      if (e instanceof TaskConflictError) {
        this.showCard(deck, "Changed elsewhere — here is the current state.");
        return "Changed elsewhere";
      }
      if (e instanceof PpmTaskError) {
        this.showCard(deck);
        return truncateText(e.message, 150);
      }
      throw e;
    }
    const statuses = listStatuses(task.projectKey);
    const name = (id: string) => statuses.find((s) => s.id === id)?.name ?? "Unknown status";
    deck.undo = { taskId, title: task.title, fromStatusId: task.statusId, revisionAfter: updated.revision };
    const askTell = this.hasManager(task.projectKey) && !deck.asked.has(taskId);
    if (askTell) deck.asked.add(taskId);
    deck.view = {
      kind: "result", taskId, askTell,
      change: { from: name(task.statusId), to: name(statusId), at: clockTime(this.clock.now()), openChildren: openChildren(taskId).length },
    };
    this.redraw(deck);
    if (!askTell) this.scheduleAdvance(deck);
    return `Marked ${buttonText(name(statusId), 60)}`;
  }

  /** The answer to "Tell manager now?": wake it now, or leave the news for its next turn. */
  private async tell(deck: Deck, now: boolean): Promise<string> {
    if (deck.view.kind !== "result" || !deck.view.askTell) {
      this.redraw(deck);
      return "This button is no longer valid.";
    }
    const view = deck.view;
    const task = showableTask(view.taskId);
    const projectName = task ? taskProjectName(task.projectKey) : "project";
    let toast = `The ${projectName} manager will see it on its next turn`;
    if (now && task) {
      const outcome = await (this.deps.wake ?? ((k) => wakeManager(k, { kind: "user", label: "You" })))(task.projectKey)
        .catch((e): DeliverOutcome => ({ ok: false, reason: "error", error: (e as Error).message }));
      if (outcome.ok) toast = `Sent to the ${projectName} manager`;
      else if (outcome.reason !== "nothing") log.info(`/tasks: the ${projectName} manager was not woken (${outcome.reason}${outcome.error ? `: ${outcome.error}` : ""})`);
    }
    // The deck may have moved on while the wake was sent (the user cannot press, but a filter press
    // queued behind this one can): only the view that asked takes the answer.
    if (deck.view === view && this.decks.get(deck.id, deck.chatId)) {
      deck.view = { ...view, askTell: false, change: { ...view.change, managerLine: `${toast}.` } };
      this.redraw(deck);
      this.scheduleAdvance(deck);
    }
    return toast;
  }

  /** Puts the last status press back, if nobody changed the task since. */
  private undo(deck: Deck): string {
    const undo = deck.undo;
    deck.undo = null;
    this.cancelAdvance(deck);
    if (!undo) {
      this.redraw(deck);
      return "Nothing to undo.";
    }
    const task = showableTask(undo.taskId);
    if (!task || task.revision !== undo.revisionAfter) {
      this.redraw(deck);
      return "Changed since — not undone.";
    }
    try {
      updateTask(undo.taskId, { statusId: undo.fromStatusId }, undo.revisionAfter, telegramUserCtx("Undo from Telegram"));
    } catch (e) {
      this.redraw(deck);
      return e instanceof TaskConflictError ? "Changed since — not undone." : truncateText((e as Error).message, 150);
    }
    const at = deck.taskIds.indexOf(undo.taskId);
    if (at >= 0) deck.index = at;
    else { deck.taskIds.splice(deck.index, 0, undo.taskId); }
    this.showCard(deck);
    return "Undone";
  }

  private cancelAdvance(deck: Deck): void {
    deck.cancelAdvance?.();
    deck.cancelAdvance = null;
  }

  private scheduleAdvance(deck: Deck): void {
    this.cancelAdvance(deck);
    const view = deck.view;
    deck.cancelAdvance = this.clock.setTimer(() => {
      deck.cancelAdvance = null;
      // Only the result that scheduled it moves on: a press since has drawn something else.
      if (deck.view === view && this.decks.get(deck.id, deck.chatId)) this.advance(deck);
    }, AUTO_ADVANCE_MS);
  }

  /** On to the next task that is still open (the current one is skipped). */
  private advance(deck: Deck): void {
    this.cancelAdvance(deck);
    for (let i = deck.index + 1; i < deck.taskIds.length; i++) {
      const task = showableTask(deck.taskIds[i]!);
      if (task && task.baseGroup !== "closed") {
        deck.index = i;
        return this.showCard(deck);
      }
    }
    deck.index = deck.taskIds.length;
    deck.view = { kind: "empty", finished: true };
    this.redraw(deck);
  }

  /** Shows the task at the deck's index; tasks gone since the deck was made drop out on the way. */
  private showCard(deck: Deck, note?: string): void {
    deck.view = cardAt(deck, note);
    this.redraw(deck);
  }

  private redraw(deck: Deck): void {
    if (deck.messageId === null) return;
    const { html, rows } = this.draw(deck);
    editCard(this.deps.queue, deck.chatId, deck.messageId, html, rows);
  }

  /** The deck's message as it stands, with a fresh group of buttons. */
  private draw(deck: Deck): { html: string; rows: InlineKeyboardButton[][] } {
    this.deps.codes.dropGroup(groupOf(deck));
    deck.seq++;
    const group = groupOf(deck);
    return drawDeck(deck, (text, press) =>
      ({ text, callback_data: this.deps.codes.mint(deck.chatId, group, { kind: "task", ref: deck.id, ...press }) }), this.clock.now());
  }
}

const groupOf = (deck: Deck): string => `tasks:${deck.id}:${deck.seq}`;
