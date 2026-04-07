import type { DatabaseAdapter, DbConnectionConfig, DbTableInfo, DbColumnInfo, DbPagedData, DbQueryResult } from "../../types/database.ts";
import { postgresService } from "../postgres.service.ts";

/** Thin adapter wrapping the existing PostgresService to implement DatabaseAdapter */
export const postgresAdapter: DatabaseAdapter = {
  async testConnection(config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }> {
    if (!config.connectionString) return { ok: false, error: "Missing connectionString" };
    return postgresService.testConnection(config.connectionString);
  },

  async getTables(config: DbConnectionConfig): Promise<DbTableInfo[]> {
    if (!config.connectionString) throw new Error("Missing connectionString");
    const tables = await postgresService.getTables(config.connectionString);
    return tables.map((t) => ({ name: t.name, schema: t.schema, rowCount: t.rowCount }));
  },

  async getTableSchema(config: DbConnectionConfig, table: string, schema = "public"): Promise<DbColumnInfo[]> {
    if (!config.connectionString) throw new Error("Missing connectionString");
    return postgresService.getTableSchema(config.connectionString, table, schema);
  },

  async getTableData(config: DbConnectionConfig, table: string, opts): Promise<DbPagedData> {
    if (!config.connectionString) throw new Error("Missing connectionString");
    return postgresService.getTableData(
      config.connectionString, table, opts.schema ?? "public",
      opts.page, opts.limit, opts.orderBy, opts.orderDir,
    );
  },

  async executeQuery(config: DbConnectionConfig, sql: string): Promise<DbQueryResult> {
    if (!config.connectionString) throw new Error("Missing connectionString");
    return postgresService.executeQuery(config.connectionString, sql);
  },

  async updateCell(config: DbConnectionConfig, table: string, opts): Promise<void> {
    if (!config.connectionString) throw new Error("Missing connectionString");
    await postgresService.updateCell(
      config.connectionString, table, opts.schema ?? "public",
      opts.pkColumn, opts.pkValue, opts.column, opts.value,
    );
  },

  async deleteRow(config: DbConnectionConfig, table: string, opts): Promise<void> {
    if (!config.connectionString) throw new Error("Missing connectionString");
    await postgresService.deleteRow(
      config.connectionString, table, opts.schema ?? "public",
      opts.pkColumn, opts.pkValue,
    );
  },
};
