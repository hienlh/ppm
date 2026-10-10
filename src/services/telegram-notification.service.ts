import { configService } from "./config.service.ts";
import { listNotifyChats } from "./telegram-bots.ts";
import type { TelegramConfig } from "../types/config.ts";
import type { NotificationPayload } from "./notification.service.ts";
import { escapeTelegramHtml as escapeHtml, formatTelegramNotification } from "./notification-format.ts";
import { notificationLink } from "./notification-link.ts";
import { createLogger } from "./logger.ts";
import { BOT_TOKEN_RE, sendTelegramMessage } from "./telegram-bot-api.ts";
import { scrubToken } from "./telegram/telegram-api-base.ts";

const log = createLogger("telegram");

class TelegramNotificationService {
  /** Why the last send was skipped, so a setup left half done warns once, not on every notification. */
  private lastSkip: string | null = null;

  /**
   * Send a notification to every chat connected in Settings → Notifications. No-op if not configured.
   * Resolves to what happened (`sent=2`, `skipped (no bot token)`) for the delivery log line.
   */
  async send(payload: NotificationPayload): Promise<string> {
    const config = configService.get("telegram") as TelegramConfig | undefined;
    // The channel is on by default, so no token is simply a PPM that never set Telegram up.
    if (!config?.bot_token) return this.skipped("no bot token", false);
    if (!BOT_TOKEN_RE.test(config.bot_token)) return this.skipped("malformed bot token", true);

    const chats = listNotifyChats();
    if (chats.length === 0) return this.skipped("no connected chats", true);
    this.lastSkip = null;

    const deviceName = (configService.get("device_name") as string) || "PPM";
    const text = formatTelegramNotification(payload, deviceName, await notificationLink(payload));

    const results = await Promise.allSettled(
      chats.map((chat) => this.callApi(config.bot_token, chat.chatId, text)),
    );
    const sent = results.filter((r) => r.status === "fulfilled" && r.value).length;
    return sent === results.length ? `sent=${sent}` : `sent=${sent} failed=${results.length - sent}`;
  }

  /** A setup problem warns the first time it is the reason; repeats, and a Telegram never set up, only at DEBUG. */
  private skipped(reason: string, misconfigured: boolean): string {
    const line = `Notification skipped: ${reason}`;
    if (misconfigured && this.lastSkip !== reason) log.warn(line);
    else log.debug(line);
    this.lastSkip = reason;
    return `skipped (${reason})`;
  }

  /** Send a test message to every connected chat. Returns { ok, error? } */
  async sendTest(botToken: string): Promise<{ ok: boolean; error?: string }> {
    if (!BOT_TOKEN_RE.test(botToken)) return { ok: false, error: "Invalid bot token format" };

    const chats = listNotifyChats();
    if (chats.length === 0) {
      return { ok: false, error: "No chat is connected. Tap Connect Telegram first." };
    }

    const deviceName = (configService.get("device_name") as string) || "PPM";
    const text = `<b>${escapeHtml(deviceName)} — Test</b>\nTelegram notifications are working!`;

    const results = await Promise.allSettled(
      chats.map(async (chat) => {
        const json = await sendTelegramMessage(botToken, chat.chatId, text);
        if (!json.ok) throw new Error(json.description || "Unknown error");
      }),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === results.length) {
      // Shown in Settings: a fetch error can quote the request URL, which holds the token.
      const reason = (failed[0] as PromiseRejectedResult).reason?.message;
      return { ok: false, error: reason ? scrubToken(reason, botToken) : "All sends failed" };
    }
    return { ok: true };
  }

  /** True once Telegram accepted the message. Failures are logged here: the URL holds the token, so never it. */
  private async callApi(token: string, chatId: string, text: string): Promise<boolean> {
    if (!BOT_TOKEN_RE.test(token)) return false;
    try {
      const json = await sendTelegramMessage(token, chatId, text);
      if (!json.ok) {
        log.error(`sendMessage to chat ${chatId} failed: ${json.error_code ?? "?"} ${json.description ?? "(no description)"}`);
        return false;
      }
      return true;
    } catch (e) {
      log.error(`send to chat ${chatId} error: ${scrubToken((e as Error).message, token)}`);
      return false;
    }
  }
}

/** Singleton Telegram notification service */
export const telegramService = new TelegramNotificationService();
