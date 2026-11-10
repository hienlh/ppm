import { getDb } from "../db.service.ts";
import { CARD_COLUMNS, rowFromDb, type CardOutbound, type CardRow, type TelegramCardRef } from "./assistant-cards-db.ts";

/**
 * Where each card stands on its way to the user's phone (`outbound`), and which Telegram messages
 * show it (`telegram_refs_json`). A Telegram message id is counted per chat, so a ref is always
 * the pair, and a reply is matched on both.
 */

const OUTBOUNDS: readonly CardOutbound[] = ["pending", "held", "sent", "skipped"];
/** Copies of one card kept at most: one per connected chat, and a phone rarely has more than a few. */
const MAX_REFS = 20;

export function setCardOutbound(id: string, outbound: CardOutbound, at: number): boolean {
  if (!OUTBOUNDS.includes(outbound)) throw new Error(`Unknown outbound "${String(outbound)}"`);
  return getDb().query("UPDATE assistant_cards SET outbound = ?, updated_at = ? WHERE id = ?").run(outbound, at, id).changes > 0;
}

/** Records that `ref` shows the card; the same pair twice is kept once. */
export function addCardTelegramRef(id: string, ref: TelegramCardRef): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.query(`SELECT ${CARD_COLUMNS} FROM assistant_cards WHERE id = ?`).get(id);
    if (!row) return;
    const refs = rowFromDb(row).telegramRefs.filter((r) => !(r.chatId === ref.chatId && r.messageId === ref.messageId));
    refs.push({ chatId: ref.chatId, messageId: ref.messageId });
    db.query("UPDATE assistant_cards SET telegram_refs_json = ? WHERE id = ?").run(JSON.stringify(refs.slice(-MAX_REFS)), id);
  })();
}

/** The card a Telegram message in `chatId` shows, if any: the same message id in another chat is another message. */
export function findCardByTelegramRef(chatId: string, messageId: number): CardRow | null {
  if (!Number.isInteger(messageId)) return null;
  const row = getDb().query(`SELECT ${CARD_COLUMNS} FROM assistant_cards
    WHERE telegram_refs_json IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(assistant_cards.telegram_refs_json) AS r
      WHERE json_extract(r.value, '$.chatId') = ? AND json_extract(r.value, '$.messageId') = ?
    ) ORDER BY created_at DESC LIMIT 1`).get(chatId, messageId);
  return row ? rowFromDb(row) : null;
}

/** Cards held for the end of quiet hours, oldest first. */
export function listHeldCardRows(): CardRow[] {
  return getDb().query(`SELECT ${CARD_COLUMNS} FROM assistant_cards WHERE outbound = 'held' ORDER BY created_at, rowid`).all().map(rowFromDb);
}
