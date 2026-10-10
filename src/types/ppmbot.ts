/**
 * Shapes PPM Assistant's Telegram side still reads under PPMBot's names: the connect link's
 * message and the connected chats (`clawbot_paired_chats`). PPMBot itself is gone; its other
 * tables stay in old databases unwritten, and the legacy-memories route reads its memories
 * with a query of its own.
 */

/** A Telegram message, as the connect-link poller reads it. */
export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; username?: string };
  chat: { id: number; type: "private" | "group" | "supergroup" };
  date: number;
  text?: string;
  caption?: string;
}

/** A row of `clawbot_paired_chats`: a Telegram chat connected to PPM Assistant. */
export interface PPMBotPairedChat {
  id: number;
  telegram_chat_id: string;
  telegram_user_id: string | null;
  display_name: string | null;
  pairing_code: string | null;
  status: "pending" | "approved" | "revoked";
  created_at: number;
  approved_at: number | null;
}
