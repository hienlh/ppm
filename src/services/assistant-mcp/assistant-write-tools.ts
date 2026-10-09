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
import { errorResult } from "./assistant-tool-output.ts";

/**
 * The Assistant's database writes: SQL that PPM could not prove only reads. It runs only after
 * the user approved the card showing it in full, and then exactly as the connection allows —
 * through the same `runConnectionQuery` the editor uses, audited as the agent's:
 *  - a read-only connection never runs a write: anything but a plain read is refused before
 *    the user is even asked, and an approved read still goes down the read-only path;
 *  - a connection the user took away from the AI, or made read-only, while the card waited is
 *    checked again after the answer, and nothing runs on it.
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

  try {
    const outcome = await runConnectionQuery({ conn: now, sql, caller, forceReadonly: !!now.readonly });
    if (!outcome.ok) return errorResult(`Not run: ${outcome.message}`);
    return queryResultJson(now, outcome.result);
  } catch (e) {
    return queryFailedResult(now, e);
  }
}
