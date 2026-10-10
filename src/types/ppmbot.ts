/**
 * Row shapes of the tables PPMBot left behind, still read (connected chats, the connect link's
 * message, legacy memories) or kept for old databases (sessions, tasks). PPMBot itself is gone:
 * the PPM Assistant's Telegram bridge uses the connected chats and the bot.
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

/** PPMBot session row from SQLite */
export interface PPMBotSessionRow {
  id: number;
  telegram_chat_id: string;
  session_id: string;
  provider_id: string;
  project_name: string;
  project_path: string;
  is_active: number;
  created_at: number;
  last_message_at: number;
}

/** PPMBot memory row from SQLite */
export interface PPMBotMemoryRow {
  id: number;
  project: string;
  content: string;
  category: PPMBotMemoryCategory;
  importance: number;
  created_at: number;
  updated_at: number;
  session_id: string | null;
  superseded_by: number | null;
}

export type PPMBotMemoryCategory =
  | "fact"
  | "decision"
  | "preference"
  | "architecture"
  | "issue";

/** Bot task row from SQLite */
export interface BotTask {
  id: string;
  chatId: string;
  projectName: string;
  projectPath: string;
  prompt: string;
  status: BotTaskStatus;
  resultSummary: string | null;
  resultFull: string | null;
  sessionId: string | null;
  error: string | null;
  reported: boolean;
  timeoutMs: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export type BotTaskStatus = "pending" | "running" | "completed" | "failed" | "timeout";

/** Paired chat row from SQLite */
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
