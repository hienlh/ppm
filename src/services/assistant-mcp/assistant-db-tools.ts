import type { Json } from "../mcp-http-endpoint.ts";
import { getConnectionById, getConnectionByName, getConnections, type ConnectionRow } from "../db.service.ts";
import { dialectFor } from "../database/dialects.ts";
import { runConnectionQuery } from "../database/run-connection-query.ts";
import { detectOperation } from "../query-audit/query-audit.service.ts";
import { logQueryAs, type AuditCaller } from "../../server/routes/query-audit-hook.ts";
import { connAudit } from "../../server/routes/database-route-helpers.ts";
import { assistantSqlSafety } from "./assistant-sql-safety.ts";
import { clip, errorResult, jsonResult } from "./assistant-tool-output.ts";

/**
 * The Assistant's database tools. Only connections the user left "Available to the AI chat"
 * (`ai_access`) are listed or opened, nothing about how to reach one (URL, password, file
 * path) is ever returned, and a query runs only when it is proven to read — on the connection's
 * read-only path whatever the connection allows, audited as the agent's.
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

export async function dbQuery(args: Args, caller: AuditCaller): Promise<Json> {
  const found = findAiConnection(args.connectionId);
  if (!found.ok) return errorResult(found.error);
  const { conn } = found;
  if (typeof args.sql !== "string" || !args.sql.trim()) return errorResult("`sql` is required: the query to run.");
  if (args.sql.length > MAX_SQL_CHARS) return errorResult(`\`sql\` is longer than ${MAX_SQL_CHARS} characters.`);
  const sql = args.sql;

  const safety = assistantSqlSafety(sql, dialectFor(conn.type).name);
  if (!safety.proven) {
    const message = `Not run: this query may change data or the server's state — ${safety.reason}. Running it needs the user's approval; `
      + "this tool runs only queries proven to read. Rewrite it as a plain read, or ask the user to run it themselves.";
    logQueryAs(caller, {
      ...connAudit(conn), source: "editor", operation: detectOperation(sql), sql, status: "blocked", error: message, durationMs: 0,
    });
    return errorResult(message);
  }

  try {
    const outcome = await runConnectionQuery({ conn, sql, caller, forceReadonly: true });
    if (!outcome.ok) return errorResult(`Not run: ${outcome.message}`);
    const { result } = outcome;
    const rows = result.rows.slice(0, MAX_QUERY_ROWS).map((row) => row.map(cell));
    const cut = result.rows.length > MAX_QUERY_ROWS || !!result.truncated;
    return jsonResult({
      connection: conn.name,
      columns: result.columns.map((c) => c.name),
      rows,
      rowCount: result.rows.length,
      ...(cut ? { truncated: `Only the first ${rows.length} rows are shown${result.truncated ? " (the result was already cut short)" : ""}; add a LIMIT or narrow the query.` } : {}),
      executionTimeMs: result.executionTimeMs,
    }, { key: "rows", list: rows });
  } catch (e) {
    return errorResult(`The query failed on "${conn.name}": ${clip((e as Error).message ?? String(e), 1_000)}`);
  }
}
