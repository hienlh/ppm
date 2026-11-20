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
   * other: the user's next message is their own answer to `questionId`; other_cancel: not any more.
   */
  op: "allow" | "deny" | "pick" | "toggle" | "next" | "back" | "send" | "other" | "other_cancel";
  questionId?: string;
  option?: string;
  /** back: the step the button was shown on, so a press left over from another step does nothing. */
  step?: number;
}

/** A button on one of the PPM Assistant's own cards (a manager's report, a rules change). */
export interface ManagerCardPress {
  kind: "mcard";
  cardId: string;
  /**
   * ok: the user's OK on the draft shown; choose: one of the card's choices; approve/revert: a held
   * rules change; send_anyway: a reply to a stale card.
   */
  op: "ok" | "choose" | "approve" | "revert" | "send_anyway";
  /** choose: the id of the choice the button stands for (its label is read from the stored card). */
  optionId?: string;
  /** ok: the hash of the draft the card showed when the button was made. */
  draftSha256?: string;
  /** approve/revert: the held change's hash, and the project it belongs to. */
  rulesHash?: string;
  projectName?: string;
  /** send_anyway: the reply waiting for the user's confirmation. */
  pendingId?: string;
}

/**
 * A button of PPM Tasks on Telegram: a `/tasks` deck, the card of a task the Assistant created, or
 * an Undo / Open on one of the Assistant's task cards. `ref` names the deck or created card held in
 * memory (`assistant-telegram-task-actions.ts`); a press on one that is gone says "send /tasks again".
 */
export interface TaskPress {
  kind: "task";
  ref: string;
  op:
    | "status" | "prev" | "next_page" | "position" | "filter" | "next" | "undo"
    | "tell" | "later" | "children" | "back"
    | "menu" | "set" | "undo_created"
    | "undo_history"
    /**
     * about: the user's next message goes to the chat working on `taskId`; ask: to the project's
     * manager chat, about `taskId`; about_cancel: not any more.
     */
    | "about" | "ask" | "about_cancel";
  taskId?: string;
  statusId?: string;
  /** filter: the project, or null for All. */
  projectKey?: string | null;
  /** menu/set: which field of a created task. */
  field?: "urgency" | "importance" | "due";
  value?: string;
  /** undo_history: the history row to undo. */
  historyId?: number;
}

export type BridgeAction =
  /** `/sessions`: talk to this session from now on. */
  | { kind: "switch"; sessionId: string }
  /** A message sent while PPM was off: run it now, or drop it. */
  | { kind: "backlog"; pendingId: string; run: boolean }
  /** `/quiet`: turn "quiet while I'm at PPM" on or off. */
  | { kind: "quiet"; on: boolean }
  /** A voice message's review card: send it (with the transcript as it stands now), or drop it. */
  | { kind: "voice"; id: string; send: boolean }
  | CardPress
  | ManagerCardPress
  | TaskPress;
