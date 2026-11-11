/**
 * Whose turn a chat's running turn is (`turnOrigin`), as messages arrive. It decides whether the
 * turn is unattended (a `watch` turn: no approval is shown, a PPM Assistant creates nothing and its
 * notebook lines are unverified), so only a message that owns a turn may set it:
 *
 * - a message that **opens** a turn sets it — a scheduled script posting into a PPM Assistant
 *   session opens an unattended one;
 * - the user typing into a running turn (`next`/`now`) makes that turn theirs;
 * - anything else that reaches a running turn — a scheduled script, or the user's own `later`
 *   message — leaves the running turn's owner alone. When it is queued behind that turn, it is
 *   remembered and applied once the running turn ends, for the turn it will open.
 */
import type { ChatMessageOrigin } from "../../services/chat-control/chat-control.ts";
import type { SessionDelivery } from "../../shared/session-collab.ts";

export interface TurnOriginEntry {
  turnOrigin?: ChatMessageOrigin;
  /** The owner of the turn a message queued behind the running one will open. */
  nextTurnOrigin?: ChatMessageOrigin;
  phase: string;
  isStreamingActive?: boolean;
}

export interface ArrivingMessage {
  origin: ChatMessageOrigin;
  /** Posted by an in-process door (a script schedule), not typed by a person. */
  scripted: boolean;
  /** The chat is a PPM Assistant session. */
  assistant: boolean;
  priority?: "now" | "next" | "later";
}

/** The owner a message would give a turn: a script in an Assistant session is PPM, unattended. */
export const ownerOf = (m: ArrivingMessage): ChatMessageOrigin => (m.scripted && m.assistant ? "watch" : m.origin);

/** Whether the chat has a turn running that a message would reach rather than open. */
export const turnRunning = (entry: TurnOriginEntry): boolean => !!entry.isStreamingActive && entry.phase !== "idle";

/** Before the message is handed over: sets the owner when it opens a turn or the user joins one. */
export function claimTurnOrigin(entry: TurnOriginEntry, m: ArrivingMessage): void {
  const joinsAsUser = !m.scripted && m.priority !== "later";
  if (!turnRunning(entry)) {
    entry.turnOrigin = ownerOf(m);
    // Nothing is queued behind a turn that is not running: an owner left from one is stale.
    entry.nextTurnOrigin = undefined;
  } else if (joinsAsUser) entry.turnOrigin = ownerOf(m);
}

/** After the hand-off: a message queued behind the running turn owns the turn it will open. */
export function noteQueuedTurnOrigin(entry: TurnOriginEntry, m: ArrivingMessage, delivered: SessionDelivery, wasRunning: boolean): void {
  if (wasRunning && delivered === "queued") entry.nextTurnOrigin ??= ownerOf(m);
}

/** The running turn ended: the owner a queued message was given takes over for the turn it opens. */
export function turnOriginAfterTurn(entry: TurnOriginEntry): void {
  if (entry.nextTurnOrigin === undefined) return;
  entry.turnOrigin = entry.nextTurnOrigin;
  entry.nextTurnOrigin = undefined;
}
