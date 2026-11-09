/**
 * Shapes shared by the session turn index: what a scan of one transcript records about each
 * turn, and the errors the index answers with.
 *
 * A turn is everything from one real prompt (see `shared/user-prompt-kind.ts`) up to the next.
 * Its id is provider-native — Claude: that prompt record's `promptId` (`u:<uuid>` when it has
 * none); Codex: the `turn_id` codex wrote — so a link to a turn survives every rewrite PPM does
 * not control. `n` counts the session's turns from its very first prompt, compactions included.
 */

/** A turn id as either provider writes it. Checked on every id that arrives from outside. */
export { TURN_ID_RE } from "../../shared/session-turn-ids.ts";

export type TurnProviderId = "claude" | "codex";

export type SessionTurnErrorCode =
  /** No turn with that id in the session. */
  | "not_found"
  /** The turn existed but a Codex rollback removed it from the thread. */
  | "rolled_back"
  /** The session's transcript is not in the caller's project, or not on disk. */
  | "session_missing"
  /** The transcript changed under the index and the turn could not be found again. */
  | "stale"
  /** A session or turn id that is not the shape either provider writes. */
  | "invalid";

export class SessionTurnError extends Error {
  constructor(readonly code: SessionTurnErrorCode, message: string) {
    super(message);
    this.name = "SessionTurnError";
  }
}

/** One turn as a scan saw it. Byte offsets are into the transcript file. */
export interface IndexedTurn {
  turnId: string;
  /** The value the turn's first line is re-checked against before a range read is trusted:
   *  Claude, that record's `promptId` or uuid (`u:` ids); Codex, the `turn_id`. */
  anchor: string;
  /** ISO time of the prompt. */
  startedAt: string;
  /** First line of the prompt, at most 200 characters. */
  prompt: string;
  /**
   * Messages the chat shows for the turn: its prompt, other user messages (steered, notified),
   * and one per assistant reply — a Claude reply's thinking, text and tool calls are separate
   * records under one message id and count once. Tool results are not counted.
   */
  messageCount: number;
  /** Where the turn's first line starts. */
  startByte: number;
  /** Where the next turn starts (exclusive); absent while it is the newest turn. */
  endByte?: number;
  /** Codex only: the turn reported `task_complete` or `turn_aborted`. */
  closed?: boolean;
  /** The turn's range holds a compaction, which a reader shows as one marker. */
  compacted?: boolean;
}

/**
 * What the index saw begin at a byte offset, so a reader can check it is still there: a turn's
 * first line (its anchor, and for a Codex turn its prompt label), or a Codex rollback record,
 * which ends the range of the turn before it.
 */
export type TurnBoundary = { anchor: string; prompt: string | null } | "rollback";

/** A byte range of a transcript; `to` absent means "to where the index has read". */
export interface ByteRange {
  from: number;
  to?: number;
}

/**
 * The visible turns of one scan, in order (`n` = position + 1), each with the byte ranges that
 * hold it — a Codex turn also owns the prompt-less turns after it (a manual `/compact`), and
 * never a rolled-back turn that sits between them in the file.
 */
export interface TurnView {
  turns: Array<IndexedTurn & { ranges: ByteRange[] }>;
  /** The turn a message key belongs to — Claude: a record uuid; Codex: a native turn id. */
  stampOf(key: string): TurnStamp | undefined;
  /** Every key `stampOf` answers for. */
  keys(): Iterable<string>;
  /** The turn was in the thread once and a rollback removed it. */
  isRolledBack(turnId: string): boolean;
  /** What begins at `offset`, when it is a turn start or range end the index recorded. */
  boundaryAt(offset: number): TurnBoundary | undefined;
}

/** A turn as the index answers for it. */
export interface SessionTurnSummary {
  turnId: string;
  n: number;
  startedAt: string;
  prompt: string;
  messageCount: number;
  status: "complete" | "running";
}

/** What a message is stamped with. */
export interface TurnStamp {
  turnId: string;
  n: number;
}

/**
 * The marker a reader shows where a turn's range holds a compaction, and the synthetic message
 * a full Codex parse leaves in its place. No one said it, and it is in no turn.
 */
export const COMPACTED_MARKER = "(context compacted here)";
