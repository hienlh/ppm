/**
 * Which Codex turn each rollout record belongs to, by the rules codex itself rebuilds a thread
 * with (`ThreadHistoryBuilder` in codex-rs `thread_history.rs`):
 *
 * - `task_started` opens an explicit turn and closes the one before; `task_complete` and
 *   `turn_aborted` close it.
 * - A user message inside an explicit turn joins it — that is a steered message (`turn/steer`).
 *   Outside one, every user message opens an implicit turn of its own (rollouts written before
 *   codex recorded turn ids).
 * - An implicit turn left with nothing in it is dropped, unless it saw a compaction.
 * - `thread_rolled_back.num_turns` removes that many *turns* — not user messages: a turn holding
 *   a steered message is one turn — after closing the open one.
 *
 * Shared by the history parser and the turn index so the two cannot disagree on a turn's id.
 */

interface OpenTurn {
  raw: string;
  explicit: boolean;
  items: number;
  sawCompaction: boolean;
}

/** Id of a turn codex did not name (an implicit turn), stable while the rollout is append-only. */
export function implicitTurnId(lineNo: number): string {
  return `u:L${String(lineNo).padStart(7, "0")}`;
}

export class CodexTurnTracker {
  /** Every turn still in the thread, in order, by raw id. */
  readonly turns: string[] = [];
  private current: OpenTurn | null = null;

  /** Raw id of the open turn, if any. */
  get currentId(): string | null {
    return this.current?.raw ?? null;
  }

  /** The open turn, else the newest one: where a tool call outside any turn is shown. */
  get latestId(): string | null {
    return this.current?.raw ?? this.turns[this.turns.length - 1] ?? null;
  }

  taskStarted(raw: string): void {
    this.finish();
    this.open(raw, true);
  }

  /** `task_complete` / `turn_aborted`: closes the open turn when it is the one named. */
  taskEnded(raw?: string): void {
    if (this.current && (!raw || this.current.raw === raw)) this.finish();
  }

  /** A user message on `lineNo`; returns the turn it belongs to. */
  userMessage(lineNo: number): string {
    const turn = this.current;
    if (turn && !turn.explicit && !(turn.sawCompaction && turn.items === 0)) this.finish();
    return this.item(lineNo);
  }

  /**
   * An answer; returns its turn. Tool calls are not counted: the index never reads them, and an
   * item count that differed between the two readers could move an implicit turn's boundary.
   */
  item(lineNo: number): string {
    const turn = this.ensure(lineNo);
    turn.items++;
    return turn.raw;
  }

  compacted(lineNo: number): string {
    const turn = this.ensure(lineNo);
    turn.sawCompaction = true;
    return turn.raw;
  }

  /** Removes the last `n` turns; returns their raw ids. */
  rollback(n: number): string[] {
    this.finish();
    if (n <= 0) return [];
    return this.turns.splice(Math.max(0, this.turns.length - n));
  }

  private ensure(lineNo: number): OpenTurn {
    return this.current ?? this.open(implicitTurnId(lineNo), false);
  }

  private open(raw: string, explicit: boolean): OpenTurn {
    this.current = { raw, explicit, items: 0, sawCompaction: false };
    this.turns.push(raw);
    return this.current;
  }

  private finish(): void {
    const turn = this.current;
    this.current = null;
    if (!turn || turn.explicit || turn.items > 0 || turn.sawCompaction) return;
    const at = this.turns.lastIndexOf(turn.raw);
    if (at !== -1) this.turns.splice(at, 1);
  }
}
