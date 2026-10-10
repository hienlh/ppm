import type { TelegramChatInfo } from "./notification-settings.ts";

/**
 * PPM Assistant's Telegram setup as Settings → PPM Assistant → Telegram sees it
 * (`GET /api/settings/clawbot/telegram`; the PPMBot names are kept from the bot it replaced).
 * The bot token never leaves the server.
 */
export interface PPMBotTelegramStatus {
  configured: boolean;
  botUsername: string | null;
  /** Notifications send through this same bot, so their alerts land in the Assistant's chats. */
  sharedWithNotifications: boolean;
  /** The bridge's switch. */
  enabled: boolean;
  /** Whether the bridge is reading its bot right now. */
  running: boolean;
  /** Chats that may talk to the Assistant: each one connected with a link from Settings. */
  chats: TelegramChatInfo[];
  connect: { active: boolean; expiresAt: number | null; error: string | null };
}
