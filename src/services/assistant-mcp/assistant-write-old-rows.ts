import type { Json } from "../mcp-http-endpoint.ts";
import type { ConnectionRow } from "../db.service.ts";
import type { DialectName } from "../../shared/db-types.ts";
import { sqlCode } from "../../shared/split-sql-statements.ts";
import type { DbStatementOutcome } from "../../types/database.ts";
import { getAdapter } from "../database/adapter-registry.ts";
import { dialectFor } from "../database/dialects.ts";
import { detectOperation } from "../query-audit/query-audit.service.ts";
import { connAudit, connConfig } from "../../server/routes/database-route-helpers.ts";
import { logQueryAs, type AuditCaller } from "../../server/routes/query-audit-hook.ts";
import { assistantSqlSafety } from "./assistant-sql-safety.ts";
import { assistantSqlReachSafety, type CatalogReader } from "./assistant-sql-reach-check.ts";
import { writeTargetSelect } from "./assistant-sql-write-target.ts";
import { clip, jsonResult } from "./assistant-tool-output.ts";
import { agentCell } from "./assistant-db-tools.ts";

/**
 * The old values of the rows an approved UPDATE or DELETE changes, so the agent can report what
 * was there before — the record it is told to keep, since there is no undo. The rows are read
 * with a SELECT of the same table and WHERE (`assistant-sql-write-target.ts`), on the same
 * connection and inside the same transaction as the write, immediately before it:
 *
 *  - The SELECT has to be provable the way an unasked read is — only safe-listed functions by
 *    its text, nothing more reached by the catalog — or it is not run: it would call whatever
 *    the WHERE calls once more, and a function with an effect must not run twice.
 *  - A WHERE whose answer can change between two statements of one transaction (random(), and
 *    on MySQL and SQLite the clock) would name other rows than the write changes, so it is not
 *    captured either. Postgres fixes `now()` and its kin for the whole transaction.
 *  - No locking clause is added. Postgres and MySQL read the SELECT from a snapshot while the
 *    write sees the latest committed rows, so a commit landing between the two statements can
 *    make them differ; the answer says the rows are as read just before the write. SQLite opens
 *    with BEGIN IMMEDIATE, which takes the write lock the UPDATE would take anyway, only first:
 *    a deferred transaction that read before writing can fail to upgrade with SQLITE_BUSY.
 *
 * At most {@link MAX_OLD_ROWS} rows come back, and the answer says when there were more. If
 * the SELECT itself fails (a login allowed to UPDATE but not to SELECT), the transaction is
 * rolled back and the write runs on its own, saying the old values were not captured.
 */

/**
 * The old rows one answer lists: as many as `db_query` returns. A literal rather than that
 * module's constant, which sits on an import cycle with this one.
 */
export const MAX_OLD_ROWS = 200;

const BEGIN: Record<DialectName, string> = { postgres: "BEGIN", mysql: "START TRANSACTION", sqlite: "BEGIN IMMEDIATE" };

/** Safe-listed functions whose answer may differ between two statements of one transaction. */
const VARIES = new Set([
  "random", "rand", "clock_timestamp", "statement_timestamp", "timeofday", "sysdate", "utc_timestamp", "utc_date", "utc_time",
  "curdate", "curtime", "unix_timestamp", "unixepoch",
]);
/** The clock: fixed for a whole transaction on Postgres only. */
const CLOCK = new Set(["now", "current_timestamp", "current_date", "current_time", "localtime", "localtimestamp", "transaction_timestamp"]);

export type OldRowsPlan = { ok: true; selectSql: string; called: Set<string> } | { ok: false; reason: string };

/** Whether the old values of `sql` can be captured, judged by its text: the SELECT that names them, or why not. */
export function planOldRows(sql: string, dialect: DialectName): OldRowsPlan {
  const target = writeTargetSelect(sql, dialect);
  if (!target.ok) return target;
  const called = new Set<string>();
  const text = assistantSqlSafety(target.selectSql, dialect, called);
  if (!text.proven) return { ok: false, reason: `reading them first would not be a plain read: ${text.reason}` };
  const words = new Set((sqlCode(target.selectSql, dialect).match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? []).map((w) => w.toLowerCase()));
  const varies = [...words].find((w) => VARIES.has(w) || (dialect !== "postgres" && CLOCK.has(w)));
  if (varies) return { ok: false, reason: `its WHERE uses ${varies}, which may answer differently for the write than for a read just before it` };
  // SQLite's date functions read the clock when given 'now'.
  if (dialect === "sqlite" && /'now'/i.test(target.selectSql)) return { ok: false, reason: "its WHERE reads the clock ('now'), which moves between two statements" };
  return { ok: true, selectSql: target.selectSql, called };
}

/** Whether the planned SELECT also reaches nothing beyond plain tables on this database (views, policies, user functions). */
export async function oldRowsReachable(plan: Extract<OldRowsPlan, { ok: true }>, dialect: DialectName, read: CatalogReader): Promise<{ ok: true } | { ok: false; reason: string }> {
  const reach = await assistantSqlReachSafety(plan.selectSql, dialect, plan.called, read);
  return reach.proven ? { ok: true } : { ok: false, reason: `reading them first could run more than a plain read: ${reach.reason}` };
}

export type OldRowsRun =
  | { kind: "done"; result: Json }
  /** The rows could not be read; nothing was written, and the write may run on its own. */
  | { kind: "not-read"; reason: string }
  | { kind: "failed"; error: unknown };

/**
 * Runs the planned SELECT and then `sql` in one transaction on `conn` (writable, not read-only),
 * audited as the agent's write. Nothing is written unless the whole transaction commits.
 */
export async function runWriteWithOldRows(conn: ConnectionRow, sql: string, selectSql: string, caller: AuditCaller): Promise<OldRowsRun> {
  const dialect = dialectFor(conn.type).name;
  const startedAt = Date.now();
  const audit = (fields: { status: "ok" | "error"; error?: string; rowCount?: number }) => {
    logQueryAs(caller, { ...connAudit(conn), source: "editor", operation: detectOperation(sql), sql, ...fields, durationMs: Date.now() - startedAt });
  };
  const session = await getAdapter(conn.type).openQuerySession(connConfig(conn));
  try {
    await session.run(BEGIN[dialect], MAX_OLD_ROWS);
    let before: DbStatementOutcome;
    try {
      before = await session.run(selectSql, MAX_OLD_ROWS);
    } catch (e) {
      await session.rollbackOpenTransaction().catch(() => false);
      return { kind: "not-read", reason: `reading them first failed: ${clip((e as Error)?.message ?? String(e), 300)}` };
    }
    let wrote: DbStatementOutcome;
    try {
      wrote = await session.run(sql, MAX_OLD_ROWS);
      await session.run("COMMIT", MAX_OLD_ROWS);
    } catch (e) {
      await session.rollbackOpenTransaction().catch(() => false);
      audit({ status: "error", error: (e as Error)?.message ?? String(e) });
      return { kind: "failed", error: e };
    }
    const rowsAffected = wrote.rowsAffected ?? 0;
    audit({ status: "ok", rowCount: rowsAffected });
    const set = before.resultSets[0];
    const oldRows = (set?.rows ?? []).map((row) => row.map(agentCell));
    const capped = !!set?.truncated;
    return {
      kind: "done",
      result: jsonResult({
        connection: conn.name,
        rowsAffected,
        oldRowsNote: "The rows as they were just before the write, read in the same transaction.",
        columns: (set?.columns ?? []).map((c) => c.name),
        oldRows,
        oldRowsCapped: capped,
        ...(capped ? { oldRowsCappedNote: `Only the first ${MAX_OLD_ROWS} changed rows are listed; the write changed ${rowsAffected}.` } : {}),
        executionTimeMs: Date.now() - startedAt,
      }, { key: "oldRows", list: oldRows }),
    };
  } finally {
    await session.close().catch(() => {});
  }
}
