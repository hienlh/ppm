import { configService } from "./config.service.ts";
import { tunnelService } from "./tunnel.service.ts";
import { getLocalIp } from "../lib/network-utils.ts";
import type { TelegramConfig } from "../types/config.ts";
import type { NotificationPayload } from "./notification.service.ts";

const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,50}$/;

/** Escape HTML special chars for Telegram HTML parse mode */
function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

class TelegramNotificationService {
  /** Send notification to Telegram. No-op if not configured. */
  async send(payload: NotificationPayload): Promise<void> {
    const config = configService.get("telegram") as TelegramConfig | undefined;
    if (!config?.bot_token || !config?.chat_id) return;
    if (!BOT_TOKEN_RE.test(config.bot_token)) return;

    const deviceName = (configService.get("device_name") as string) || "PPM";
    const deepLink = this.buildDeepLink(payload);

    let text = `<b>${escapeHtml(deviceName)} — ${escapeHtml(payload.title)}</b>\n`;
    text += escapeHtml(payload.body);
    if (deepLink) {
      text += `\n\n<a href="${deepLink}">Open in PPM</a>`;
    }

    await this.callApi(config.bot_token, config.chat_id, text);
  }

  /** Send a test message. Returns { ok, error? } */
  async sendTest(botToken: string, chatId: string): Promise<{ ok: boolean; error?: string }> {
    if (!BOT_TOKEN_RE.test(botToken)) return { ok: false, error: "Invalid bot token format" };
    const deviceName = (configService.get("device_name") as string) || "PPM";
    const text = `<b>${escapeHtml(deviceName)} — Test</b>\nTelegram notifications are working!`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        signal: controller.signal,
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) return { ok: false, error: json.description || "Unknown error" };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildDeepLink(payload: NotificationPayload): string | null {
    // Prefer tunnel URL (globally accessible), fallback to local IP
    let baseUrl = tunnelService.getTunnelUrl();
    if (!baseUrl) {
      const localIp = getLocalIp();
      const port = configService.get("port") ?? 8080;
      if (localIp) {
        baseUrl = `http://${localIp}:${port}`;
      }
    }
    if (!baseUrl) return null;

    const projectPath = payload.project
      ? `/project/${encodeURIComponent(payload.project)}`
      : "";
    const query = payload.sessionId ? `?openChat=${payload.sessionId}` : "";
    return `${baseUrl}${projectPath}${query}`;
  }

  private async callApi(token: string, chatId: string, text: string): Promise<void> {
    if (!BOT_TOKEN_RE.test(token)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.text();
        console.error(`[telegram] sendMessage failed: ${res.status} ${errBody}`);
      }
    } catch (e) {
      console.error(`[telegram] send error: ${(e as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Singleton Telegram notification service */
export const telegramService = new TelegramNotificationService();
