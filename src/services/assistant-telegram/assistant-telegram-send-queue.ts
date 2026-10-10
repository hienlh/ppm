/**
 * Everything the bridge sends goes through here: one lane per Telegram chat, run in order, lanes
 * independent of each other.
 *
 * - **Who may receive it** is checked before every call, not when the message was queued: a chat
 *   revoked mid-turn gets nothing more, and its lane is emptied.
 * - **Rate limits** are waited out in the lane that hit them. The client gives up at once on a
 *   `retry_after` over 30 s (waiting there would hold every chat); the lane sleeps instead, and
 *   the other chats carry on.
 * - **A final message is never dropped for a limit or a network failure**: it is retried until
 *   15 minutes have passed since it was queued, and only then logged as lost. A draft (an edit of
 *   a streaming answer) gives up after two minutes; the final one carries its text anyway.
 * - **Coalescing**: a task queued under the key of one still waiting replaces it, so a burst of
 *   streamed text becomes one edit with the newest text, not a backlog of stale ones.
 */
import type { TelegramBotClient, TelegramCallResult, TelegramEditResult } from "../telegram/telegram-bot-client.ts";
import type { InlineKeyboardMarkup, TelegramMessage } from "../telegram/telegram-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export type TaskOutcome = { kind: "done" } | { kind: "retry"; afterMs: number; why: string } | { kind: "failed"; why: string };

export interface SendTask {
  /** A task queued with the key of one still waiting replaces it. */
  key?: string;
  /** Never dropped for a limit or a network failure before {@link FINAL_DEADLINE_MS}. */
  final: boolean;
  /** What it is, for the log; never message text. */
  label: string;
  run(client: TelegramBotClient): Promise<TaskOutcome>;
  /** It will not run (again): failed, past its deadline, or its chat went away. */
  onDropped?(why: string): void;
}

export const FINAL_DEADLINE_MS = 15 * 60_000;
export const DRAFT_DEADLINE_MS = 2 * 60_000;
/** The client spaces edits of one message by this much; a skipped edit is tried again after it. */
export const EDIT_INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** What one Bot API answer means for the task that made the call. */
export function outcomeOf(res: TelegramCallResult<unknown> | TelegramEditResult, attempts: number): TaskOutcome {
  if (res.ok) return { kind: "done" };
  if ("throttled" in res) return { kind: "retry", afterMs: EDIT_INTERVAL_MS, why: "edit spacing" };
  if (res.errorCode === 429) return { kind: "retry", afterMs: Math.max(1, res.retryAfter ?? 1) * 1000, why: "rate-limited" };
  if (res.errorCode === null || res.errorCode >= 500) {
    return { kind: "retry", afterMs: Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1)), why: res.description };
  }
  return { kind: "failed", why: `${res.errorCode} ${res.description}` };
}

interface Entry { task: SendTask; enqueuedAt: number; attempts: number }
interface Lane { entries: Entry[]; running: Entry | null; timer: ReturnType<typeof setTimeout> | null }

export interface SendQueueOptions {
  canSend(chatId: string): boolean;
  now?: () => number;
  /** The wait actually taken for a wait Telegram asked for; tests shrink it. */
  scaleDelay?: (ms: number) => number;
}

export class AssistantTelegramSendQueue {
  private readonly lanes = new Map<string, Lane>();
  private readonly sentAt = new Map<string, number>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly now: () => number;
  private readonly scale: (ms: number) => number;
  private stopped = false;

  constructor(private readonly client: TelegramBotClient, private readonly opts: SendQueueOptions) {
    this.now = opts.now ?? Date.now;
    this.scale = opts.scaleDelay ?? ((ms) => ms);
  }

  enqueue(chatId: string, task: SendTask): void {
    if (this.stopped) return;
    let lane = this.lanes.get(chatId);
    if (!lane) this.lanes.set(chatId, lane = { entries: [], running: null, timer: null });
    const waiting = task.key ? lane.entries.find((e) => e !== lane!.running && e.task.key === task.key) : undefined;
    if (waiting) waiting.task = { ...task, final: task.final || waiting.task.final };
    else lane.entries.push({ task, enqueuedAt: this.now(), attempts: 0 });
    void this.pump(chatId);
  }

  /** A `sendMessage` to this chat succeeded; read by the notification suppressor. */
  noteSent(chatId: string): void {
    this.sentAt.set(chatId, this.now());
  }

  lastSentAt(chatId: string): number | undefined {
    return this.sentAt.get(chatId);
  }

  /** Drops everything waiting for the chat; a call already in flight is not answered further. */
  forget(chatId: string, why = "chat forgotten"): void {
    const lane = this.lanes.get(chatId);
    this.sentAt.delete(chatId);
    if (!lane) return;
    this.lanes.delete(chatId);
    if (lane.timer) clearTimeout(lane.timer);
    for (const e of lane.entries) if (e !== lane.running) e.task.onDropped?.(why);
    this.checkIdle();
  }

  stop(): void {
    this.stopped = true;
    for (const chatId of [...this.lanes.keys()]) this.forget(chatId, "bridge stopped");
  }

  /** Resolves once no lane has work left (tests, and a clean stop). */
  whenIdle(): Promise<void> {
    if (this.lanes.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private checkIdle(): void {
    if (this.lanes.size > 0) return;
    for (const resolve of [...this.idleWaiters]) resolve();
    this.idleWaiters.clear();
  }

  private async pump(chatId: string): Promise<void> {
    const lane = this.lanes.get(chatId);
    if (!lane || lane.running || lane.timer) return;
    while (lane.entries.length > 0 && this.lanes.get(chatId) === lane) {
      if (!this.opts.canSend(chatId)) {
        log.info(`Telegram chat ${chatId} is not connected any more: ${lane.entries.length} message(s) dropped`);
        this.forget(chatId, "chat is not connected");
        return;
      }
      const entry = lane.entries[0]!;
      lane.running = entry;
      entry.attempts++;
      let outcome: TaskOutcome;
      try {
        outcome = await entry.task.run(this.client);
      } catch (e) {
        outcome = { kind: "failed", why: (e as Error)?.message ?? String(e) };
      }
      lane.running = null;
      if (this.lanes.get(chatId) !== lane) return;
      if (outcome.kind === "retry") {
        const deadline = entry.task.final ? FINAL_DEADLINE_MS : DRAFT_DEADLINE_MS;
        if (this.now() + outcome.afterMs - entry.enqueuedAt <= deadline) {
          lane.timer = setTimeout(() => { lane.timer = null; void this.pump(chatId); }, this.scale(outcome.afterMs));
          return;
        }
        outcome = { kind: "failed", why: `gave up after ${Math.round((this.now() - entry.enqueuedAt) / 1000)}s (${outcome.why})` };
      }
      lane.entries.shift();
      if (outcome.kind === "failed") {
        const level = entry.task.final ? "warn" : "debug";
        log[level](`${entry.task.label} to Telegram chat ${chatId} not delivered: ${outcome.why}`);
        entry.task.onDropped?.(outcome.why);
      }
    }
    if (this.lanes.get(chatId) === lane && lane.entries.length === 0 && !lane.timer) {
      this.lanes.delete(chatId);
      this.checkIdle();
    }
  }
}

/** A button Telegram refused for its URL: the message is sent again without URL buttons. */
const BUTTON_URL_INVALID = /BUTTON_URL_INVALID|wrong http url|unsupported url protocol/i;

/**
 * A task that sends one new message. `fallbackHtml` replaces the text when Telegram refuses a URL
 * button, so a link that could not be a button still reaches the chat in the text.
 */
export function sendMessageTask(
  queue: AssistantTelegramSendQueue,
  chatId: string,
  message: { html: string; markup?: InlineKeyboardMarkup; fallbackHtml?: string },
  opts: { label: string; final?: boolean; key?: string; onSent?: (sent: TelegramMessage) => void; onDropped?: (why: string) => void },
): SendTask {
  let attempts = 0;
  return {
    label: opts.label,
    final: opts.final ?? true,
    ...(opts.key ? { key: opts.key } : {}),
    async run(client) {
      attempts++;
      let res = await client.sendMessage(chatId, message.html, message.markup ? { replyMarkup: message.markup } : {});
      if (!res.ok && res.errorCode === 400 && BUTTON_URL_INVALID.test(res.description) && message.markup) {
        const rows = message.markup.inline_keyboard.map((row) => row.filter((b) => b.url === undefined)).filter((row) => row.length);
        log.info(`${opts.label}: Telegram refused a link button; sending it with the link in the text`);
        res = await client.sendMessage(chatId, message.fallbackHtml ?? message.html, rows.length ? { replyMarkup: { inline_keyboard: rows } } : {});
      }
      if (res.ok) {
        queue.noteSent(chatId);
        opts.onSent?.(res.result);
      }
      return outcomeOf(res, attempts);
    },
    ...(opts.onDropped ? { onDropped: opts.onDropped } : {}),
  };
}
