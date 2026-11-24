import { collabApprovalBroker } from "../../services/session-collab/collab-approval-broker.ts";
import type { ChatMessageOrigin, LiveApprovalCard } from "../../services/chat-control/chat-control.ts";
import { SESSION_COLLAB_APPROVAL, sessionCollabApprovalInput } from "../../shared/session-collab.ts";
import { decidingInput } from "../../services/chat-control/approval-deciding-input.ts";

/**
 * The session tools' cards (a message into a chat, a chat to open) beyond the browser: told to the
 * chat's server-side listeners whichever chat shows them, so the PPM Assistant's "Waiting on you"
 * and its Telegram bridge carry them beside every other card, and settled by a person's press there
 * through the same broker a click in PPM answers. A chat that waits on such a card is stopped until
 * someone answers, and the card gives up after an hour: shown only on PPM's screen, it ran out
 * while the user was away and never knew.
 *
 * Off PPM a card answers once or not at all: "allow for this session" is never offered there.
 * `db_execute` and vault cards stay with PPM's own screen: they take a password typed into PPM.
 */

interface ApprovalEventLike {
  requestId: string;
  tool: string;
  input: unknown;
  remember?: LiveApprovalCard["remember"];
}

/** The card as listeners see it, when it is a session-tool card; else null. */
export function collabCardForListeners(ev: ApprovalEventLike): LiveApprovalCard | null {
  if (ev.tool !== SESSION_COLLAB_APPROVAL || !sessionCollabApprovalInput(ev.tool, ev.input)) return null;
  const expiresAt = collabApprovalBroker.expiresAt(ev.requestId);
  return {
    requestId: ev.requestId, tool: ev.tool, input: ev.input, isQuestion: false,
    ...(expiresAt ? { expiresAt } : {}), ...(ev.remember ? { remember: ev.remember } : {}),
  };
}

/**
 * Who may settle a session-tool card from outside PPM's chat: the user pressing a button on
 * Telegram, or on the Assistant's mirror of the card in PPM. Never the Assistant's model answering
 * another chat's card (`assistant`), and never anything that is not a person's press.
 */
const PRESSES: ReadonlySet<ChatMessageOrigin> = new Set<ChatMessageOrigin>(["telegram", "assistant_card"]);

/**
 * Settles one of PPM's own approvals pressed somewhere other than the chat itself: a session-tool
 * card, pressed on Telegram or on its mirror in the Assistant. "stale" for anything else (a
 * `db_execute` change needs PPM's password; the Assistant answering another chat's card never
 * settles one; a card of another session) and for a card no longer waiting.
 */
export function settleCollabApprovalFromServer(
  sessionId: string, requestId: string, approved: boolean, origin: ChatMessageOrigin,
): "answered" | "stale" {
  const pending = collabApprovalBroker.pendingEvent(sessionId);
  if (!PRESSES.has(origin) || pending?.requestId !== requestId) return "stale";
  // A card that may be allowed only in PPM (a script schedule) is never allowed from here, whatever
  // button a surface drew: only its Deny is taken.
  if (approved && !decidingInput({ tool: pending.tool, input: pending.input }).complete) return "stale";
  const result = collabApprovalBroker.answer(requestId, { answer: approved ? "allow_once" : "deny" });
  return result.ok ? "answered" : "stale";
}
