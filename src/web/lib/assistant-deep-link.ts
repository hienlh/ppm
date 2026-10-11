/**
 * Addresses that open the PPM Assistant, and the session they name.
 *
 * `/assistant?session=<provider>/<id>` is what a Telegram "Open in PPM" button and a notification
 * about an Assistant session link to. The Assistant's chats live in a virtual project the app can
 * never open, and the older form of those links — `/project/__assistant__?openChat=<provider>/<id>`
 * — used to fall through to the first registered project and open the session there as an
 * ordinary chat, outside the Assistant and its rules. Both forms now land in the Assistant, on
 * whatever project is on screen.
 *
 * Pure (no stores), so it can be tested without mounting the app.
 */
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project";

/** The providers an Assistant session can run on. */
export const ASSISTANT_PROVIDER_IDS: readonly string[] = ["claude", "codex"];

/** What an Assistant address asks for. An empty object opens the Assistant as it is. */
export interface AssistantDeepLink {
  sessionId?: string;
  providerId?: string;
}

/** The ids the server's own Assistant routes accept. */
const SESSION_ID_RE = /^[\w.:-]{1,256}$/;

/**
 * Reads `<provider>/<id>` or a bare `<id>`. An id that is not one names nothing, so the
 * Assistant opens as it is; a provider the Assistant cannot run is dropped, and the Assistant
 * then looks the session up in its own list to find out which provider it is on.
 */
export function parseAssistantSessionRef(raw: string | null | undefined): AssistantDeepLink {
  if (!raw) return {};
  const slash = raw.indexOf("/");
  const provider = slash === -1 ? undefined : raw.slice(0, slash);
  const sessionId = slash === -1 ? raw : raw.slice(slash + 1);
  if (!SESSION_ID_RE.test(sessionId)) return {};
  if (provider && ASSISTANT_PROVIDER_IDS.includes(provider)) return { sessionId, providerId: provider };
  return { sessionId };
}

/** Decodes one path segment, keeping a malformed escape as it is rather than throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The Assistant session an address asks for, or null when the address is not an Assistant one.
 * Takes the pieces of `location` rather than reading it, so a test can pass any address.
 */
export function assistantLinkFromLocation(pathname: string, search: string): AssistantDeepLink | null {
  const params = new URLSearchParams(search);
  if (/^\/assistant\/?$/.test(pathname)) return parseAssistantSessionRef(params.get("session"));

  // The older notification link: `/project/__assistant__?openChat=…`, or a chat tab's address
  // under it (`/project/__assistant__/chat/<provider>/<id>`).
  const match = pathname.match(/^\/project\/([^/]+)(?:\/([^/]+)(?:\/(.*))?)?/);
  if (!match || decodeSegment(match[1]!) !== ASSISTANT_PROJECT_NAME) return null;
  const openChat = params.get("openChat");
  if (openChat) return parseAssistantSessionRef(openChat);
  if (match[2] === "chat" && match[3]) return parseAssistantSessionRef(decodeSegment(match[3]));
  return {};
}
