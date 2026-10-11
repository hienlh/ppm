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
  reply_to_message?: TelegramMessage;
  reply_markup?: InlineKeyboardMarkup;
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
