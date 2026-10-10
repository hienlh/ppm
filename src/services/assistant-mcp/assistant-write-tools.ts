import type { Json } from "../mcp-http-endpoint.ts";
import { getConnectionById, type ConnectionRow } from "../db.service.ts";
import { dialectFor } from "../database/dialects.ts";
import { isReadOnlyQuery } from "../database/readonly-check.ts";
import { READONLY_CONNECTION_MESSAGE, runConnectionQuery } from "../database/run-connection-query.ts";
import { detectOperation } from "../query-audit/query-audit.service.ts";
import { logQueryAs, type AuditCaller } from "../../server/routes/query-audit-hook.ts";
import { connAudit } from "../../server/routes/database-route-helpers.ts";
import { DB_QUERY_TOOL } from "../../shared/assistant-tool-names.ts";
import { dbWriteSummary } from "./assistant-approval-summary.ts";
import type { AskApproval } from "./assistant-approval-broker.ts";
import { queryFailedResult, queryResultJson } from "./assistant-db-tools.ts";
import { clip, errorResult } from "./assistant-tool-output.ts";
import { connectionCatalogReader, type CatalogReader } from "./assistant-sql-reach-check.ts";
import { isUpdateOrDelete } from "./assistant-sql-write-target.ts";
import { oldRowsReachable, planOldRows, runWriteWithOldRows, type OldRowsRun } from "./assistant-write-old-rows.ts";

/**
 * The Assistant's database writes: SQL that PPM could not prove only reads. It runs only after
 * the user approved the card showing it in full, and then exactly as the connection allows —
 * through the same `runConnectionQuery` the editor uses, audited as the agent's:
 *  - a read-only connection never runs a write: anything but a plain read is refused before
 *    the user is even asked, and an approved read still goes down the read-only path;
 *  - a connection the user took away from the AI, or made read-only, while the card waited is
 *    checked again after the answer, and nothing runs on it;
 *  - an UPDATE or DELETE whose rows PPM can name safely answers with those rows as they were,
 *    read in the same transaction just before the write (`assistant-write-old-rows.ts`); any
 *    other UPDATE or DELETE runs as typed, and the answer says its old values were not captured.
 */

const audit = (caller: AuditCaller, conn: ConnectionRow, sql: string, error: string): void => {
  logQueryAs(caller, {
    ...connAudit(conn), source: "editor", operation: detectOperation(sql), sql, status: "blocked", error, durationMs: 0,
  });
};

export async function runApprovedQuery(
  conn: ConnectionRow,
  sql: string,
  why: string,
  caller: AuditCaller,
  ask: AskApproval,
  read?: CatalogReader,
): Promise<Json> {
  const dialect = dialectFor(conn.type).name;
  if (conn.readonly && !isReadOnlyQuery(sql, dialect)) {
    const message = `Not run: "${conn.name}" is a read-only connection and this statement may change data (${why}). `
      + "PPM never writes through a read-only connection; the user can change that setting in PPM themselves.";
    audit(caller, conn, sql, message);
    return errorResult(message);
  }

  const verdict = await ask({
    tool: DB_QUERY_TOOL,
    input: { connection: conn.name, sql },
    summary: dbWriteSummary({ connection: { name: conn.name, type: conn.type, readonly: !!conn.readonly, folder: conn.group_name }, dialect, sql }),
  });
  if (verdict.verdict !== "approved") {
    const message = `Not run: this query may change data or the server's state (${why}), and the user's approval was not given — ${verdict.reason}`;
    audit(caller, conn, sql, message);
    return errorResult(message);
  }

  // The answer can come minutes later: the connection is judged as it is now, not as it was.
  const now = getConnectionById(conn.id);
  if (!now || now.ai_access === 0) {
    const message = `Not run: "${conn.name}" is no longer available to the AI.`;
    audit(caller, now ?? conn, sql, message);
    return errorResult(message);
  }
  if (now.readonly && !isReadOnlyQuery(sql, dialectFor(now.type).name)) {
    audit(caller, now, sql, READONLY_CONNECTION_MESSAGE);
    return errorResult(`Not run: "${now.name}" was made read-only while the approval waited.`);
  }

  // An UPDATE or DELETE also answers with the rows it changed, as they were before.
  let notCaptured: string | null = null;
  if (!now.readonly && isUpdateOrDelete(sql, dialectFor(now.type).name)) {
    const captured = await writeWithOldRows(now, sql, caller, read);
    if (captured.kind === "done") return captured.result;
    if (captured.kind === "failed") return queryFailedResult(now, captured.error);
    notCaptured = captured.reason;
  }

  try {
    const outcome = await runConnectionQuery({ conn: now, sql, caller, forceReadonly: !!now.readonly });
    if (!outcome.ok) return errorResult(`Not run: ${outcome.message}`);
    return queryResultJson(now, outcome.result, notCaptured ? { oldRows: null, oldRowsNote: `Old values were not captured: ${notCaptured}.` } : {});
  } catch (e) {
    return queryFailedResult(now, e);
  }
}

/** The write in one transaction with the rows it changes read first, when PPM can name them safely. */
async function writeWithOldRows(conn: ConnectionRow, sql: string, caller: AuditCaller, read?: CatalogReader): Promise<OldRowsRun> {
  const dialect = dialectFor(conn.type).name;
  const plan = planOldRows(sql, dialect);
  if (!plan.ok) return { kind: "not-read", reason: plan.reason };
  const reach = await oldRowsReachable(plan, dialect, read ?? connectionCatalogReader(conn));
  if (!reach.ok) return { kind: "not-read", reason: reach.reason };
  try {
    return await runWriteWithOldRows(conn, sql, plan.selectSql, caller);
  } catch (e) {
    // The session could not even open: nothing ran, so the write may still run on its own.
    return { kind: "not-read", reason: `the transaction to read them in could not start: ${clip((e as Error)?.message ?? String(e), 300)}` };
  }
}
