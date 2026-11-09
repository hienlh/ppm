/**
 * The Query tab's runs (see `db-query-script.ts`).
 *
 * - `POST /connections/:id/query/script` runs a script on one session of its own and streams what
 *   each statement did, one JSON event per line, as the statement ends. What is wrong before
 *   anything runs — no such connection, a write on a readonly one, a run id already in use, a
 *   connection that cannot be opened — is answered as JSON with its status instead.
 * - `POST /connections/:id/query/cancel` stops a run by the id the browser gave it.
 * - `GET /connections/:id/history` lists the runs the audit log still holds, newest first.
 *
 * The older `POST /connections/:id/query` stays as it was: the editor's autocomplete, the tree's
 * menus and agents call it.
 */
import { Hono } from "hono";
import { configService } from "../../services/config.service.ts";
import type { ConnectionRow } from "../../services/db.service.ts";
import { getAdapter } from "../../services/database/adapter-registry.ts";
import { dialectFor } from "../../services/database/dialects.ts";
import { isFileConnection } from "../../services/database/file-database.ts";
import { QueryScriptRun } from "../../services/database/query-script-runner.ts";
import { isReadOnlyQuery } from "../../services/database/readonly-check.ts";
import { detectOperation, listQueryLogs, type QueryLogRow, type QueryOperation } from "../../services/query-audit/query-audit.service.ts";
import { rowsToRecords } from "../../shared/db-grid.ts";
import {
  QUERY_HISTORY_PAGE, QUERY_SCRIPT_CONTENT_TYPE, queryRowLimit, WRONG_PASSWORD, type QueryCancelRequest, type QueryHistoryItem, type QueryHistoryResponse,
  type QueryScriptEvent, type QueryScriptRequest,
} from "../../shared/db-query-script.ts";
import { splitSqlScript, sqlCode } from "../../shared/split-sql-statements.ts";
import type { DbQuerySession } from "../../types/database.ts";
import { ok, err } from "../../types/api.ts";
import { auditCaller, logQuery, logQueryAs } from "./query-audit-hook.ts";
import { checkPpmPassword } from "../../services/ppm-password.ts";
import { connAudit, connConfig, databaseParam, holdRequestOpen, requestDatabase, resolveTargetConn } from "./database-route-helpers.ts";

export const databaseQueryRoutes = new Hono();

/** What the readonly check answers, as `/query` words it. */
const READONLY_MESSAGE = "Connection is readonly — only SELECT queries allowed. Change this in PPM web UI.";

/** A run id the browser picked: a UUID, or anything as plain. */
const RUN_ID = /^[\w-]{1,100}$/;

/** Runs in progress, by connection and the id the browser gave the run. */
const runs = new Map<string, QueryScriptRun>();

function runKey(conn: ConnectionRow, runId: string): string {
  return `${isFileConnection(conn) ? `file:${conn.file.path}` : conn.id}\n${runId}`;
}

/** The connection's query timeout (Advanced tab), in ms; none when it is not set. */
function queryTimeoutMs(config: Record<string, unknown>): number | undefined {
  const seconds = config.queryTimeoutSec;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** POST /connections/:id/query/script — body: `QueryScriptRequest`; answers NDJSON `QueryScriptEvent`s. */
databaseQueryRoutes.post("/:id/query/script", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const body = await c.req.json<Partial<QueryScriptRequest>>().catch(() => null);
  if (!body || typeof body.sql !== "string" || !body.sql.trim()) return c.json(err("sql is required"), 400);
  if (typeof body.runId !== "string" || !RUN_ID.test(body.runId)) return c.json(err("runId is required: letters, digits, - and _"), 400);
  const { sql, runId } = body;
  const explain = body.explain === true;
  const dialect = dialectFor(conn.type).name;
  const statements = splitSqlScript(sql, dialect);
  if (statements.length === 0) return c.json(err("The script has no statements to run"), 400);

  const operation: QueryOperation = statements.length > 1 ? "script" : detectOperation(sqlCode(statements[0]!.sql, dialect).trim());
  // "Run with write access (once)": a readonly connection's run made writable, PPM's password typed again.
  const writeOnce = !!body.writeOnce && !!conn.readonly && !isFileConnection(conn);
  const params = { ...databaseParam(c), ...(explain ? { explain: true } : {}), ...(writeOnce ? { writeOnce: true } : {}) };
  const audit = {
    ...connAudit(conn), source: "editor" as const, operation, sql,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
  if (writeOnce) {
    if (!checkPpmPassword(body.writeOnce?.password)) {
      logQuery(c, { ...audit, status: "blocked", error: WRONG_PASSWORD, durationMs: Date.now() - startedAt });
      return c.json(err(WRONG_PASSWORD), 403);
    }
  } else if (conn.readonly && !isReadOnlyQuery(sql, dialect)) {
    logQuery(c, { ...audit, status: "blocked", error: READONLY_MESSAGE, durationMs: Date.now() - startedAt });
    return c.json(err(READONLY_MESSAGE), 403);
  }

  const key = runKey(conn, runId);
  if (runs.has(key)) return c.json(err("A run with this id is already in progress"), 409);
  const config = writeOnce ? { ...connConfig(conn, requestDatabase(c)), readonly: false } : connConfig(conn, requestDatabase(c));
  const run = new QueryScriptRun({
    sql, dialect, explain, maxRows: queryRowLimit(body.maxRows), continueOnError: body.continueOnError === true, timeoutMs: queryTimeoutMs(config),
  });
  // Registered before the session opens, so a Stop pressed while it connects is not lost.
  runs.set(key, run);
  let session: DbQuerySession;
  try {
    session = await getAdapter(conn.type).openQuerySession(config);
  } catch (e) {
    runs.delete(key);
    const message = (e as Error).message;
    logQuery(c, { ...audit, status: "error", error: message, durationMs: Date.now() - startedAt });
    const status = (e as { status?: number }).status === 400 ? 400 : 500;
    return c.json(err(message), status);
  }

  // A run sends nothing while a statement runs, for as long as it runs.
  holdRequestOpen(c, 0);
  const caller = auditCaller(c);
  const encoder = new TextEncoder();
  let gone = false;
  // The browser closed the tab or lost its connection: nobody is left to read the rest.
  c.req.raw.signal.addEventListener("abort", () => run.stop(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: QueryScriptEvent) => {
        if (gone) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          gone = true;
        }
      };
      void run.execute(session, emit).then((summary) => {
        runs.delete(key);
        const last = summary.lastResult;
        logQueryAs(caller, {
          ...audit,
          status: summary.status,
          ...(summary.error !== undefined ? { error: summary.error } : {}),
          ...(last ? { rows: rowsToRecords(last.columns, last.rows).records } : {}),
          rowCount: summary.rowCount,
          durationMs: Date.now() - startedAt,
        });
        if (!gone) controller.close();
      });
    },
    cancel() {
      gone = true;
      run.stop();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": QUERY_SCRIPT_CONTENT_TYPE, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
});

/** POST /connections/:id/query/cancel — body: `QueryCancelRequest`. A run that has ended already is no error. */
databaseQueryRoutes.post("/:id/query/cancel", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const body = await c.req.json<Partial<QueryCancelRequest>>().catch(() => null);
  if (typeof body?.runId !== "string" || !RUN_ID.test(body.runId)) return c.json(err("runId is required"), 400);
  const run = runs.get(runKey(conn, body.runId));
  run?.stop();
  return c.json(ok({ stopped: !!run }));
});

/** An audit entry as the history shows it. */
function historyItem(row: QueryLogRow): QueryHistoryItem {
  let database: unknown;
  try {
    database = (JSON.parse(row.params_json ?? "null") as { database?: unknown } | null)?.database;
  } catch { /* params that are not JSON say nothing about a database */ }
  return {
    id: row.id,
    sql: row.sql,
    status: row.status,
    error: row.error,
    rowCount: row.row_count,
    durationMs: row.duration_ms,
    // SQLite's datetime('now'): UTC, without saying so.
    ranAt: `${row.created_at.replace(" ", "T")}Z`,
    byAgent: row.actor === "agent",
    ...(typeof database === "string" ? { database } : {}),
  };
}

/** GET /connections/:id/history?search=&offset= — what the Query tab ran here, newest first. */
databaseQueryRoutes.get("/:id/history", (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const offset = Math.max(0, Math.floor(Number(c.req.query("offset") ?? 0)) || 0);
  const search = c.req.query("search")?.trim() || undefined;
  const rows = listQueryLogs({
    ...(isFileConnection(conn) ? { fileConnection: conn.file.path } : { connectionId: conn.id }),
    // What an AI chat ran through PPM's database tools too, marked as an agent's.
    source: ["editor", "ai"],
    search,
    limit: QUERY_HISTORY_PAGE,
    offset,
  });
  const { retention_days, max_size_mb } = configService.get("query_audit");
  return c.json(ok<QueryHistoryResponse>({ items: rows.map(historyItem), retentionDays: retention_days, maxSizeMb: max_size_mb }));
});
