/**
 * What `POST /chat/sessions/:id/file-changes` and its `/diff` route answer: a chat
 * session's changes, file by file, against the state each file was in before the session
 * first touched it. Shared because the server produces it and the changes bar and the
 * Review tab render it.
 */

export type SessionChangeStatus = "added" | "modified" | "deleted";

export interface SessionFileChange {
  /** Absolute path. */
  path: string;
  status: SessionChangeStatus;
  /** Lines; absent when they cannot be counted (binary or oversized on either side). */
  additions?: number;
  deletions?: number;
  /** Where the "before" came from: the session's own copy, or git HEAD. */
  baseline: "session" | "head";
  binary?: boolean;
  tooLarge?: boolean;
  /**
   * Size and modification time of the file on disk ("" once it is deleted): moves with every
   * write, so a diff on screen can tell it is stale even when the line counts did not change.
   */
  version: string;
  /** The user marked the file reviewed and it is still as marked: the list hides it. */
  reviewed?: boolean;
  /**
   * The user marked the file reviewed and it has changed since: its line counts and diff are
   * against the state it was marked in, so only what is new is left to read.
   */
  sinceReview?: boolean;
  /**
   * The file's change blocks in file order (`src/shared/review-blocks.ts`). Absent when the
   * file can only be answered whole: binary, oversized, or too slow to diff.
   */
  blocks?: SessionBlockSummary[];
  /**
   * Names the text the blocks were cut against (a hash of it): it moves when the file is marked
   * reviewed or changes after its mark, and with it every block's place in the base.
   */
  base?: string;
}

export interface SessionBlockSummary {
  key: string;
  added: number;
  removed: number;
  /** The user kept it, or the whole file is marked reviewed. */
  kept?: boolean;
  /**
   * The calls that wrote it, in the order they ran: tool use ids, or codex item ids — what the
   * chat's tool cards carry, so a block can name its turn. Absent where the session's history
   * names none (a session from before it was kept, or a change no call made).
   */
  calls?: string[];
}

export interface SessionFileDiff extends SessionFileChange {
  original: string;
  modified: string;
}

/** What `POST …/file-changes/reviewed` answers. */
export interface SessionReviewResult {
  /** Paths marked or unmarked. */
  updated: string[];
  /** Paths left as they were: no longer a change, or no longer the version that was shown. */
  stale: string[];
}

/**
 * What an answer does to the blocks it names: keep them, open them again, or put them back on
 * disk the way they were (`POST …/file-changes/answer`).
 */
export type SessionAnswer = "keep" | "open" | "revert";

/** One file in an answer, at the version the browser drew it; every block when `keys` is absent. */
export interface SessionAnswerFile {
  path: string;
  version: string;
  keys?: string[];
}

export interface SessionFileAnswer {
  path: string;
  /** Nothing was done: the file is no longer as it was drawn. */
  stale?: boolean;
  /** Nothing was done for another reason, such as a revert with no copy to put back. */
  error?: string;
  /** The file as it stands now; null once it has no change left. */
  file: SessionFileChange | null;
}

/** What an answer, and its undo, come back with. */
export interface SessionAnswerResult {
  files: SessionFileAnswer[];
  /** Names the answer for `…/file-changes/undo`; absent when it changed nothing. */
  undoId?: string;
  /** Undo only: nothing was put back, because a file is no longer as the answer left it. */
  stale?: boolean;
}

/**
 * What reverting a turn does to one file (`POST …/file-changes/revert-turn`): the turn's own
 * changes put back where their lines are still as the turn left them, and the others named.
 */
export interface TurnRevertFile {
  path: string;
  /** The file's version this was worked out against; the revert is refused once it moves. */
  version: string;
  /**
   * `edit`: lines go back. `delete`: the turn created the file and nothing since touched it, so
   * it goes. `restore`: the turn deleted the file and it comes back. `none`: nothing to put back.
   */
  action: "edit" | "delete" | "restore" | "none";
  /** The turn's changes put back, and the lines they had added and taken out. */
  changes: number;
  added: number;
  removed: number;
  /**
   * The turn's changes left as they are because their lines changed since: where each sits now
   * (1-based) and the calls that changed it — "" for a change no call made.
   */
  skipped: { line: number; by: string[] }[];
  /** Why nothing could be worked out for this file. */
  error?: string;
}

export interface TurnRevertResult {
  files: TurnRevertFile[];
  /** Names the revert for `…/file-changes/undo`; absent when nothing was written. */
  undoId?: string;
  /** A file moved on since `files` was shown: nothing was written, and `files` is worked out again. */
  stale?: boolean;
}
