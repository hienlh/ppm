/**
 * How one of PPM's own approval cards (a session tool's, a `db_execute` change, a vault unlock)
 * left the chat: the user `answered` it (either way), nobody answered before its deadline
 * (`expired`), or it `ended` for another reason (the call was cancelled, the turn stopped). The
 * brokers say it; the chat turns it into the slot's end reason, which the PPM Assistant's
 * "Waiting on you" and Telegram read to tell the user what happened.
 */
export type PpmCardEnd = "answered" | "expired" | "ended";

/** The end of a card whose broker settled it with `reason` (`timeout` when nobody answered). */
export function ppmCardEnd(answeredByUser: boolean, reason: string | undefined): PpmCardEnd {
  if (answeredByUser) return "answered";
  return reason === "timeout" ? "expired" : "ended";
}
