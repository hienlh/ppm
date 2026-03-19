import type { DatabaseAdapter, DbConnectionConfig, DbTableInfo, DbColumnInfo, DbPagedData, DbQueryResult } from "../../types/database.ts";
import { sqliteService } from "../sqlite.service.ts";
import { existsSync } from "node:fs";

/** Thin adapter wrapping the existing SqliteService to implement DatabaseAdapter */
export const sqliteAdapter: DatabaseAdapter = {
  async testConnection(config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!config.path) return { ok: false, error: "Missing path" };
      if (!existsSync(config.path)) return { ok: false, error: `File not found: ${config.path}` };
      // Attempt to open and list tables
      sqliteService.getTables(config.path, config.path);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async getTables(config: DbConnectionConfig): Promise<DbTableInfo[]> {
    if (!config.path) throw new Error("Missing path");
    const tables = sqliteService.getTables(config.path, config.path);
    return tables.map((t) => ({ name: t.name, schema: "main", rowCount: t.rowCount }));
  },

  async getTableSchema(config: DbConnectionConfig, table: string): Promise<DbColumnInfo[]> {
    if (!config.path) throw new Error("Missing path");
    const cols = sqliteService.getTableSchema(config.path, config.path, table);
    return cols.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: !c.notnull,
      pk: !!c.pk,
      defaultValue: c.dflt_value,
    }));
  },

  async getTableData(config: DbConnectionConfig, table: string, opts): Promise<DbPagedData> {
    if (!config.path) throw new Error("Missing path");
    return sqliteService.getTableData(
      config.path, config.path, table,
      opts.page, opts.limit, opts.orderBy, opts.orderDir,
    );
  },

  async executeQuery(config: DbConnectionConfig, sql: string): Promise<DbQueryResult> {
    if (!config.path) throw new Error("Missing path");
    return sqliteService.executeQuery(config.path, config.path, sql);
  },

  async updateCell(config: DbConnectionConfig, table: string, opts): Promise<void> {
    if (!config.path) throw new Error("Missing path");
    // SQLite uses rowid as PK for cell updates
    sqliteService.updateCell(config.path, config.path, table, Number(opts.pkValue), opts.column, opts.value);
  },
};
