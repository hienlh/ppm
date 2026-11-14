/**
 * How many "AI scheduled a prompt" notifications one chat may send. The schedule tools need no
 * approval and skip the session tools' rate limit, and the per-chat cap only bounds how many
 * schedules exist at once — so an AI stuck in a loop, or steered by text it read, that creates and
 * deletes schedules would otherwise send one push, Telegram and ntfy message per create.
 *
 * Past the cap the chat gets one notice saying further ones are muted and until when; anything
 * after that, until a slot opens again, is only logged.
 */

/** Notices about new schedules one chat may send within {@link AI_SCHEDULE_NOTICE_WINDOW_MS}. */
export const AI_SCHEDULE_NOTICES_PER_HOUR = 5;
export const AI_SCHEDULE_NOTICE_WINDOW_MS = 60 * 60_000;

/** What to do about one new schedule's notice. */
export type AiScheduleNoticeTurn =
  | { kind: "notify" }
  /** Over the cap with no "muted" notice yet this window: say so once, naming when notices resume. */
  | { kind: "muted"; resumesAt: number }
  /** Over the cap and already said so: log it and send nothing. */
  | { kind: "drop" };

interface ChatNotices {
  /** When each notice inside the window was sent, oldest first. */
  sent: number[];
  /** When the "muted" notice went out, if within the window. */
  mutedAt: number | null;
}

export class AiScheduleNoticeLimit {
  private readonly chats = new Map<string, ChatNotices>();

  constructor(
    private readonly max = AI_SCHEDULE_NOTICES_PER_HOUR,
    private readonly windowMs = AI_SCHEDULE_NOTICE_WINDOW_MS,
  ) {}

  /** Decides the notice for a schedule `chatId`'s AI created at `now` (ms), and records it. */
  take(chatId: string, now: number): AiScheduleNoticeTurn {
    const since = now - this.windowMs;
    // Forget chats with nothing left inside the window, so the map stays as small as recent activity.
    for (const [id, c] of this.chats) {
      c.sent = c.sent.filter((t) => t > since);
      if (c.sent.length === 0 && (c.mutedAt === null || c.mutedAt <= since) && id !== chatId) this.chats.delete(id);
    }
    const chat = this.chats.get(chatId) ?? { sent: [], mutedAt: null };
    this.chats.set(chatId, chat);
    // At most one "muted" notice per window, so a steady loop costs the cap plus one an hour.
    if (chat.mutedAt !== null && chat.mutedAt <= since) chat.mutedAt = null;
    if (chat.sent.length < this.max) {
      chat.sent.push(now);
      return { kind: "notify" };
    }
    if (chat.mutedAt !== null) return { kind: "drop" };
    chat.mutedAt = now;
    return { kind: "muted", resumesAt: chat.sent[0]! + this.windowMs };
  }
}
