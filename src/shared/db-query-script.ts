/**
 * The Query tab's runs: a script sent to `POST /connections/:id/query/script`, run statement by
 * statement on one session, and what each statement did streamed back as it finishes — one JSON
 * event per line — so Messages fills while a long script is still running and Stop can land in the
 * statement that is.
 */
import type { ResultColumn } from "./db-grid.ts";

/** The row limits a run can be given: rows each result keeps, the rest dropped and said so. */
export const QUERY_ROW_LIMITS = [100, 1_000, 10_000, 100_000] as const;
export const DEFAULT_QUERY_ROW_LIMIT = 1_000;

export interface QueryScriptRequest {
  sql: string;
  /** Picked by the browser, so Stop can name the run before anything came back from it. */
  runId: string;
  /** Rows kept per result (one of `QUERY_ROW_LIMITS`; anything else is brought within them). */
  maxRows?: number;
  /** Go on with the statements after one that failed; by default the run stops at it. */
  continueOnError?: boolean;
  /** EXPLAIN the one statement sent, without running it: no ANALYZE, which would. */
  explain?: boolean;
}

/** `POST /connections/:id/query/cancel` */
export interface QueryCancelRequest {
  runId: string;
}

export interface QueryResultSet {
  /** As the driver describes them: two columns of one name are two columns. */
  columns: ResultColumn[];
  rows: unknown[][];
  /** More rows came back than the run's limit; only that many are here. */
  truncated?: boolean;
}

export interface QueryStatementResult {
  /** 0-based place in the script. */
  index: number;
  /** 1-based lines in the text sent: the statement's first keyword, and its end. */
  startLine: number;
  endLine: number;
  /** The statement as it was sent. */
  sql: string;
  /** What the server calls it — `SELECT`, `UPDATE`, `CREATE TABLE` — when it says. */
  command?: string;
  /** Every result it answered with: none for most writes, several for a MySQL CALL. */
  resultSets: QueryResultSet[];
  /** Rows it wrote, when it is a write and the server counts them. */
  rowsAffected?: number;
  /** What the server said while it ran: Postgres notices, a RAISE NOTICE. */
  notices?: string[];
  durationMs: number;
  /** Why it failed. */
  error?: string;
  /** The line of the text sent that the error points at, when the server says where. */
  errorLine?: number;
  /** It was cut short — by Stop, or by the connection's query timeout — rather than failing by itself. */
  stopped?: "user" | "timeout";
}

/** One line of the stream. */
export type QueryScriptEvent =
  /** The script as it will run: one entry per statement, in order. */
  | { type: "start"; statements: { startLine: number; endLine: number }[] }
  /** Statement `index` was sent. */
  | { type: "running"; index: number }
  | { type: "statement"; result: QueryStatementResult }
  /** Something about the run rather than one statement of it: a transaction left open, rolled back. */
  | { type: "message"; level: "info" | "error"; text: string }
  /** The last line: `error` when the run broke off outside any statement (the connection went). */
  | { type: "done"; durationMs: number; error?: string };

export const QUERY_SCRIPT_CONTENT_TYPE = "application/x-ndjson";

/** The row limit a request asked for, brought within `QUERY_ROW_LIMITS`. */
export function queryRowLimit(asked: unknown): number {
  const max = Math.max(...QUERY_ROW_LIMITS);
  if (typeof asked !== "number" || !Number.isFinite(asked)) return DEFAULT_QUERY_ROW_LIMIT;
  return Math.min(max, Math.max(1, Math.floor(asked)));
}

/** One run in the Query tab's history: an entry of the audit log. */
export interface QueryHistoryItem {
  id: number;
  sql: string;
  status: "ok" | "error" | "blocked";
  error: string | null;
  /** Rows the run returned and wrote. */
  rowCount: number | null;
  durationMs: number | null;
  /** When it ran, ISO 8601 in UTC. */
  ranAt: string;
  /** An AI agent sent it through the API, not a person in a Query tab. */
  byAgent: boolean;
  /** The server's database it ran in, when the run named one of the others. */
  database?: string;
}

/** `GET /connections/:id/history` */
export interface QueryHistoryResponse {
  items: QueryHistoryItem[];
  /** How long the audit log keeps an entry, and how big it may grow: the history reaches no further back. */
  retentionDays: number;
  maxSizeMb: number;
}

/** History entries one request returns at most. */
export const QUERY_HISTORY_PAGE = 50;
