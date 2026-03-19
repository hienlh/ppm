export type DbType = "sqlite" | "postgres";

export interface DbConnectionConfig {
  type: DbType;
  path?: string;             // sqlite
  connectionString?: string; // postgres
  [key: string]: unknown;
}

export interface DbTableInfo {
  name: string;
  schema: string; // "main" for sqlite, actual schema for postgres
  rowCount: number;
}

export interface DbColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue: string | null;
}

export interface DbQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  changeType: "select" | "modify";
}

export interface DbPagedData {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  limit: number;
}

export interface DatabaseAdapter {
  testConnection(config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }>;
  getTables(config: DbConnectionConfig): Promise<DbTableInfo[]>;
  getTableSchema(config: DbConnectionConfig, table: string, schema?: string): Promise<DbColumnInfo[]>;
  getTableData(config: DbConnectionConfig, table: string, opts: {
    schema?: string; page?: number; limit?: number; orderBy?: string; orderDir?: "ASC" | "DESC";
  }): Promise<DbPagedData>;
  executeQuery(config: DbConnectionConfig, sql: string): Promise<DbQueryResult>;
  updateCell(config: DbConnectionConfig, table: string, opts: {
    schema?: string; pkColumn: string; pkValue: unknown; column: string; value: unknown;
  }): Promise<void>;
}
