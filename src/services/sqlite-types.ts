/** Shapes returned by the SQLite viewer service, shared by both of its doors. */

export interface TableInfo {
  name: string;
  rowCount: number;
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt_value: string | null;
  fk: { table: string; column: string } | null;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  changeType: "select" | "modify";
  executionTimeMs: number;
  /** True when a row cap cut the result short. */
  truncated?: boolean;
}
