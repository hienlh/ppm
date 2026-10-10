/**
 * One Assistant turn, written into one Telegram chat as it streams.
 *
 * The turn opens with "…" and is edited as text arrives; the edits go through the chat's send
 * lane, keyed so a burst of text becomes one edit. Near Telegram's 4096-character limit the
 * answer moves on to a new message (cut by `splitTelegramHtml`, which keeps every message valid
 * HTML on its own). Only the answer's own text and, if the setting asks for it, the bare names of
 * the tools it ran are sent — never a tool's input or output — and all of it after
 * `redactForTelegram`.
 *
 * Telegram does not notify anyone about an *edited* message. A turn that took a while (or one
 * started by a watch, which the user did not just ask for) therefore ends with its answer as a
 * new message, so the phone actually buzzes; the message that held the draft is collapsed to a
 * pointer. A short turn's answer simply replaces its "…", which the user is looking at anyway.
 */
import { markdownToTelegramHtml, redactForTelegram, splitTelegramHtml } from "../telegram/telegram-html-format.ts";
import type { TelegramBotClient } from "../telegram/telegram-bot-client.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import type { ChatMessageOrigin } from "../chat-control/chat-control.ts";
import { outcomeOf, type AssistantTelegramSendQueue, type TaskOutcome } from "./assistant-telegram-send-queue.ts";
import type { BridgeStateStore } from "./assistant-telegram-state.ts";

/** A turn longer than this ends with its answer as a new message (see the header). */
export const LONG_TURN_MS = 15_000;
/** Below Telegram's 4096: measured on the HTML, which is never shorter than what Telegram counts. */
export const PAGE_MAX = 4000;
export const PLACEHOLDER = "…";
/** What the draft message becomes when the answer is sent again as a new message. */
export const MOVED_BELOW = "⤵️ <i>Answer below</i>";
const EMPTY_ANSWER = "<i>(no answer)</i>";

export interface TurnRendererDeps {
  queue: AssistantTelegramSendQueue;
  state: BridgeStateStore;
  chatId: string;
  /** Who started the turn: a `watch` turn always ends with a new message. */
  origin: ChatMessageOrigin;
  showToolCalls: () => boolean;
  /** The final answer reached the chat. */
  onDelivered?: () => void;
  now?: () => number;
}

/** `mcp__ppm-assistant__chat_search` and `ppm_assistant:chat_search` are both `chat_search`. */
export function shortToolName(tool: string): string {
  const mcp = /^mcp__.+?__(.+)$/.exec(tool);
  if (mcp) return mcp[1]!;
  const colon = tool.lastIndexOf(":");
  return (colon > 0 ? tool.slice(colon + 1) : tool).slice(0, 60);
}

export class TurnRenderer {
  private md = "";
  /** Already-HTML line closing the answer (how the turn stopped). */
  private footer = "";
  /** The draft messages, in page order, and the HTML each shows. */
  private readonly ids: number[] = [];
  private readonly shown: string[] = [];
  /** Pages of the final answer sent as new messages so far (a retried final resumes after them). */
  private finalSent = 0;
  private finished = false;
  private attempts = 0;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly key: string;

  constructor(private readonly deps: TurnRendererDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.key = `turn:${crypto.randomUUID()}`;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  start(): void {
    this.draft();
  }

  text(delta: string): void {
    if (this.finished || !delta) return;
    this.md += delta;
    this.draft();
  }

  tool(name: string): void {
    if (this.finished || !this.deps.showToolCalls()) return;
    this.md += `${this.md && !this.md.endsWith("\n") ? "\n" : ""}🔧 \`${shortToolName(name)}\`\n`;
    this.draft();
  }

  /** Ends the turn; `footerHtml` is already escaped (and redacted). */
  finish(footerHtml = ""): void {
    if (this.finished) return;
    this.finished = true;
    this.footer = footerHtml;
    this.deps.queue.enqueue(this.deps.chatId, {
      key: this.key, final: true, label: "answer",
      run: (client) => this.writeFinal(client),
    });
  }

  private draft(): void {
    this.deps.queue.enqueue(this.deps.chatId, {
      key: this.key, final: false, label: "answer draft",
      run: (client) => (this.finished ? Promise.resolve({ kind: "done" } as const) : this.writeDraft(client)),
    });
  }

  private pages(final: boolean): string[] {
    let html = this.md.trim() ? markdownToTelegramHtml(redactForTelegram(this.md.trim())) : "";
    if (this.footer) html += `${html ? "\n\n" : ""}${this.footer}`;
    const pages = html ? splitTelegramHtml(html, PAGE_MAX) : [];
    if (final) return pages.length ? pages : [EMPTY_ANSWER];
    if (!pages.length) return [PLACEHOLDER];
    pages[pages.length - 1] += ` ${escapeTelegramHtml(PLACEHOLDER)}`;
    return pages;
  }

  private async writeDraft(client: TelegramBotClient): Promise<TaskOutcome> {
    this.attempts++;
    const pages = this.pages(false);
    for (let i = 0; i < pages.length; i++) {
      const html = pages[i]!;
      if (i < this.ids.length) {
        if (this.shown[i] === html) continue;
        const res = await client.editMessageText(this.deps.chatId, this.ids[i]!, html);
        if (!res.ok) return outcomeOf(res, this.attempts);
        this.shown[i] = html;
      } else {
        const sent = await this.sendNew(client, html, "render");
        if (sent.kind !== "done") return sent;
      }
    }
    return { kind: "done" };
  }

  private async writeFinal(client: TelegramBotClient): Promise<TaskOutcome> {
    this.attempts++;
    const pages = this.pages(true);
    const asNew = this.deps.origin === "watch" || this.now() - this.startedAt > LONG_TURN_MS;
    const inPlace = Math.min(pages.length, asNew ? Math.max(0, this.ids.length - 1) : this.ids.length);
    for (let i = 0; i < this.ids.length; i++) {
      const html = i < inPlace ? pages[i]! : MOVED_BELOW;
      if (this.shown[i] === html) continue;
      const res = await client.editMessageText(this.deps.chatId, this.ids[i]!, html, { final: true });
      if (!res.ok) return outcomeOf(res, this.attempts);
      this.shown[i] = html;
    }
    for (let i = inPlace + this.finalSent; i < pages.length; i++) {
      const sent = await this.sendNew(client, pages[i]!, null);
      if (sent.kind !== "done") return sent;
      this.finalSent++;
    }
    for (const id of this.ids) this.deps.state.remove(this.deps.chatId, "render", id);
    this.deps.onDelivered?.();
    return { kind: "done" };
  }

  /** Sends a message; a draft one is remembered so a restart can mark it as cut off. */
  private async sendNew(client: TelegramBotClient, html: string, remember: "render" | null): Promise<TaskOutcome> {
    const res = await client.sendMessage(this.deps.chatId, html);
    if (!res.ok) return outcomeOf(res, this.attempts);
    this.deps.queue.noteSent(this.deps.chatId);
    if (remember) {
      this.ids.push(res.result.message_id);
      this.shown.push(html);
      this.deps.state.add(this.deps.chatId, remember, res.result.message_id);
    }
    return { kind: "done" };
  }
}
