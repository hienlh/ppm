import type { ConnectionRow } from "../db.service.ts";
import { getAdapter } from "../database/adapter-registry.ts";
import { isReadOnlyQuery } from "../database/readonly-check.ts";
import { detectOperation, insertQueryLog, type QueryLogInput, type QueryOperation } from "../query-audit/query-audit.service.ts";
import { createMcpHttpHandler, textResult, type Json } from "../mcp-http-endpoint.ts";
import { tabOpenBroker, type TabOpenOutcome } from "../tab-tools-mcp/tab-open-broker.ts";
import { rowsToRecords } from "../../shared/db-grid.ts";
import { dialectNameOf, type DialectName } from "../../shared/db-types.ts";
import { splitSqlScript, sqlCode } from "../../shared/split-sql-statements.ts";
import { neutralizeFences } from "../../shared/untrusted-text.ts";
import { isPpmTool, ppmToolOffMessage, ppmToolOn } from "../../shared/ppm-tools.ts";
import {
  DB_QUERY_TOOL, MAX_DB_TOOL_REASON_CHARS, MAX_DB_TOOL_SQL_CHARS, OPEN_QUERY_TOOL, type DbExecuteApprovalInput,
} from "../../shared/db-ai-tools.ts";
import type { TabOpenAsk } from "../../shared/tab-open-protocol.ts";
import type { DbQuerySession } from "../../types/database.ts";
import { configService } from "../config.service.ts";
import { describeAiConnections, findAiConnection } from "./db-ai-connections.ts";
import { aiDatabaseArg, aiTargetConfig } from "./db-ai-target.ts";
import { formatStatementResults } from "./db-ai-format.ts";
import { runAiQuery, runApprovedScript, transactionControlIn } from "./db-ai-run.ts";
import { dbApprovalBroker, type DbApprovalOutcome } from "./db-approval-broker.ts";
import {
  DB_EXECUTE_RESULT_ROWS, DB_EXECUTE_STATEMENT_TIMEOUT_MS, DB_QUERY_DEFAULT_ROWS, DB_QUERY_MAX_ROWS, DB_QUERY_TIMEOUT_MS,
  OPEN_QUERY_WAIT_MS, dbChangeHint, dbToolDefinitions,
} from "./db-ai-tools-tool.ts";
import { dbToolsMcpTokens, type DbToolsTokenBinding } from "./db-ai-tools-tokens.ts";

/**
 * `/api/db-tools-mcp` — serves `db_query`, `open_query` and `db_execute` to one chat session's
 * own agent (the MCP plumbing is `mcp-http-endpoint.ts`). Its token reaches the connections the
 * AI chat may use (`db-ai-connections.ts`) and nothing else: reads run inside a read-only
 * transaction, and a write runs only once the user approved it in that session's chat, with
 * PPM's password, exactly as shown. Every statement is in the query audit log as `source: ai`.
 */

type Approve = (sessionId: string, input: Omit<DbExecuteApprovalInput, "passwordRequired">, signal: AbortSignal) => Promise<DbApprovalOutcome>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The connection's own query timeout (Advanced tab) when it is shorter than the tool's, else the tool's. */
function timeoutFor(config: object, toolMs: number): number {
  const seconds = (config as { queryTimeoutSec?: unknown }).queryTimeoutSec;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, toolMs) : toolMs;
}

function operationOf(sql: string, dialect: DialectName): QueryOperation {
  const statements = splitSqlScript(sql, dialect);
  return statements.length > 1 ? "script" : detectOperation(sqlCode(statements[0]?.sql ?? sql, dialect).trim());
}

export function createDbToolsMcpHandler(deps: {
  resolveToken: (token: string | null) => DbToolsTokenBinding | null;
  openTab: (sessionId: string, req: TabOpenAsk, waitMs: number) => Promise<TabOpenOutcome>;
  approve: Approve;
  /** Whether the user has this tool on (Settings → Tools). */
  enabled: (tool: string) => boolean;
  openSession?: (conn: ConnectionRow, config: Awaited<ReturnType<typeof aiTargetConfig>>) => Promise<DbQuerySession>;
}) {
  const openSession = deps.openSession ?? ((conn, config) => getAdapter(conn.type).openQuerySession(config));

  function audit(conn: ConnectionRow, fields: Omit<QueryLogInput, "connectionId" | "connectionName" | "dbType" | "source" | "actor" | "callerIp" | "callerUa">): void {
    try {
      insertQueryLog({
        connectionId: conn.id, connectionName: conn.name, dbType: conn.type, source: "ai", actor: "agent",
        callerIp: null, callerUa: "ppm-db-tools", ...fields,
      });
    } catch (e) {
      console.error("[query-audit] failed to log an AI tool's query:", errorText(e));
    }
  }

  async function dbQuery(conn: ConnectionRow, database: string | undefined, sql: string, args: Json): Promise<Json> {
    const dialect = dialectNameOf(conn.type);
    let maxRows = DB_QUERY_DEFAULT_ROWS;
    if (args.max_rows !== undefined && args.max_rows !== null) {
      if (typeof args.max_rows !== "number" || !Number.isInteger(args.max_rows) || args.max_rows < 1 || args.max_rows > DB_QUERY_MAX_ROWS) {
        return textResult(`\`max_rows\` must be a whole number from 1 to ${DB_QUERY_MAX_ROWS}.`, true);
      }
      maxRows = args.max_rows;
    }
    const startedAt = Date.now();
    const base = { operation: operationOf(sql, dialect), sql, ...(database ? { params: { database } } : {}) };
    if (!isReadOnlyQuery(sql, dialect)) {
      const message = `db_query only reads, and this SQL writes (or may). ${dbChangeHint(deps.enabled)}`;
      audit(conn, { ...base, status: "blocked", error: message, durationMs: 0 });
      return textResult(message, true);
    }
    let session: DbQuerySession;
    let timeoutMs: number;
    try {
      const config = await aiTargetConfig(conn, database, true);
      timeoutMs = timeoutFor(config, DB_QUERY_TIMEOUT_MS);
      session = await openSession(conn, config);
    } catch (e) {
      audit(conn, { ...base, status: "error", error: errorText(e), durationMs: Date.now() - startedAt });
      return textResult(`Could not open ${conn.name}: ${errorText(e)}`, true);
    }
    const run = await runAiQuery(session, { sql, dialect, maxRows, timeoutMs });
    const last = run.summary.lastResult;
    audit(conn, {
      ...base, status: run.summary.status, ...(run.summary.error !== undefined ? { error: run.summary.error } : {}),
      ...(last ? { rows: rowsToRecords(last.columns, last.rows).records } : {}),
      rowCount: run.summary.rowCount, durationMs: Date.now() - startedAt,
    });
    const statements = splitSqlScript(sql, dialect).length;
    const parts = [formatStatementResults(run.results, statements, maxRows), ...run.messages.map((m) => neutralizeFences(m))];
    if (run.summary.status === "blocked") parts.push(`The database refused a write: db_query only reads. ${dbChangeHint(deps.enabled)}`);
    return textResult(parts.filter(Boolean).join("\n\n"), run.summary.status !== "ok");
  }

  async function openQuery(sessionId: string, conn: ConnectionRow, database: string | undefined, sql: string): Promise<Json> {
    const outcome = await deps.openTab(sessionId, {
      tool: OPEN_QUERY_TOOL,
      query: {
        connectionId: conn.id, connectionName: conn.name, dbType: conn.type, connectionColor: conn.color,
        ...(database ? { database } : {}), sql,
      },
    }, OPEN_QUERY_WAIT_MS);
    const where = `${conn.name}${database ? ` (database ${database})` : ""}`;
    if (!outcome.ok) {
      if (outcome.reason === "no-device") return textResult(`${outcome.message} Give the user the SQL to run in a Query tab on ${where} themselves.`, true);
      return textResult(outcome.message, true);
    }
    if (!outcome.result.opened) {
      const why = outcome.result.error ? neutralizeFences(outcome.result.error.replace(/[\u0000-\u001f\u007f]/g, " ")) : "it gave no reason";
      return textResult(`The user's device could not open the Query tab: ${why}`, true);
    }
    return textResult(`Opened a Query tab on ${where} on the user's device, holding the SQL. Nothing ran: the user runs it from the tab.`);
  }

  async function dbExecute(sessionId: string, conn: ConnectionRow, database: string | undefined, sql: string, args: Json, signal: AbortSignal): Promise<Json> {
    const dialect = dialectNameOf(conn.type);
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!reason) return textResult("`reason` is required: what the change does and why, for the user to read before approving.", true);
    if (reason.length > MAX_DB_TOOL_REASON_CHARS) return textResult(`\`reason\` is longer than ${MAX_DB_TOOL_REASON_CHARS} characters; say it in a sentence or two.`, true);
    let expectedRows: number | undefined;
    if (args.expected_rows !== undefined && args.expected_rows !== null) {
      if (typeof args.expected_rows !== "number" || !Number.isInteger(args.expected_rows) || args.expected_rows < 0) {
        return textResult("`expected_rows` must be a whole number from 0.", true);
      }
      expectedRows = args.expected_rows;
    }
    const control = transactionControlIn(sql, dialect);
    if (control) {
      return textResult(`Take \`${control}\` out of the script: PPM runs the whole script in one transaction it opens and ends itself.`, true);
    }
    // Checked before the user is asked: approving something that cannot be opened wastes their time.
    try {
      await aiTargetConfig(conn, database, false);
    } catch (e) {
      return textResult(`Could not open ${conn.name}: ${errorText(e)}`, true);
    }

    const operation = operationOf(sql, dialect);
    const base = { operation, sql, params: { ...(database ? { database } : {}), reason, ...(expectedRows !== undefined ? { expectedRows } : {}) } };
    const answer = await deps.approve(sessionId, {
      connectionId: conn.id, connectionName: conn.name, dbType: conn.type, group: conn.group_name, color: conn.color,
      readonly: !!conn.readonly, ...(database ? { database } : {}), sql, reason, ...(expectedRows !== undefined ? { expectedRows } : {}),
    }, signal);
    if (!answer.approved) {
      if (answer.reason === "declined" || answer.reason === "timeout") {
        audit(conn, { ...base, status: "blocked", error: answer.message, durationMs: 0 });
      }
      return textResult(answer.message, true);
    }

    const startedAt = Date.now();
    let session: DbQuerySession;
    let timeoutMs: number;
    try {
      const config = await aiTargetConfig(conn, database, false);
      timeoutMs = timeoutFor(config, DB_EXECUTE_STATEMENT_TIMEOUT_MS);
      session = await openSession(conn, config);
    } catch (e) {
      audit(conn, { ...base, params: { ...base.params, approved: true }, status: "error", error: errorText(e), durationMs: Date.now() - startedAt });
      return textResult(`The user approved, but ${conn.name} could not be opened, so nothing ran: ${errorText(e)}`, true);
    }
    const report = await runApprovedScript(session, { sql, dialect, maxRows: DB_EXECUTE_RESULT_ROWS, expectedRows, timeoutMs });
    const statements = splitSqlScript(sql, dialect).length;
    audit(conn, {
      ...base, params: { ...base.params, approved: true, committed: report.committed },
      status: report.committed ? "ok" : "error", ...(report.committed ? {} : { error: report.reason }),
      rowCount: report.rowsChanged, durationMs: Date.now() - startedAt,
    });
    const detail = formatStatementResults(report.results, statements, DB_EXECUTE_RESULT_ROWS);
    if (!report.committed) return textResult(`The user approved the change, but it was not kept. ${report.reason}\n\n${detail}`.trim(), true);
    const changed = `${report.rowsChanged} ${report.rowsChanged === 1 ? "row" : "rows"} changed in all`;
    return textResult(`The user approved the change. It ran on ${conn.name}${database ? ` (database ${database})` : ""} in one transaction and was committed: ${changed}.\n\n${detail}`);
  }

  return createMcpHttpHandler<DbToolsTokenBinding>({
    serverName: "ppm-db",
    tokenRequired: "A chat session token is required",
    resolveToken: deps.resolveToken,
    tools: () => dbToolDefinitions(describeAiConnections(), deps.enabled),
    unavailable: (name) => (deps.enabled(name) ? null : ppmToolOffMessage(name)),
    callTool: async ({ sessionId }, name, rawArgs, signal) => {
      const args = isObj(rawArgs) ? rawArgs : {};
      const found = findAiConnection(args.connection);
      if (!found.ok) return textResult(found.error, true);
      const conn = found.conn;
      const target = aiDatabaseArg(conn, args.database);
      if (!target.ok) return textResult(target.error, true);
      const sql = typeof args.sql === "string" ? args.sql : "";
      if (!sql.trim()) return textResult("`sql` is required.", true);
      if (sql.length > MAX_DB_TOOL_SQL_CHARS) return textResult(`\`sql\` is longer than ${MAX_DB_TOOL_SQL_CHARS} characters; split it into smaller scripts.`, true);
      if (splitSqlScript(sql, dialectNameOf(conn.type)).length === 0) return textResult("The SQL has no statements to run: only comments or semicolons.", true);
      if (name === DB_QUERY_TOOL) return dbQuery(conn, target.database, sql, args);
      if (name === OPEN_QUERY_TOOL) return openQuery(sessionId, conn, target.database, sql);
      return dbExecute(sessionId, conn, target.database, sql, args, signal);
    },
  });
}

export const dbToolsMcpHandler = createDbToolsMcpHandler({
  resolveToken: (token) => dbToolsMcpTokens.resolve(token),
  openTab: (sessionId, req, waitMs) => tabOpenBroker.request(sessionId, req, waitMs),
  approve: (sessionId, input, signal) => dbApprovalBroker.request(sessionId, input, undefined, signal),
  enabled: (tool) => isPpmTool(tool) && ppmToolOn(configService.get("ai"), tool),
});
