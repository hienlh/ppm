import { chatClientIdFrom } from "../../shared/chat-client-id";
import { uuidV4 } from "./device-id";

/**
 * This tab's chat client id (see `shared/chat-client-id.ts`), minted once per tab. Kept in
 * `sessionStorage` so it survives a reload of the same tab while another tab of the same browser
 * gets its own; storage that refuses (private mode) still yields one id per page load, which is
 * enough to survive a socket reconnect.
 */

export const CHAT_CLIENT_ID_KEY = "ppm-chat-client-id";

let memo: string | null = null;

export function getChatClientId(): string {
  if (memo) return memo;
  try {
    const stored = chatClientIdFrom(sessionStorage.getItem(CHAT_CLIENT_ID_KEY));
    if (stored) return (memo = stored);
  } catch {
    // Storage refused: fall through to an id for this page load.
  }
  const id = uuidV4();
  try { sessionStorage.setItem(CHAT_CLIENT_ID_KEY, id); } catch { /* see above */ }
  return (memo = id);
}
