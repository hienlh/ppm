/**
 * The subset of the Telegram Bot API's objects PPM reads or sends, named as the Bot API names
 * them (https://core.telegram.org/bots/api). Fields PPM never looks at are left out.
 */

/** Every Bot API answer: `result` when `ok`, else an error code and a description. */
export interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  /** On a 429: how long to wait before asking again. */
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup";
  first_name?: string;
  username?: string;
  title?: string;
}

/** One size of a photo; a message carries several, smallest first. */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface InlineKeyboardButton {
  text: string;
  /** At most 64 bytes, UTF-8. */
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  /** Shared by the messages of one album; each photo of an album arrives as its own update. */
  media_group_id?: string;
  /** Attachments PPM only names (when the user replies to one); their files are never fetched. */
  document?: { file_name?: string; mime_type?: string };
  video?: { file_name?: string };
  animation?: { file_name?: string };
  /** A voice note (OGG/Opus). Fetched only when voice messages are on, through `getFile`. */
  voice?: { duration?: number; file_id?: string; file_unique_id?: string; mime_type?: string; file_size?: number };
  /**
   * An audio file (mp3, m4a…). Named when the user replies to one; read like a voice note (through
   * `getFile`) when voice messages are on.
   */
  audio?: {
    title?: string; duration?: number; file_id?: string; file_unique_id?: string; mime_type?: string; file_size?: number; file_name?: string;
  };
  video_note?: { duration?: number };
  sticker?: { emoji?: string };
  reply_to_message?: TelegramMessage;
  /** The part of the replied-to message the user picked to quote, as their client showed it. */
  quote?: { text: string; position?: number; is_manual?: boolean };
  /** When the message was last edited (seconds). */
  edit_date?: number;
  reply_markup?: InlineKeyboardMarkup;
  /** Sent through an inline bot: the text is that bot's, not the sender's own. */
  via_bot?: TelegramUser;
}

/** A press on an inline button. `message` is the message the button sits under. */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  chat_instance: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** What `getFile` answers; `file_path` is what `botFileUrl` downloads. */
export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export type TelegramChatAction = "typing" | "upload_photo" | "upload_document";
