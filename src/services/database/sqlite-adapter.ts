import type { DatabaseAdapter, DbConnectionConfig, DbTableInfo, DbColumnInfo, DbPagedData, DbQueryResult } from "../../types/database.ts";
import { readonlySqliteService, sqliteService } from "../sqlite.service.ts";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

/** A readonly connection opens the file read-only, so SQLite itself refuses writes. */
function service(config: DbConnectionConfig) {
  return config.readonly ? readonlySqliteService : sqliteService;
}

function path(config: DbConnectionConfig): string {
  if (!config.path) throw new Error("Missing path");
  return config.path;
}

/** Thin adapter wrapping the existing SqliteService to implement DatabaseAdapter */
export const sqliteAdapter: DatabaseAdapter = {
  async testConnection(config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!config.path) return { ok: false, error: "Missing path" };
      if (!existsSync(config.path)) return { ok: false, error: `File not found: ${config.path}` };
      // Attempt to open and list tables
      service(config).getTables(config.path, config.path);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async probe(config) {
    const file = path(config);
    if (!existsSync(file)) throw new Error(`File not found: ${file}`);
    const db = new Database(file, { readonly: true });
    try {
      // Opening succeeds on any file; the first read is what refuses one that is not a database.
      db.query("SELECT count(*) FROM sqlite_master").get();
      const row = db.query("SELECT sqlite_version() AS v").get() as { v: string };
      return { version: `SQLite ${row.v}`, databases: [] };
    } finally {
      db.close();
    }
  },

  // A file has no login to let go of; its handle closes itself when idle.
  async close() {},
  // A file is one database.
  async listDatabases() { return []; },

  async getTables(config: DbConnectionConfig): Promise<DbTableInfo[]> {
    const tables = service(config).getTables(path(config), path(config));
    return tables.map((t) => ({ name: t.name, schema: "main", rowCount: t.rowCount }));
  },

  async getTableSchema(config: DbConnectionConfig, table: string): Promise<DbColumnInfo[]> {
    const cols = service(config).getTableSchema(path(config), path(config), table);
    return cols.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: !c.notnull,
      pk: !!c.pk,
      defaultValue: c.dflt_value,
      autoIncrement: c.autoIncrement,
      fk: c.fk,
    }));
  },

  async getTableData(config: DbConnectionConfig, table: string, opts): Promise<DbPagedData> {
    return service(config).getTableData(
      path(config), path(config), table,
      opts.page, opts.limit, opts.orderBy, opts.orderDir,
    );
  },

  async executeQuery(config: DbConnectionConfig, sql: string): Promise<DbQueryResult> {
    return service(config).executeQuery(path(config), path(config), sql);
  },

  async describeTable(config, table) {
    return service(config).describeTable(path(config), path(config), table);
  },

  async selectRows(config, stmt) {
    return service(config).selectRows(path(config), path(config), stmt);
  },

  streamRows(config, stmt, limits, opts) {
    return service(config).streamRows(path(config), path(config), stmt, limits, opts);
  },

  // bun:sqlite cannot interrupt a running statement, so the timeout does not apply.
  async countRows(config, stmt) {
    return service(config).countRows(path(config), path(config), stmt);
  },

  // SQLite keeps no row statistics unless ANALYZE ran, and even then only per index.
  async estimateRows() {
    return null;
  },

  async runQuery(config, sql) {
    return service(config).runQuery(path(config), path(config), sql, config.maxQueryRows);
  },

  async openQuerySession(config) {
    return service(config).openQuerySession(path(config), path(config), config.maxQueryRows);
  },

  async listObjects(config) {
    return service(config).listObjects(path(config), path(config));
  },

  async listColumns(config) {
    return service(config).listColumns(path(config), path(config));
  },

  async getStructure(config, table) {
    return service(config).getStructure(path(config), path(config), table);
  },

  async listForeignKeys(config) {
    return service(config).listForeignKeys(path(config), path(config));
  },

  async getObjectSql(config, obj) {
    return service(config).getObjectSql(path(config), path(config), obj);
  },

  async applyChangeset(config, statements) {
    return service(config).applyChangeset(path(config), path(config), statements);
  },

  async planAlterTable(config, base, current, diff) {
    return service(config).planAlterTable(path(config), path(config), base, current, diff);
  },

  async applyDdl(config, plan) {
    service(config).applyDdl(path(config), path(config), plan);
  },

  async openWriteSession(config) {
    return service(config).openWriteSession(path(config), path(config));
  },
};
