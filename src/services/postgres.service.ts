import postgres from "postgres";

export interface PgTableInfo {
  name: string;
  schema: string;
  rowCount: number;
}

export interface PgColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue: string | null;
}

export interface PgQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  changeType: "select" | "modify";
}

/** Auto-close idle connections after 5 minutes */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface CachedConn {
  sql: postgres.Sql;
  timer: ReturnType<typeof setTimeout>;
}

class PostgresService {
  private cache = new Map<string, CachedConn>();

  /** Get or create a cached connection */
  private connect(connectionString: string): postgres.Sql {
    const cached = this.cache.get(connectionString);
    if (cached) {
      clearTimeout(cached.timer);
      cached.timer = setTimeout(() => this.disconnect(connectionString), IDLE_TIMEOUT_MS);
      return cached.sql;
    }
    const sql = postgres(connectionString, { max: 3, idle_timeout: 60 });
    const timer = setTimeout(() => this.disconnect(connectionString), IDLE_TIMEOUT_MS);
    this.cache.set(connectionString, { sql, timer });
    return sql;
  }

  /** Close and remove from cache */
  private async disconnect(connectionString: string) {
    const cached = this.cache.get(connectionString);
    if (!cached) return;
    clearTimeout(cached.timer);
    try { await cached.sql.end(); } catch { /* already closed */ }
    this.cache.delete(connectionString);
  }

  /** Test connection */
  async testConnection(connectionString: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const sql = this.connect(connectionString);
      await sql`SELECT 1`;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** List all user tables with row counts */
  async getTables(connectionString: string): Promise<PgTableInfo[]> {
    const sql = this.connect(connectionString);
    const tables = await sql`
      SELECT t.schemaname as schema, t.tablename as name,
             COALESCE(s.n_live_tup, 0)::int as row_count
      FROM pg_tables t
      LEFT JOIN pg_stat_user_tables s ON t.schemaname = s.schemaname AND t.tablename = s.relname
      WHERE t.schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY t.schemaname, t.tablename
    `;
    return tables.map((t) => ({
      name: t.name as string, schema: t.schema as string, rowCount: t.row_count as number,
    }));
  }

  /** Get column schema for a table */
  async getTableSchema(connectionString: string, table: string, schema = "public"): Promise<PgColumnInfo[]> {
    const sql = this.connect(connectionString);
    const cols = await sql`
      SELECT c.column_name as name, c.data_type as type,
             c.is_nullable = 'YES' as nullable, c.column_default as default_value,
             COALESCE(tc.constraint_type = 'PRIMARY KEY', false) as pk
      FROM information_schema.columns c
      LEFT JOIN information_schema.key_column_usage kcu
        ON c.table_schema = kcu.table_schema AND c.table_name = kcu.table_name AND c.column_name = kcu.column_name
      LEFT JOIN information_schema.table_constraints tc
        ON kcu.constraint_name = tc.constraint_name AND tc.constraint_type = 'PRIMARY KEY'
      WHERE c.table_schema = ${schema} AND c.table_name = ${table}
      ORDER BY c.ordinal_position
    `;
    return cols.map((c) => ({
      name: c.name as string,
      type: c.type as string,
      nullable: c.nullable as boolean,
      pk: c.pk as boolean,
      defaultValue: c.default_value as string | null,
    }));
  }

  /** Get paginated rows from a table */
  async getTableData(
    connectionString: string, table: string, schema = "public",
    page = 1, limit = 100, orderBy?: string, orderDir: "ASC" | "DESC" = "ASC",
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[]; total: number; page: number; limit: number }> {
    const sql = this.connect(connectionString);
    const fullTable = sql(`${schema}.${table}`);

    const [countRow] = await sql`SELECT COUNT(*)::int as cnt FROM ${fullTable}`;
    const total = (countRow?.cnt as number) ?? 0;
    const offset = (page - 1) * limit;

    let rows: postgres.RowList<postgres.Row[]>;
    if (orderBy) {
      const orderCol = sql(orderBy);
      rows = orderDir === "DESC"
        ? await sql`SELECT * FROM ${fullTable} ORDER BY ${orderCol} DESC LIMIT ${limit} OFFSET ${offset}`
        : await sql`SELECT * FROM ${fullTable} ORDER BY ${orderCol} ASC LIMIT ${limit} OFFSET ${offset}`;
    } else {
      rows = await sql`SELECT * FROM ${fullTable} LIMIT ${limit} OFFSET ${offset}`;
    }

    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return { columns, rows: rows as unknown as Record<string, unknown>[], total, page, limit };
  }

  /** Execute arbitrary SQL */
  async executeQuery(connectionString: string, sqlText: string): Promise<PgQueryResult> {
    const sql = this.connect(connectionString);
    const trimmed = sqlText.trim().toUpperCase();
    const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("EXPLAIN") ||
      trimmed.startsWith("SHOW") || trimmed.startsWith("\\D");

    if (isSelect) {
      const rows = await sql.unsafe(sqlText);
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      return { columns, rows: rows as unknown as Record<string, unknown>[], rowsAffected: 0, changeType: "select" };
    }

    const result = await sql.unsafe(sqlText);
    return { columns: [], rows: [], rowsAffected: result.count ?? 0, changeType: "modify" };
  }

  /** Update a single cell value */
  async updateCell(
    connectionString: string, table: string, schema = "public",
    pkColumn: string, pkValue: unknown, column: string, value: unknown,
  ): Promise<void> {
    const sql = this.connect(connectionString);
    await sql.unsafe(
      `UPDATE "${schema}"."${table}" SET "${column}" = $1 WHERE "${pkColumn}" = $2`,
      [value as never, pkValue as never],
    );
  }

  /** Close all cached connections */
  async closeAll() {
    for (const key of this.cache.keys()) await this.disconnect(key);
  }
}

export const postgresService = new PostgresService();
