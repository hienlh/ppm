import { isAssistantSession } from "../../services/assistant/assistant-session.ts";
import { collabApprovalBroker } from "../../services/session-collab/collab-approval-broker.ts";
import type { ChatMessageOrigin, LiveApprovalCard } from "../../services/chat-control/chat-control.ts";
import { SESSION_COLLAB_APPROVAL, sessionCollabApprovalInput } from "../../shared/session-collab.ts";

/**
 * The PPM Assistant's session-tool cards (a message into a chat, a chat it wants to open) beyond
 * the browser: told to the chat's server-side listeners, so the Assistant's Telegram bridge shows
 * them beside its other cards, and settled by a press there through the same broker a click in PPM
 * answers. Every other PPM approval stays with PPM's own screen.
 *
 * Telegram answers once or not at all: "allow for this session" is never offered off PPM, and the
 * Assistant's cards do not offer it anywhere.
 */

interface ApprovalEventLike {
  requestId: string;
  tool: string;
  input: unknown;
}

/** The card as listeners see it, when it is one of the Assistant's session-tool cards; else null. */
export function collabCardForListeners(sessionId: string, cwd: string | null | undefined, ev: ApprovalEventLike): LiveApprovalCard | null {
  if (ev.tool !== SESSION_COLLAB_APPROVAL || !sessionCollabApprovalInput(ev.tool, ev.input)) return null;
  if (!isAssistantSession(sessionId, cwd)) return null;
  return { requestId: ev.requestId, tool: ev.tool, input: ev.input, isQuestion: false };
}

/**
 * Settles one of PPM's own approvals pressed somewhere other than PPM: the session-tool card an
 * Assistant session is showing, pressed on Telegram. "stale" for anything else (a `db_execute`
 * change needs PPM's password; the Assistant answering another chat's card never settles one; a
 * card of another session) and for a card no longer waiting.
 */
export function settleCollabApprovalFromServer(
  sessionId: string, cwd: string | null | undefined, requestId: string, approved: boolean, origin: ChatMessageOrigin,
): "answered" | "stale" {
  if (origin !== "telegram" || collabApprovalBroker.pendingEvent(sessionId)?.requestId !== requestId) return "stale";
  if (!isAssistantSession(sessionId, cwd)) return "stale";
  const result = collabApprovalBroker.answer(requestId, { answer: approved ? "allow_once" : "deny" });
  return result.ok ? "answered" : "stale";
}
