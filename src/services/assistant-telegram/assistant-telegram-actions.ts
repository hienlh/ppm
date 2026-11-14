/**
 * What the bridge's inline buttons stand for, kept behind random codes (see
 * `assistant-telegram-button-codes.ts`).
 */

/** A button on an approval or question card. */
export interface CardPress {
  kind: "card";
  sessionId: string;
  requestId: string;
  /**
   * allow/deny decide the card. pick answers a one-question card at once; on a card asked one
   * question at a time it records the choice and moves on. toggle ticks a choice of a question
   * that takes several, next leaves it, back returns to the question before, send answers them all.
   */
  op: "allow" | "deny" | "pick" | "toggle" | "next" | "back" | "send";
  questionId?: string;
  option?: string;
  /** back: the step the button was shown on, so a press left over from another step does nothing. */
  step?: number;
}

/** A button on one of the PPM Assistant's own cards (a manager's report, a rules change). */
export interface ManagerCardPress {
  kind: "mcard";
  cardId: string;
  /** ok: the user's OK on the draft shown; approve/revert: a held rules change; send_anyway: a reply to a stale card. */
  op: "ok" | "approve" | "revert" | "send_anyway";
  /** ok: the hash of the draft the card showed when the button was made. */
  draftSha256?: string;
  /** approve/revert: the held change's hash, and the project it belongs to. */
  rulesHash?: string;
  projectName?: string;
  /** send_anyway: the reply waiting for the user's confirmation. */
  pendingId?: string;
}

export type BridgeAction =
  /** `/sessions`: talk to this session from now on. */
  | { kind: "switch"; sessionId: string }
  /** A message sent while PPM was off: run it now, or drop it. */
  | { kind: "backlog"; pendingId: string; run: boolean }
  | CardPress
  | ManagerCardPress;
