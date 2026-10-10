import type { ConnectionRow } from "../db.service.ts";
import { getAdapter } from "./adapter-registry.ts";
import { isReadOnlyQuery } from "./readonly-check.ts";
import { isReadonlyRefusal, readonlyRefusalMessage } from "./db-errors.ts";
import { dialectFor } from "./dialects.ts";
import { detectOperation } from "../query-audit/query-audit.service.ts";
import { rowsToRecords, type QueryRunResponse } from "../../shared/db-grid.ts";
import { connAudit, connConfig } from "../../server/routes/database-route-helpers.ts";
import { logQueryAs, type AuditCaller, type AuditFields } from "../../server/routes/query-audit-hook.ts";

/**
 * Run one query on a saved connection (or a database file) and audit it, the way
 * `POST /connections/:id/query` does; the PPM Assistant's `db_query` runs through here too.
 *
 * A readonly connection — or a call that forces one — is served by pools and file handles on
 * which the database itself refuses writes, and a statement that is not a plain read is refused
 * before it is sent. Refusals come back as a 403 outcome; any other failure is audited and thrown.
 */

export type RunConnectionQueryOutcome =
  | { ok: true; result: QueryRunResponse }
  | { ok: false; status: 403; message: string };

export interface RunConnectionQueryInput {
  conn: ConnectionRow;
  sql: string;
  caller: AuditCaller;
  /** One of the server's other databases, from a request's `?database=`. */
  database?: string;
  /** "filter" when the grid built the SQL from column filters rather than a person typing it. */
  source?: "editor" | "filter";
  /** Run on the read-only path even when the connection is writable. */
  forceReadonly?: boolean;
  /**
   * Stop the statement after this long, or when this signal aborts (see `RunQueryOptions` for
   * what each database can do); a stopped run is audited as an error and thrown.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called when the statement ran (or was refused) but its audit entry could not be written. */
  onAuditError?: (message: string) => void;
}

export const READONLY_CONNECTION_MESSAGE = "Connection is readonly — only SELECT queries allowed. Change this in PPM web UI.";
export const READ_ONLY_RUN_MESSAGE = "Only a plain read runs here — this statement may change data.";

export async function runConnectionQuery(input: RunConnectionQueryInput): Promise<RunConnectionQueryOutcome> {
  const { conn, sql, caller, database } = input;
  const startedAt = Date.now();
  const audit = {
    ...connAudit(conn),
    source: input.source ?? ("editor" as const),
    operation: detectOperation(sql),
    sql,
    ...(database !== undefined ? { params: { database } } : {}),
  };
  const log = (fields: Pick<AuditFields, "status"> & Partial<Pick<AuditFields, "error" | "rows" | "rowCount">>) => {
    const failed = logQueryAs(caller, { ...audit, ...fields, durationMs: Date.now() - startedAt });
    if (failed !== null) input.onAuditError?.(failed);
  };

  const readonly = !!conn.readonly || !!input.forceReadonly;
  if (readonly && !isReadOnlyQuery(sql, dialectFor(conn.type).name)) {
    const message = conn.readonly ? READONLY_CONNECTION_MESSAGE : READ_ONLY_RUN_MESSAGE;
    log({ status: "blocked", error: message });
    return { ok: false, status: 403, message };
  }

  const config = connConfig(conn, database);
  const adapter = getAdapter(conn.type);
  try {
    const stopOn = input.timeoutMs !== undefined || input.signal ? { timeoutMs: input.timeoutMs, signal: input.signal } : undefined;
    const result = await adapter.runQuery(input.forceReadonly ? { ...config, readonly: true } : config, sql, stopOn);
    log({
      status: "ok",
      rows: rowsToRecords(result.columns, result.rows).records,
      rowCount: result.changeType === "select" ? result.rows.length : result.rowsAffected,
    });
    return { ok: true, result };
  } catch (e) {
    // A read that writes (`SELECT nextval('s')`, a function that deletes)
    // passes the first check and is refused by the database itself.
    if (isReadonlyRefusal(e)) {
      const message = readonlyRefusalMessage(e);
      log({ status: "blocked", error: message });
      return { ok: false, status: 403, message };
    }
    log({ status: "error", error: (e as Error).message });
    throw e;
  }
}
