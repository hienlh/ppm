/**
 * What the bridge's inline buttons stand for, kept behind random codes (see
 * `assistant-telegram-button-codes.ts`).
 */

/** A button on an approval or question card. */
export interface CardPress {
  kind: "card";
  sessionId: string;
  requestId: string;
  /** allow/deny decide the card; pick answers a one-question card; toggle and send build a multi-choice answer. */
  op: "allow" | "deny" | "pick" | "toggle" | "send";
  questionId?: string;
  option?: string;
}

export type BridgeAction =
  /** `/sessions`: talk to this session from now on. */
  | { kind: "switch"; sessionId: string }
  /** A message sent while PPM was off: run it now, or drop it. */
  | { kind: "backlog"; pendingId: string; run: boolean }
  | CardPress;
