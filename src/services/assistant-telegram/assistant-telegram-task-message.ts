/**
 * Writing to the chat that works on a task, from Telegram.
 *
 * - "💬 Message about this task" on a task card arms the chat: the user's next message goes to the
 *   task's handed-off chat, or to the project's manager chat when it was not handed off, instead of
 *   to the Assistant. The bot says which task and which chat, offers Cancel, and stops waiting after
 *   {@link TASK_MESSAGE_WINDOW_MS}.
 * - "🤖 Ask manager" does the same, but the words always go to the project's manager chat, whichever
 *   chat the task was handed to. A task that was not handed off shows only this one: both buttons
 *   would reach the manager chat (`taskWordsButtons`).
 * - A reply to a task card (a `/tasks` card, a created-task card, or the bot's own "next message
 *   goes to…" line) does the same for that one message, with nothing to arm. A reply to the line an
 *   Ask manager press drew, or to the manager's answer, goes to the manager chat again.
 *
 * The words go through `forwardUserWordsAboutTask` (`forward-verbatim.ts`): word for word, with a
 * user-words block, plus the task's block the server renders from the task store when they go to
 * the manager chat (a handed-off chat works on that one task, so it gets no block). No PPM screen typed
 * them, so the chat keeps no "chatting device". What the bot shows back only says what happened;
 * every title in it is redacted and escaped, and a project whose details stay off the phone shows
 * the task's ref and title, never its chat's title.
 */
import type { TaskView } from "../../shared/ppm-tasks.ts";
import { formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import { assistantClock, type AssistantClock } from "../assistant-wake/assistant-clock.ts";
import { forwardUserWordsAboutTask, type ForwardTarget, type SpokenWords, type TaskWordsInput, type TaskWordsResult } from "../assistant-cards/forward-verbatim.ts";
import { readSessionState, workingSessionFor } from "../ppm-tasks/link-state/session-link-state-reader.ts";
import { getTaskProject } from "../ppm-tasks/ppm-tasks-projects.service.ts";
import { isHandedOff, managerSessionFor } from "../ppm-tasks/ppm-tasks-write.ts";
import { resolveTaskRef } from "../ppm-tasks/task-chat-ref.ts";
import { escapeTelegramHtml, truncateText } from "../notification-format.ts";
import type { InlineKeyboardButton } from "../telegram/telegram-types.ts";
import type { BridgeAction, TaskPress } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import { cleanTelegramText, type CardDetail } from "./assistant-telegram-card-kinds.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { editCard } from "./assistant-telegram-task-common.ts";
import { showableTask, taskDetail, taskProjectName } from "./assistant-telegram-tasks-deck.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/** How long the next message stays meant for the task's chat. */
export const TASK_MESSAGE_WINDOW_MS = 10 * 60_000;
/** The button a task card carries for it. */
export const MESSAGE_ABOUT_TASK_LABEL = "💬 Message about this task";
/** The button that sends the words to the project's manager chat, whoever works on the task. */
export const ASK_MANAGER_LABEL = "🤖 Ask manager";
const ARMED_CHATS_MAX = 100;
const TITLE_MAX = 120;

/** Where words about a task go: the chat working on it, or the project's manager chat. */
export type TaskWordsTo = "working" | "manager";

/** The task a message is about and the chat it goes to. */
export interface TaskWordsAim {
  taskId: string;
  to: TaskWordsTo;
}

type TaskWordsKey = (text: string, press: Omit<TaskPress, "kind" | "ref">) => InlineKeyboardButton;

/**
 * The buttons a task card carries for writing about it. A task handed to a chat of its own gets
 * both "Message about this task" (that chat) and "Ask manager" (the manager chat); one that was not
 * handed off gets "Ask manager" alone, since its working chat is the manager chat; a project with no
 * manager chat keeps "Message about this task", which says what is missing when pressed.
 */
export function taskWordsButtons(key: TaskWordsKey, task: Pick<TaskView, "id" | "projectKey" | "workingSessionId">): InlineKeyboardButton[] {
  const about = key(MESSAGE_ABOUT_TASK_LABEL, { op: "about", taskId: task.id });
  if (!managerSessionFor(task.projectKey)) return [about];
  const ask = key(ASK_MANAGER_LABEL, { op: "ask", taskId: task.id });
  return isHandedOff(task.projectKey, task.workingSessionId) ? [about, ask] : [ask];
}

/** The chat that works on a task, as the bot names it. */
export interface TaskChat {
  target: ForwardTarget;
  kind: "manager" | "child";
  /** The handed-off chat's title; null for the manager or when it has none. */
  chatTitle: string | null;
  detail: CardDetail;
  ref: string;
  title: string;
}

/**
 * Who takes words about `task`: for `working` the chat working on it now (its handed-off chat, else
 * the manager chat), for `manager` the project's manager chat; or why nobody can take them.
 */
export function taskChatFor(task: TaskView, to: TaskWordsTo = "working"): TaskChat | { error: string } {
  let session: ReturnType<typeof readSessionState>;
  if (to === "manager") {
    const managerId = managerSessionFor(task.projectKey);
    if (!managerId) return { error: "This task's project has no manager chat. Start one in PPM." };
    session = readSessionState(managerId);
    if (session.state === "gone") return { error: "The project's manager chat was deleted. Pick another in PPM." };
  } else {
    const working = workingSessionFor(task);
    if (working.kind === "start_chat") return { error: "No chat works on this task and its project has no manager chat. Start one in PPM." };
    session = working.session;
    if (session.state === "gone") return { error: "The chat working on this task was deleted. Pick another in PPM." };
  }
  const projectPath = getTaskProject(task.projectKey)?.projectPath;
  if (!projectPath) return { error: "This task's project is no longer in PPM." };
  const projectName = taskProjectName(task.projectKey);
  const manager = to === "manager" || session.sessionId === managerSessionFor(task.projectKey);
  return {
    target: { sessionId: session.sessionId, providerId: session.providerId ?? "claude", projectName, projectPath },
    kind: manager ? "manager" : "child",
    chatTitle: manager ? null : session.title?.trim() || null,
    detail: taskDetail(task.projectKey),
    ref: formatTaskRef(task.number, projectName),
    title: task.title,
  };
}

const clean = (text: string, counter = { hidden: 0 }, max = TITLE_MAX): string =>
  cleanTelegramText(truncateText(text.replace(/\s+/g, " ").trim(), max), counter);

/** "the ppm manager chat", "the chat “Fix login” working on it", or (titles only) "the chat working on it". */
export function chatLabelHtml(chat: Pick<TaskChat, "kind" | "chatTitle" | "detail"> & { target: Pick<ForwardTarget, "projectName"> }): string {
  if (chat.kind === "manager") return `the <b>${clean(chat.target.projectName, undefined, 60)}</b> manager chat`;
  if (chat.detail === "full" && chat.chatTitle) return `the chat <b>“${clean(chat.chatTitle, undefined, 80)}”</b> working on it`;
  return "the chat working on it";
}

/** "<b>ppm/12 · Fix login</b>": the ref and the title only, whatever the project's detail level. */
export const taskLabelHtml = (chat: Pick<TaskChat, "ref" | "title">): string => `<code>${clean(chat.ref, undefined, 60)}</code> · <b>${clean(chat.title)}</b>`;

export function armedHtml(chat: TaskChat, minutes: number): string {
  return `💬 Your next message goes to ${chatLabelHtml(chat)}, about ${taskLabelHtml(chat)}.\n`
    + `<i>Send it within ${minutes} minutes, or press Cancel. Commands still go to the Assistant.</i>`;
}

export const sentHtml = (chat: TaskChat): string => `✅ Sent to ${chatLabelHtml(chat)}, about ${taskLabelHtml(chat)}.`;
export const notSentHtml = (chat: Pick<TaskChat, "ref" | "title">, error: string): string =>
  `⚠️ Not sent about ${taskLabelHtml(chat)}: ${escapeTelegramHtml(truncateText(error, 200))}`;
export const cancelledHtml = (chat: Pick<TaskChat, "ref" | "title">, why: string): string => `<i>${why}</i> Nothing was sent about ${taskLabelHtml(chat)}.`;

/** A message of the user's, as far as this needs it. */
export interface TaskWordsMessage {
  text: string;
  messageId: number;
  /** The bot message it replies to, if any. */
  replyToMessageId?: number;
  /** Someone else's words: a forward, or text an inline bot wrote. */
  notTheUsers: boolean;
  hasPhoto: boolean;
  /** A voice message the bridge stored and read; `text` is its transcript. */
  voice?: SpokenWords;
}

interface Armed {
  id: string;
  chatId: string;
  taskId: string;
  to: TaskWordsTo;
  chat: TaskChat;
  promptMessageId: number | null;
  expiresAt: number;
  cancelTimer: (() => void) | null;
}

export interface TaskMessageDeps {
  queue: AssistantTelegramSendQueue;
  codes: ButtonCodes<BridgeAction>;
  clock?: AssistantClock;
  /** The task a bot message of this chat shows (a `/tasks` card, a created-task card); null otherwise. */
  taskAt?: (chatId: string, messageId: number) => string | null;
  /** Sends the words; the real one is `forwardUserWordsAboutTask` with the server's env. */
  forward?: (input: TaskWordsInput) => Promise<TaskWordsResult>;
}

const realForward = async (input: TaskWordsInput): Promise<TaskWordsResult> =>
  forwardUserWordsAboutTask(input, (await import("../assistant-cards/forward-verbatim-env.ts")).realForwardEnv);

export class AssistantTelegramTaskMessages {
  private readonly armed = new Map<string, Armed>();
  /**
   * The "next message goes to…" lines this bot sent, and the answers it relayed: the task each was
   * about and the chat it went to. A reply to one is about that task, for that chat.
   */
  private readonly prompts = new Map<string, TaskWordsAim>();
  private readonly clock: AssistantClock;

  constructor(private readonly deps: TaskMessageDeps) {
    this.clock = deps.clock ?? assistantClock;
  }

  /**
   * The task a message to this chat is about and where it goes, decided when it arrives: the task of
   * the card it replies to, else the task the chat is armed for; null when it is for the Assistant.
   */
  wants(chatId: string, replyToMessageId?: number): TaskWordsAim | null {
    if (replyToMessageId !== undefined) {
      const replied = this.aimOfMessage(chatId, replyToMessageId);
      if (replied) return replied;
    }
    const armed = this.armed.get(chatId);
    return armed && this.clock.now() < armed.expiresAt ? { taskId: armed.taskId, to: armed.to } : null;
  }

  /**
   * Sends a message `wants` said is about a task, and answers the user in the chat either way. The
   * task and the chat are the ones decided on arrival: an arm that ran out while earlier messages
   * were sent on does not lose this one.
   */
  async take(chatId: string, m: TaskWordsMessage, aim: TaskWordsAim): Promise<void> {
    const armed = this.armed.get(chatId);
    const live = armed?.taskId === aim.taskId && armed.to === aim.to ? armed : null;
    if (m.notTheUsers) {
      this.say(chatId, "A forwarded message is someone else's words, so it was not sent to the task's chat. Type your own message.");
      return;
    }
    if (!m.text.trim()) {
      this.say(chatId, "Only text goes to a task's chat. Write your message as text.");
      return;
    }
    // A reply to another task's card leaves the chat armed for its own task.
    if (live) this.disarm(chatId);
    const result = await this.send(chatId, aim, m);
    if (m.hasPhoto && result.ok) this.say(chatId, "The photo was not sent: only text goes to a task's chat.");
    if (live?.promptMessageId != null) editCard(this.deps.queue, chatId, live.promptMessageId, result.html, []);
    else this.say(chatId, result.html, true);
  }

  /** A "Message about this task", "Ask manager" or Cancel press; the toast to show. */
  async press(chatId: string, press: TaskPress, group: string): Promise<string> {
    if (press.op === "about_cancel") {
      this.deps.codes.dropGroup(group);
      const armed = this.armed.get(chatId);
      if (!armed || armed.id !== press.ref) return "This button is no longer valid.";
      this.disarm(chatId);
      if (armed.promptMessageId !== null) editCard(this.deps.queue, chatId, armed.promptMessageId, cancelledHtml(armed.chat, "Cancelled."), []);
      return "Cancelled";
    }
    if ((press.op !== "about" && press.op !== "ask") || !press.taskId) return "This button is no longer valid.";
    return this.arm(chatId, { taskId: press.taskId, to: press.op === "ask" ? "manager" : "working" });
  }

  forgetChat(chatId: string): void {
    this.disarm(chatId);
    for (const key of [...this.prompts.keys()]) if (key.startsWith(`${chatId}:`)) this.prompts.delete(key);
  }

  stop(): void {
    for (const chatId of [...this.armed.keys()]) this.disarm(chatId);
    this.prompts.clear();
  }

  private aimOfMessage(chatId: string, messageId: number): TaskWordsAim | null {
    const prompt = this.prompts.get(`${chatId}:${messageId}`);
    if (prompt) return prompt;
    const card = this.deps.taskAt?.(chatId, messageId);
    return card ? { taskId: card, to: "working" } : null;
  }

  private arm(chatId: string, aim: TaskWordsAim): string {
    const { taskId, to } = aim;
    const task = showableTask(taskId);
    if (!task) return "This task is no longer there.";
    const chat = taskChatFor(task, to);
    if ("error" in chat) return truncateText(chat.error, 190);
    const previous = this.armed.get(chatId);
    this.disarm(chatId);
    if (previous?.promptMessageId != null && (previous.taskId !== taskId || previous.to !== to)) {
      const why = previous.taskId !== taskId ? "You picked another task." : "You picked another chat.";
      editCard(this.deps.queue, chatId, previous.promptMessageId, cancelledHtml(previous.chat, why), []);
    }
    while (this.armed.size >= ARMED_CHATS_MAX) this.disarm(this.armed.keys().next().value!);
    const armed: Armed = {
      id: `about-${crypto.randomUUID().slice(0, 12)}`, chatId, taskId, to, chat, promptMessageId: null,
      expiresAt: this.clock.now() + TASK_MESSAGE_WINDOW_MS, cancelTimer: null,
    };
    this.armed.set(chatId, armed);
    armed.cancelTimer = this.clock.setTimer(() => this.expire(armed), TASK_MESSAGE_WINDOW_MS);
    const group = `${armed.id}:cancel`;
    const cancel: InlineKeyboardButton = { text: "Cancel", callback_data: this.deps.codes.mint(chatId, group, { kind: "task", ref: armed.id, op: "about_cancel" }) };
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, {
      html: armedHtml(chat, Math.round(TASK_MESSAGE_WINDOW_MS / 60_000)), markup: { inline_keyboard: [[cancel]] },
    }, {
      label: "task message prompt",
      onSent: (sent) => {
        armed.promptMessageId = sent.message_id;
        this.remember(chatId, sent.message_id, taskId, to);
      },
      onDropped: () => { if (this.armed.get(chatId) === armed) this.disarm(chatId); },
    }));
    const toast = to === "manager" ? `Your next message goes to the manager chat, about ${chat.ref}` : `Your next message goes to the chat working on ${chat.ref}`;
    return truncateText(toast, 190);
  }

  private expire(armed: Armed): void {
    if (this.armed.get(armed.chatId) !== armed) return;
    armed.cancelTimer = null;
    this.disarm(armed.chatId);
    if (armed.promptMessageId !== null) {
      editCard(this.deps.queue, armed.chatId, armed.promptMessageId, cancelledHtml(armed.chat, "Not waiting any more."), []);
    }
  }

  private disarm(chatId: string): void {
    const armed = this.armed.get(chatId);
    if (!armed) return;
    this.armed.delete(chatId);
    armed.cancelTimer?.();
    this.deps.codes.dropGroup(`${armed.id}:cancel`);
  }

  /**
   * A reply to this bot message is about `taskId`, for the chat `to` names: the prompt (even once it
   * stopped waiting), and the chat's answer sent back under the user's message. Bounded.
   */
  remember(chatId: string, messageId: number, taskId: string, to: TaskWordsTo = "working"): void {
    while (this.prompts.size >= ARMED_CHATS_MAX * 5) this.prompts.delete(this.prompts.keys().next().value!);
    this.prompts.set(`${chatId}:${messageId}`, { taskId, to });
  }

  /** Sends the words about the task to the chat `aim` names; the line that says what happened. */
  private async send(chatId: string, aim: TaskWordsAim, m: TaskWordsMessage): Promise<{ ok: boolean; html: string }> {
    const { taskId } = aim;
    const task = showableTask(taskId);
    if (!task) return { ok: false, html: "⚠️ Not sent: that task is no longer there." };
    const chat = taskChatFor(task, aim.to);
    if ("error" in chat) return { ok: false, html: notSentHtml({ ref: formatTaskRef(task.number, taskProjectName(task.projectKey)), title: task.title }, chat.error) };
    try {
      const ref = await resolveTaskRef(task.id, { anyProject: true });
      if (!ref.ok) return { ok: false, html: notSentHtml(chat, ref.error) };
      const result = await (this.deps.forward ?? realForward)({
        text: m.text, target: chat.target, taskRef: ref.ref, chatKind: chat.kind, ...(m.voice ? { voice: m.voice } : {}),
        actor: { channel: "telegram", telegramChatId: chatId, telegramMessageId: m.messageId },
        // The chat's answer comes back here, under the user's own message.
        followUp: {
          origin: { channel: "telegram", chatId, messageId: m.messageId },
          taskRef: { taskId: ref.ref.taskId, ref: ref.ref.ref, title: ref.ref.title },
          chat: {
            kind: chat.kind, chatTitle: chat.chatTitle, detail: chat.detail, projectKey: task.projectKey,
            projectName: chat.target.projectName, providerId: chat.target.providerId,
          },
        },
      });
      return result.ok ? { ok: true, html: sentHtml(chat) } : { ok: false, html: notSentHtml(chat, result.error) };
    } catch (e) {
      log.warn(`Telegram chat ${chatId}: words about task ${taskId} were not sent: ${(e as Error).message}`);
      return { ok: false, html: notSentHtml(chat, "PPM could not send it; see its log.") };
    }
  }

  private say(chatId: string, html: string, trusted = false): void {
    this.deps.queue.enqueue(chatId, sendMessageTask(this.deps.queue, chatId, { html: trusted ? html : escapeTelegramHtml(html) }, { label: "task message" }));
  }
}
