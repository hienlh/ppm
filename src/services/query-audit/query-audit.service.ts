import { getAuditDb } from "./query-audit-db.ts";
import { truncateResult, capBytes, MAX_RESULT_BYTES } from "./result-truncate.ts";

/** "filter" is SQL the grid's column filters build — a real query, but not one the user typed. */
export type QuerySource = "editor" | "grid" | "cli" | "filter";
export type QueryActor = "human" | "agent" | "cli";
export type QueryOperation = "select" | "insert" | "update" | "delete" | "script" | "other";
export type QueryStatus = "ok" | "error" | "blocked";

export interface QueryLogInput {
  connectionId?: number | null;
  connectionName?: string | null;
  dbType?: string | null;
  source: QuerySource;
  actor: QueryActor;
  operation: QueryOperation;
  sql: string;
  params?: unknown;
  status: QueryStatus;
  error?: string | null;
  /** Result rows to sample; only the first/last few are stored. */
  rows?: Record<string, unknown>[] | null;
  /** True row count — may exceed the sampled rows. */
  rowCount?: number | null;
  durationMs?: number | null;
  callerIp?: string | null;
  callerUa?: string | null;
}

export interface QueryLogRow {
  id: number;
  connection_id: number | null;
  connection_name: string | null;
  db_type: string | null;
  source: QuerySource;
  actor: QueryActor;
  operation: QueryOperation;
  sql: string;
  params_json: string | null;
  status: QueryStatus;
  error: string | null;
  row_count: number | null;
  duration_ms: number | null;
  bytes: number | null;
  result_head: string | null;
  result_tail: string | null;
  result_truncated: number;
  caller_ip: string | null;
  caller_ua: string | null;
  created_at: string;
}

export interface QueryLogFilter {
  connectionId?: number;
  status?: QueryStatus;
  source?: QuerySource;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Throws on failure — callers decide how to surface it without breaking the user's query. */
export function insertQueryLog(input: QueryLogInput): void {
  const sampled = truncateResult(input.rows);
  // A pasted script or a bulk action over thousands of ids can dwarf the result
  // sample, so statement text and params get the same budget.
  const sql = capBytes(input.sql, MAX_RESULT_BYTES).text;
  const params = input.params === undefined
    ? null
    : capBytes(JSON.stringify(input.params) ?? "null", MAX_RESULT_BYTES).text;

  getAuditDb()
    .query(
      `INSERT INTO query_log (
        connection_id, connection_name, db_type, source, actor, operation,
        sql, params_json, status, error, row_count, duration_ms, bytes,
        result_head, result_tail, result_truncated, caller_ip, caller_ua
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.connectionId ?? null,
      input.connectionName ?? null,
      input.dbType ?? null,
      input.source,
      input.actor,
      input.operation,
      sql,
      params,
      input.status,
      input.error ?? null,
      input.rowCount ?? null,
      input.durationMs ?? null,
      sampled.bytes,
      sampled.head,
      sampled.tail,
      sampled.truncated ? 1 : 0,
      input.callerIp ?? null,
      input.callerUa ?? null,
    );
}

function buildWhere(filter: QueryLogFilter): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.connectionId != null) { conditions.push("connection_id = ?"); params.push(filter.connectionId); }
  if (filter.status) { conditions.push("status = ?"); params.push(filter.status); }
  if (filter.source) { conditions.push("source = ?"); params.push(filter.source); }
  if (filter.from) { conditions.push("created_at >= ?"); params.push(filter.from); }
  if (filter.to) { conditions.push("created_at <= ?"); params.push(filter.to); }
  if (filter.search) { conditions.push("sql LIKE ?"); params.push(`%${filter.search}%`); }

  return { clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

export function listQueryLogs(filter: QueryLogFilter = {}): QueryLogRow[] {
  const { clause, params } = buildWhere(filter);
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  return getAuditDb()
    .query(`SELECT * FROM query_log ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...(params as never[]), limit, offset) as QueryLogRow[];
}

export function countQueryLogs(filter: QueryLogFilter = {}): number {
  const { clause, params } = buildWhere(filter);
  const row = getAuditDb()
    .query(`SELECT COUNT(*) as count FROM query_log ${clause}`)
    .get(...(params as never[])) as { count: number };
  return row.count;
}

export function getQueryLog(id: number): QueryLogRow | null {
  return (getAuditDb().query("SELECT * FROM query_log WHERE id = ?").get(id) as QueryLogRow) ?? null;
}

const OPERATION_BY_KEYWORD: Record<string, QueryOperation> = {
  select: "select", with: "select", show: "select", explain: "select", pragma: "select",
  insert: "insert", update: "update", delete: "delete",
};

/** Classify a statement by its leading keyword so history can be filtered by intent. */
export function detectOperation(sql: string): QueryOperation {
  const keyword = sql.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return OPERATION_BY_KEYWORD[keyword] ?? "other";
}
