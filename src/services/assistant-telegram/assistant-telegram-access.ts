/**
 * Who may talk to the PPM Assistant on Telegram, and who it may talk to.
 *
 * Three checks, all required: the chat is private (in a group anyone in it could command an AI
 * that works on this machine), it was connected with a link from PPM and not revoked since, and
 * the person writing is the one who connected it. The same checks gate every *send*, not only
 * what arrives: a revoked chat's binding is not in the same table as its connection, and a turn
 * running when it was revoked would otherwise keep reporting to a phone the user just cut off.
 *
 * A private chat's id is its user's id, which is what makes the send-side check possible without
 * an update in hand: a chat is reachable only when its id equals the user id it was connected by.
 */
import { getApprovedPairedChats } from "../db.service.ts";
import type { TelegramChat, TelegramUser } from "../telegram/telegram-types.ts";

export type AccessRefusal =
  /** A group or supergroup: refused whoever writes. */
  | "not-private"
  /** Never connected, or revoked. */
  | "not-connected"
  /** Connected before PPM recorded who connected it: has to be connected again. */
  | "reconnect"
  /** Someone other than the person who connected the chat. */
  | "wrong-user";

export type AccessResult = { ok: true } | { ok: false; refusal: AccessRefusal };

interface ConnectedChat {
  chatId: string;
  userId: string;
  name: string;
}

/** The chat as connected, or null when it is not (or no longer) approved. */
export function connectedChat(chatId: string): ConnectedChat | null {
  const row = getApprovedPairedChats().find((c) => c.telegram_chat_id === chatId);
  if (!row) return null;
  return { chatId, userId: row.telegram_user_id?.trim() ?? "", name: row.display_name || `Chat ${chatId}` };
}

/** Every connected chat the bridge may write to, newest first. */
export function reachableChats(): ConnectedChat[] {
  return getApprovedPairedChats()
    .map((row) => ({ chatId: row.telegram_chat_id, userId: row.telegram_user_id?.trim() ?? "", name: row.display_name || `Chat ${row.telegram_chat_id}` }))
    .filter((c) => isReachable(c));
}

function isReachable(c: ConnectedChat): boolean {
  // An empty user id is never a match: it would equal another empty value, not a person.
  return c.userId !== "" && /^\d+$/.test(c.userId) && c.chatId === c.userId;
}

/** Whether a message, reply or card may be sent to this chat now. Checked before every send. */
export function canSendTo(chatId: string): boolean {
  const chat = connectedChat(chatId);
  return chat !== null && isReachable(chat);
}

/** Whether what arrived from `from` in `chat` may reach the Assistant. */
export function checkAccess(chat: Pick<TelegramChat, "id" | "type"> | undefined, from: Pick<TelegramUser, "id"> | undefined): AccessResult {
  if (!chat) return { ok: false, refusal: "not-connected" };
  if (chat.type !== "private") return { ok: false, refusal: "not-private" };
  const connected = connectedChat(String(chat.id));
  if (!connected) return { ok: false, refusal: "not-connected" };
  if (!connected.userId) return { ok: false, refusal: "reconnect" };
  if (typeof from?.id !== "number" || String(from.id) !== connected.userId) return { ok: false, refusal: "wrong-user" };
  return { ok: true };
}

/** What a refused chat is told, once. Plain text that names nothing about this PPM. */
export function refusalText(refusal: AccessRefusal): string {
  switch (refusal) {
    case "not-private":
      return "PPM Assistant only answers in a private chat with the person who connected it.";
    case "not-connected":
      return "This chat is not connected to PPM Assistant. In PPM, open <b>Settings → PPM Assistant → Telegram</b> and tap <b>Connect Telegram</b>.";
    case "reconnect":
      return "This chat was connected by an older PPM. Please reconnect it from <b>Settings → PPM Assistant → Telegram</b>.";
    case "wrong-user":
      return "Only the person who connected this chat can use PPM Assistant here.";
  }
}
