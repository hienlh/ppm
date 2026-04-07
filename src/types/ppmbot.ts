/** Telegram update object (subset we care about) */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; username?: string };
  chat: { id: number; type: "private" | "group" | "supergroup" };
  date: number;
  text?: string;
  caption?: string;
}

/** Sent message result from Telegram API */
export interface TelegramSentMessage {
  message_id: number;
  chat: { id: number };
  date: number;
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

/** Active session state tracked in memory (not DB) */
export interface PPMBotActiveSession {
  telegramChatId: string;
  sessionId: string;
  providerId: string;
  projectName: string;
  projectPath: string;
  /** Telegram message ID being edited for streaming */
  currentMessageId?: number;
  /** Debounce timer for rapid messages */
  debounceTimer?: ReturnType<typeof setTimeout>;
  /** Accumulated debounced text */
  debouncedText?: string;
}

/** Parsed command from Telegram message */
export interface PPMBotCommand {
  command: string;
  args: string;
  chatId: number;
  messageId: number;
  userId: number;
  username?: string;
}

/** Memory recall result with relevance score */
export interface MemoryRecallResult {
  id: number;
  content: string;
  category: PPMBotMemoryCategory;
  importance: number;
  project: string;
  /** FTS5 rank score (lower = more relevant) */
  rank?: number;
}

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
