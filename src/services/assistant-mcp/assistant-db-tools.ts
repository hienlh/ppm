import type { Json } from "../mcp-http-endpoint.ts";
import { getConnectionById, getConnectionByName, getConnections, type ConnectionRow } from "../db.service.ts";
import { dialectFor } from "../database/dialects.ts";
import { runConnectionQuery } from "../database/run-connection-query.ts";
import type { AuditCaller } from "../../server/routes/query-audit-hook.ts";
import { assistantSqlSafety } from "./assistant-sql-safety.ts";
import { assistantSqlReachSafety, connectionCatalogReader, type CatalogReader } from "./assistant-sql-reach-check.ts";
import { clip, errorResult, jsonResult } from "./assistant-tool-output.ts";
import type { QueryRunResponse } from "../../shared/db-grid.ts";
import { noApprover, type AskApproval } from "./assistant-approval-broker.ts";
import { runApprovedQuery } from "./assistant-write-tools.ts";

/**
 * The Assistant's database tools. Only connections the user left "Available to the AI chat"
 * (`ai_access`) are listed or opened, nothing about how to reach one (URL, password, file
 * path) is ever returned, and every statement is audited as the agent's. A query proven to
 * read runs on the connection's read-only path whatever the connection allows; anything else
 * runs only with the user's approval, and never writes through a read-only connection.
 */

export const MAX_QUERY_ROWS = 200;
export const MAX_CELL_CHARS = 500;
const MAX_SQL_CHARS = 100_000;

type Args = Record<string, unknown>;

const available = (conn: ConnectionRow): boolean => conn.ai_access !== 0;

export function dbListConnections(): Json {
  const saved = getConnections();
  const connections = saved.filter(available).map((c) => ({
    id: c.id, name: c.name, type: c.type, ...(c.group_name ? { folder: c.group_name } : {}), readonly: !!c.readonly,
  }));
  const hidden = saved.length - connections.length;
  return jsonResult({
    connections,
    ...(hidden ? { note: `${hidden} more saved connection${hidden === 1 ? " is" : "s are"} not available to the AI.` } : {}),
  }, { key: "connections", list: connections });
}

function findConnection(ref: unknown): ConnectionRow | null {
  if (typeof ref === "number" && Number.isInteger(ref)) return getConnectionById(ref);
  if (typeof ref !== "string" || !ref.trim()) return null;
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return getConnectionById(Number(trimmed)) ?? getConnectionByName(trimmed);
  return getConnectionByName(trimmed);
}

/**
 * The saved connection `ref` names (its id or name), when the user left it available to the
 * AI; otherwise why not, worded for the agent.
 */
export function findAiConnection(ref: unknown): { ok: true; conn: ConnectionRow } | { ok: false; error: string } {
  const conn = findConnection(ref);
  if (!conn) return { ok: false, error: "No saved connection has that id or name. Call db_list_connections for the list." };
  if (!available(conn)) {
    return { ok: false, error: `Connection "${conn.name}" is not available to the AI: "Available to the AI chat" is off in its settings in PPM. Ask the user to do this themselves, or to turn that setting on.` };
  }
  return { ok: true, conn };
}

/** A cell as JSON can carry it, long values cut. */
function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return clip(value, MAX_CELL_CHARS);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes of binary data>`;
  if (typeof value === "object") {
    try {
      return clip(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), MAX_CELL_CHARS);
    } catch {
      return clip(String(value), MAX_CELL_CHARS);
    }
  }
  return value;
}

/** A query's answer as the agent gets it: rows capped and cut, or how many rows a write changed. */
export function queryResultJson(conn: ConnectionRow, result: QueryRunResponse): Json {
  if (result.changeType === "modify" && result.columns.length === 0) {
    return jsonResult({ connection: conn.name, rowsAffected: result.rowsAffected, executionTimeMs: result.executionTimeMs });
  }
  const rows = result.rows.slice(0, MAX_QUERY_ROWS).map((row) => row.map(cell));
  const cut = result.rows.length > MAX_QUERY_ROWS || !!result.truncated;
  return jsonResult({
    connection: conn.name,
    columns: result.columns.map((c) => c.name),
    rows,
    rowCount: result.rows.length,
    ...(result.changeType === "modify" ? { rowsAffected: result.rowsAffected } : {}),
    ...(cut ? { truncated: `Only the first ${rows.length} rows are shown${result.truncated ? " (the result was already cut short)" : ""}; add a LIMIT or narrow the query.` } : {}),
    executionTimeMs: result.executionTimeMs,
  }, { key: "rows", list: rows });
}

export const queryFailedResult = (conn: ConnectionRow, e: unknown): Json =>
  errorResult(`The query failed on "${conn.name}": ${clip((e as Error)?.message ?? String(e), 1_000)}`);

/**
 * `db_query`. A query proven to read — by its text, then by what the catalog says it reaches —
 * runs at once, on the read-only path whatever the connection allows. Anything else goes to
 * `runApprovedQuery`: shown to the user in full, run only once they approve. Without an asker
 * (no Assistant session to ask in) it is not run. `read` replaces the catalog read, for tests.
 */
export async function dbQuery(args: Args, caller: AuditCaller, ask?: AskApproval, read?: CatalogReader): Promise<Json> {
  const found = findAiConnection(args.connectionId);
  if (!found.ok) return errorResult(found.error);
  const { conn } = found;
  if (typeof args.sql !== "string" || !args.sql.trim()) return errorResult("`sql` is required: the query to run.");
  if (args.sql.length > MAX_SQL_CHARS) return errorResult(`\`sql\` is longer than ${MAX_SQL_CHARS} characters.`);
  const sql = args.sql;

  // Proven only when the text calls nothing off the safe list *and* nothing it reaches does.
  const dialect = dialectFor(conn.type).name;
  const called = new Set<string>();
  const text = assistantSqlSafety(sql, dialect, called);
  const safety = text.proven ? await assistantSqlReachSafety(sql, dialect, called, read ?? connectionCatalogReader(conn)) : text;
  if (!safety.proven) {
    return runApprovedQuery(conn, sql, safety.reason, caller, ask ?? noApprover);
  }

  try {
    const outcome = await runConnectionQuery({ conn, sql, caller, forceReadonly: true });
    if (!outcome.ok) return errorResult(`Not run: ${outcome.message}`);
    return queryResultJson(conn, outcome.result);
  } catch (e) {
    return queryFailedResult(conn, e);
  }
}
