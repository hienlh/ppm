import type { TelegramChatInfo } from "./notification-settings.ts";

/** PPMBot's Telegram setup as Settings → PPMBot sees it. The bot token never leaves the server. */
export interface PPMBotTelegramStatus {
  configured: boolean;
  botUsername: string | null;
  /** Notifications send through this same bot, so their alerts land in PPMBot's chats. */
  sharedWithNotifications: boolean;
  /** The PPMBot switch. */
  enabled: boolean;
  /** Whether PPMBot is reading its bot right now. */
  running: boolean;
  /** Chats that may command PPMBot: each one connected with a link from Settings. */
  chats: TelegramChatInfo[];
  connect: { active: boolean; expiresAt: number | null; error: string | null };
}
