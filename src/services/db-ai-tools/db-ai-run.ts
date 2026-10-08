import { splitSqlScript, sqlCode } from "../../shared/split-sql-statements.ts";
import type { DialectName } from "../../shared/db-types.ts";
import type { QueryStatementResult } from "../../shared/db-query-script.ts";
import type { DbQuerySession } from "../../types/database.ts";
import { QueryStatementError } from "../database/db-errors.ts";
import { QueryScriptRun, type QueryScriptSummary } from "../database/query-script-runner.ts";

/**
 * The database tools' runs, on a session the caller opened with the tool's own `readonly`:
 *
 * - `db_query` is the Query tab's run (`QueryScriptRun`) on a read-only session, so a write
 *   hidden in a function call is refused by the database itself, as it is everywhere in PPM.
 * - `db_execute` runs the script the user approved, once, inside one transaction PPM opens and
 *   ends itself: committed only when every statement succeeded and the rows changed in all are
 *   the ones the AI said to expect, rolled back otherwise.
 */

export interface AiQueryRun {
  results: QueryStatementResult[];
  summary: QueryScriptSummary;
  /** What the run said about itself rather than a statement: a transaction left open, rolled back. */
  messages: string[];
}

/** Runs `sql` statement by statement and closes the session. Never throws. */
export async function runAiQuery(session: DbQuerySession, opts: { sql: string; dialect: DialectName; maxRows: number; timeoutMs?: number }): Promise<AiQueryRun> {
  const results: QueryStatementResult[] = [];
  const messages: string[] = [];
  const run = new QueryScriptRun({ sql: opts.sql, dialect: opts.dialect, maxRows: opts.maxRows, timeoutMs: opts.timeoutMs });
  const summary = await run.execute(session, (event) => {
    if (event.type === "statement") results.push(event.result);
    else if (event.type === "message") messages.push(event.text);
    else if (event.type === "done" && event.error !== undefined) messages.push(event.error);
  });
  return { results, summary, messages };
}

/** Statements that begin or end a transaction: PPM opens and ends the one `db_execute` runs in. */
const TRANSACTION_CONTROL = /^\s*(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/i;

/** The first statement of `sql` that controls the transaction, or null. */
export function transactionControlIn(sql: string, dialect: DialectName): string | null {
  for (const statement of splitSqlScript(sql, dialect)) {
    if (TRANSACTION_CONTROL.test(sqlCode(statement.sql, dialect))) return statement.sql.trim().split(/\s+/).slice(0, 3).join(" ");
  }
  return null;
}

export type ApprovedRunReport =
  | { committed: true; results: QueryStatementResult[]; rowsChanged: number }
  /** Rolled back, or never begun: nothing the script did was kept. */
  | { committed: false; results: QueryStatementResult[]; rowsChanged: number; reason: string };

const BEGIN: Record<DialectName, string> = { postgres: "BEGIN", sqlite: "BEGIN", mysql: "START TRANSACTION" };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Runs the approved script inside one transaction on `session` (writable), and closes the
 * session. `expectedRows`, when given, must equal the rows the statements changed in all.
 * Never throws: what went wrong is in the report.
 */
export async function runApprovedScript(session: DbQuerySession, opts: {
  sql: string;
  dialect: DialectName;
  maxRows: number;
  expectedRows?: number;
  /** How long one statement may run before it is cancelled. */
  timeoutMs?: number;
}): Promise<ApprovedRunReport> {
  const results: QueryStatementResult[] = [];
  let rowsChanged = 0;
  let begun = false;
  const rolledBack = async (reason: string): Promise<ApprovedRunReport> => {
    let why = reason;
    if (begun) {
      try {
        await session.rollbackOpenTransaction();
      } catch (e) {
        why += ` Rolling back failed too (${errorText(e)}); the database ends the transaction when the connection closes.`;
      }
    }
    return { committed: false, results, rowsChanged, reason: why };
  };
  try {
    const statements = splitSqlScript(opts.sql, opts.dialect, session.splitOptions);
    if (statements.length === 0) return { committed: false, results, rowsChanged, reason: "The script has no statements to run." };
    try {
      await session.run(BEGIN[opts.dialect], 1);
      begun = true;
    } catch (e) {
      return { committed: false, results, rowsChanged, reason: `The transaction could not be started: ${errorText(e)}` };
    }
    for (const [index, statement] of statements.entries()) {
      const started = performance.now();
      const base = { index, startLine: statement.startLine, endLine: statement.endLine, sql: statement.sql };
      let timedOut = false;
      const timer = opts.timeoutMs === undefined ? null : setTimeout(() => {
        timedOut = true;
        session.cancel();
      }, opts.timeoutMs);
      try {
        const outcome = await session.run(statement.sql, opts.maxRows);
        results.push({
          ...base,
          ...(outcome.command ? { command: outcome.command } : {}),
          resultSets: outcome.resultSets.map(({ columns, rows, truncated }) => ({ columns, rows, ...(truncated ? { truncated: true } : {}) })),
          ...(outcome.rowsAffected !== undefined ? { rowsAffected: outcome.rowsAffected } : {}),
          ...(outcome.notices.length > 0 ? { notices: outcome.notices } : {}),
          durationMs: Math.round(performance.now() - started),
        });
        rowsChanged += outcome.rowsAffected ?? 0;
      } catch (e) {
        const message = e instanceof QueryStatementError || e instanceof Error ? e.message : String(e);
        const error = timedOut ? `Stopped after ${Math.round(opts.timeoutMs! / 1000)} s: ${message}` : message;
        results.push({ ...base, resultSets: [], durationMs: Math.round(performance.now() - started), error, ...(timedOut ? { stopped: "timeout" as const } : {}) });
        return rolledBack(`Statement ${index + 1} failed, so the transaction was rolled back and nothing changed.`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (opts.expectedRows !== undefined && rowsChanged !== opts.expectedRows) {
      return rolledBack(
        `The script changed ${rowsChanged} ${rowsChanged === 1 ? "row" : "rows"} in all, not the ${opts.expectedRows} expected, so the transaction was rolled back and nothing changed.`,
      );
    }
    try {
      await session.run("COMMIT", 1);
    } catch (e) {
      return rolledBack(`COMMIT failed (${errorText(e)}), so nothing changed.`);
    }
    return { committed: true, results, rowsChanged };
  } catch (e) {
    return rolledBack(`The run broke off: ${errorText(e)}`);
  } finally {
    await session.close().catch(() => {});
  }
}
