/**
 * The Query tab's run (see `db-query-script.ts`): a script split the way the server reads it, run
 * statement by statement on one session, and what each statement did handed over as it finishes.
 * Nothing here knows an engine — the session is the engine — so the loop is tested on a fake one.
 */
import { lineOfPosition, splitSqlScript, sqlCode, type SqlScriptStatement } from "../../shared/split-sql-statements.ts";
import type { DialectName } from "../../shared/db-types.ts";
import type { QueryResultSet, QueryScriptEvent, QueryStatementResult } from "../../shared/db-query-script.ts";
import type { DbQuerySession, DbStatementOutcome } from "../../types/database.ts";
import { isReadonlyRefusal, QueryStatementError, readonlyRefusalMessage } from "./db-errors.ts";

export interface QueryScriptOptions {
  sql: string;
  dialect: DialectName;
  /** Rows each result keeps. */
  maxRows: number;
  /** Go on after a statement that failed or timed out. Stop and a lost connection end the run regardless. */
  continueOnError?: boolean;
  /** EXPLAIN each statement rather than run it. */
  explain?: boolean;
  /** How long one statement may run before it is cancelled; no limit when absent. */
  timeoutMs?: number;
}

/** What the audit log keeps of a run. */
export interface QueryScriptSummary {
  status: "ok" | "error" | "blocked";
  /** The first thing that went wrong. */
  error?: string;
  /** Rows the statements returned and rows they wrote, together. */
  rowCount: number;
  /** The last result, for the log's sample of rows. */
  lastResult?: QueryResultSet;
}

/** Said when a run leaves a transaction open: the session ends with the run, and would take it along. */
export const ROLLED_BACK_OPEN_TRANSACTION =
  "The script began a transaction and did not end it, so it was rolled back. Run the whole transaction at once, ending it with COMMIT.";

const EXPLAIN_PREFIX: Record<DialectName, string> = { postgres: "EXPLAIN ", mysql: "EXPLAIN ", sqlite: "EXPLAIN QUERY PLAN " };

/**
 * How long a run may hold the thread before it pauses for the server to read what came meanwhile.
 * SQLite runs on this thread: without the pause, a Stop sent during a statement was read only once
 * the whole script had run — every statement after it run too — and every other request waited as
 * long. Only time the thread was held counts, so a run on a server over the network never pauses.
 */
const HOLD_LIMIT_MS = 100;
/**
 * The pause. Reading a Stop request takes the server several turns of the event loop — three, 7 ms,
 * on a quiet one — so a single `setTimeout(0)` let it in only after the next statement. A timer, not
 * `setImmediate`, which does not let a request in.
 */
const PAUSE_MS = 10;

/**
 * Statements EXPLAIN is not put in front of: a plan already, or one that `EXPLAIN ANALYZE` — the
 * text EXPLAIN in front of `ANALYZE …` makes — would run for real.
 */
const NOT_EXPLAINABLE = /^\s*(explain|analy[sz]e|describe|desc)\b/i;

/** The line of the script a statement's error points at, when the server said where. */
function errorLineOf(statement: SqlScriptStatement, where: QueryStatementError["where"], prefixLength: number): number | undefined {
  if (where.position !== undefined) {
    const position = where.position - prefixLength;
    return position >= 1 ? lineOfPosition(statement, position) : undefined;
  }
  if (where.line !== undefined) return Math.min(statement.firstLine + where.line - 1, statement.endLine);
  return undefined;
}

function resultSetsOf(outcome: DbStatementOutcome): QueryResultSet[] {
  return outcome.resultSets.map(({ columns, rows, truncated }) => ({ columns, rows, ...(truncated ? { truncated: true } : {}) }));
}

export class QueryScriptRun {
  private stopRequested = false;
  private session: DbQuerySession | null = null;
  /** Time the run has held the thread since it last paused. */
  private held = 0;

  constructor(private readonly options: QueryScriptOptions) {}

  /** Stop: the statement running is cancelled and none after it starts — also when no session is open yet. */
  stop(): void {
    this.stopRequested = true;
    this.session?.cancel();
  }

  /**
   * Run the script on `session`, and close it. Never throws: what went wrong is in the events and
   * the summary. A transaction the script left open is rolled back, and said so.
   */
  async execute(session: DbQuerySession, emit: (event: QueryScriptEvent) => void): Promise<QueryScriptSummary> {
    const started = performance.now();
    const summary: QueryScriptSummary = { status: "ok", rowCount: 0 };
    const fail = (status: "error" | "blocked", message: string) => {
      if (summary.status !== "blocked") summary.status = status;
      summary.error ??= message;
    };
    let broken: string | undefined;
    let connectionLost = false;
    this.session = session;
    try {
      const statements = splitSqlScript(this.options.sql, this.options.dialect, session.splitOptions);
      emit({ type: "start", statements: statements.map(({ startLine, endLine }) => ({ startLine, endLine })) });
      for (const [index, statement] of statements.entries()) {
        if (this.stopRequested) break;
        emit({ type: "running", index });
        const { result, refused, fatal } = await this.runOne(session, statement, index);
        emit({ type: "statement", result });
        for (const set of result.resultSets) summary.rowCount += set.rows.length;
        summary.rowCount += result.rowsAffected ?? 0;
        if (result.resultSets.length > 0) summary.lastResult = result.resultSets[result.resultSets.length - 1];
        if (result.error !== undefined) fail(refused ? "blocked" : "error", result.error);
        else if (result.stopped) fail("error", result.stopped === "user" ? "Stopped" : "Timed out");
        if (fatal) {
          connectionLost = true;
          break;
        }
        if (this.stopRequested) break;
        if ((result.error !== undefined || result.stopped) && !this.options.continueOnError) break;
      }
      if (!connectionLost && await session.rollbackOpenTransaction().catch(() => false)) {
        emit({ type: "message", level: "error", text: ROLLED_BACK_OPEN_TRANSACTION });
        fail("error", ROLLED_BACK_OPEN_TRANSACTION);
      }
    } catch (e) {
      broken = (e as Error | null)?.message ?? String(e);
      fail("error", broken);
    } finally {
      this.session = null;
      await session.close().catch(() => {});
    }
    emit({ type: "done", durationMs: Math.round(performance.now() - started), ...(broken !== undefined ? { error: broken } : {}) });
    return summary;
  }

  private async runOne(
    session: DbQuerySession, statement: SqlScriptStatement, index: number,
  ): Promise<{ result: QueryStatementResult; refused: boolean; fatal: boolean }> {
    const { dialect, explain, maxRows, timeoutMs } = this.options;
    const prefix = explain ? EXPLAIN_PREFIX[dialect] : "";
    const base = { index, startLine: statement.startLine, endLine: statement.endLine, sql: statement.sql };
    const started = performance.now();
    let timedOut = false;
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      session.cancel();
    }, timeoutMs);
    let outcome: DbStatementOutcome;
    try {
      if (explain && NOT_EXPLAINABLE.test(sqlCode(statement.sql, dialect, session.splitOptions))) {
        throw new QueryStatementError("This statement is already an EXPLAIN, ANALYZE or DESCRIBE: run it instead");
      }
      outcome = await this.settled(() => session.run(prefix + statement.sql, maxRows));
    } catch (e) {
      const error = e instanceof QueryStatementError ? e : new QueryStatementError((e as Error | null)?.message ?? String(e), {}, e);
      const refused = isReadonlyRefusal(error.cause);
      const errorLine = errorLineOf(statement, error.where, prefix.length);
      const stopped = timedOut ? "timeout" : this.stopRequested ? "user" : undefined;
      const message = refused
        ? readonlyRefusalMessage(error.cause)
        : stopped === "timeout" ? `Stopped after the connection's query timeout (${timeoutMs! / 1000} s): ${error.message}` : error.message;
      const result: QueryStatementResult = {
        ...base, resultSets: [], durationMs: Math.round(performance.now() - started), error: message,
        ...(errorLine !== undefined ? { errorLine } : {}),
        ...(stopped ? { stopped } : {}),
      };
      return { result, refused, fatal: error.fatal };
    } finally {
      if (timer) clearTimeout(timer);
    }
    // MySQL answers a SLEEP() it was told to stop by ending it successfully.
    const stopped = timedOut ? "timeout" : this.stopRequested ? "user" : undefined;
    const result: QueryStatementResult = {
      ...base,
      ...(outcome.command ? { command: outcome.command } : {}),
      resultSets: resultSetsOf(outcome),
      ...(outcome.rowsAffected !== undefined ? { rowsAffected: outcome.rowsAffected } : {}),
      ...(outcome.notices.length > 0 ? { notices: outcome.notices } : {}),
      durationMs: Math.round(performance.now() - started),
      ...(stopped ? { stopped } : {}),
    };
    return { result, refused: false, fatal: false };
  }

  /** What `work` ends with, once the server has read what came while the run held the thread — a Stop among it. */
  private async settled<T>(work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const pending = work();
    // What ran before `work` handed its promise back held the thread: all of a SQLite statement.
    this.held += performance.now() - start;
    try {
      return await pending;
    } finally {
      if (this.held >= HOLD_LIMIT_MS) {
        this.held = 0;
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      }
    }
  }
}
