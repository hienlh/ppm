/**
 * Which browser tab a chat socket belongs to, kept across that tab's reconnects.
 *
 * A chat tab reconnects its socket for ordinary reasons — a network blip, the server's idle
 * timeout, and for every new Codex chat the rename to its thread id, which reopens the socket
 * under the new id mid-turn. The server remembers the device a turn's message came from so the
 * PPM Assistant's screen requests go to that device only; keyed by the socket object alone, that
 * memory died with the old socket and every later request answered "no device" until the user
 * typed again. The tab sends this id with each connection (`?clientId=`), so its new socket is
 * recognised as the same tab.
 *
 * It is a routing hint and never a credential: every socket carrying it has already been
 * authenticated for the session, so a tab claiming another tab's id can at most receive a
 * request meant for another of the same user's devices.
 */

export const CHAT_CLIENT_ID_PARAM = "clientId";

const VALID = /^[A-Za-z0-9-]{8,64}$/;

/** The id when `raw` is a well-formed one; undefined for anything else, absent included. */
export function chatClientIdFrom(raw: string | null | undefined): string | undefined {
  return typeof raw === "string" && VALID.test(raw) ? raw : undefined;
}
