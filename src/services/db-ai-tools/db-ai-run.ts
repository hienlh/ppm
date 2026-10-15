import { commitsByItself } from "../../shared/db-ai-tools.ts";
import { splitSqlScript, sqlCode } from "../../shared/split-sql-statements.ts";
import { dialectNameOf, type DbType, type DialectName } from "../../shared/db-types.ts";
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
 *   the ones the AI said to expect, rolled back otherwise. MySQL and MariaDB commit a CREATE,
 *   ALTER, DROP or TRUNCATE by itself, with everything before it, so there the transaction is
 *   opened again after one, and a run rolled back says which statements were kept all the same.
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
  /**
   * Rolled back, or never begun. `kept` counts the statements, from the first, that the database
   * had committed by itself before then — only MySQL and MariaDB do — and is 0 when nothing the
   * script did was kept. `mayHaveKept`, more than `kept`, is set when the connection went before
   * the database could say whether the statement then running had ended the transaction: read
   * from the SQL, statements 1 to it may be in the database too.
   */
  | { committed: false; results: QueryStatementResult[]; rowsChanged: number; kept: number; mayHaveKept?: number; reason: string };

const BEGIN: Record<DialectName, string> = { postgres: "BEGIN", sqlite: "BEGIN", mysql: "START TRANSACTION" };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const COMMITS_BY_ITSELF = "MySQL and MariaDB commit a CREATE, ALTER, DROP or TRUNCATE by itself, with everything before it";

/** `statement 2`, or `statements 1–3`. */
const statementsLabel = (from: number, to: number): string => (from === to ? `statement ${from}` : `statements ${from}–${to}`);

/**
 * Runs the approved script inside one transaction on `session` (writable), and closes the
 * session. `expectedRows`, when given, must equal the rows the statements changed in all.
 * Never throws: what went wrong is in the report.
 */
export async function runApprovedScript(session: DbQuerySession, opts: {
  sql: string;
  dbType: DbType;
  maxRows: number;
  expectedRows?: number;
  /** How long one statement may run before it is cancelled. */
  timeoutMs?: number;
}): Promise<ApprovedRunReport> {
  const dialect = dialectNameOf(opts.dbType);
  const results: QueryStatementResult[] = [];
  let rowsChanged = 0;
  let begun = false;
  /**
   * Statements, from the first, that are in the database whatever happens next: MySQL and MariaDB
   * commit a CREATE, ALTER, DROP or TRUNCATE by itself, with everything before it, and end the
   * transaction there. PPM then opens it again, so that what follows can still be rolled back.
   */
  let kept = 0;
  /**
   * Set above `kept` when the connection went before the database could say whether the statement
   * then running had ended the transaction. The SQL says whether it may have (`commitsByItself`),
   * so the report says what may be in the database instead of claiming that nothing is.
   */
  let mayHaveKept = 0;
  /** False once a statement has ended the transaction, which only MySQL and MariaDB do. */
  const stillOpen = async (): Promise<boolean> => !session.transactionOpen || await session.transactionOpen();
  /** `cause`, and what the run left behind: nothing, the first `kept` statements, or maybe more. */
  const notKept = (cause: string): string => {
    if (mayHaveKept > kept) {
      const unsure = `${statementsLabel(kept + 1, mayHaveKept)} may have been kept`;
      const keptPart = kept === 0 ? unsure : `${statementsLabel(1, kept)} ${kept === 1 ? "was" : "were"} kept, and ${unsure} too`;
      return `${cause}, and the database could not be asked what it kept: ${keptPart}, because ${COMMITS_BY_ITSELF}.`;
    }
    if (kept === 0) return `${cause}, so the transaction was rolled back and nothing changed.`;
    const ran = results.filter((r) => r.error === undefined).length;
    const keptPart = `${statementsLabel(1, kept)} ${kept === 1 ? "was" : "were"} kept`;
    if (ran <= kept) return `${cause}, but nothing could be rolled back: ${keptPart}, because ${COMMITS_BY_ITSELF}.`;
    return `${cause}, so ${statementsLabel(kept + 1, ran)} ${ran - kept === 1 ? "was" : "were"} rolled back, but ${keptPart}, because ${COMMITS_BY_ITSELF}.`;
  };
  /**
   * Always `return await`ed: a promise returned unawaited from inside `try` does not hold back its
   * `finally`, which closes the session under the rollback — and on MySQL the rollback then never
   * answers, so the tool call hung.
   */
  const rolledBack = async (reason: string): Promise<ApprovedRunReport> => {
    let why = reason;
    if (begun) {
      try {
        await session.rollbackOpenTransaction();
      } catch (e) {
        why += ` Rolling back failed too (${errorText(e)}); the database ends the transaction when the connection closes.`;
      }
    }
    return { committed: false, results, rowsChanged, kept, ...(mayHaveKept > kept ? { mayHaveKept } : {}), reason: why };
  };
  try {
    const statements = splitSqlScript(opts.sql, dialect, session.splitOptions);
    if (statements.length === 0) return { committed: false, results, rowsChanged, kept, reason: "The script has no statements to run." };
    try {
      await session.run(BEGIN[dialect], 1);
      begun = true;
    } catch (e) {
      return { committed: false, results, rowsChanged, kept, reason: `The transaction could not be started: ${errorText(e)}` };
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
        // A statement that ends the transaction ends it before it runs, so even one that then fails
        // keeps what came before it. When the connection went before the database could say, the
        // SQL tells whether it may have; any other statement leaves the server to roll back.
        const open = await stillOpen().catch(() => null);
        if (open === false) kept = index;
        else if (open === null && commitsByItself(opts.dbType, statement.sql)) mayHaveKept = index;
        return await rolledBack(notKept(`Statement ${index + 1} failed`));
      } finally {
        if (timer) clearTimeout(timer);
      }
      const open = await stillOpen().catch((e: unknown) => {
        // It ran, and the connection went before the database could say whether it ended the
        // transaction: when the SQL says it does, it and everything before it may be in.
        if (commitsByItself(opts.dbType, statement.sql)) mayHaveKept = index + 1;
        throw e;
      });
      if (!open) {
        kept = index + 1;
        if (index < statements.length - 1) await session.run(BEGIN[dialect], 1);
      }
    }
    if (opts.expectedRows !== undefined && rowsChanged !== opts.expectedRows) {
      return await rolledBack(notKept(`The script changed ${rowsChanged} ${rowsChanged === 1 ? "row" : "rows"} in all, not the ${opts.expectedRows} expected`));
    }
    try {
      await session.run("COMMIT", 1);
    } catch (e) {
      return await rolledBack(notKept(`COMMIT failed (${errorText(e)})`));
    }
    return { committed: true, results, rowsChanged };
  } catch (e) {
    return await rolledBack(notKept(`The run broke off (${errorText(e)})`));
  } finally {
    await session.close().catch(() => {});
  }
}
