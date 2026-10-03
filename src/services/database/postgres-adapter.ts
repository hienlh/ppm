import type { DatabaseAdapter, DbConnectionConfig, DbTableInfo, DbColumnInfo, DbPagedData, DbQueryResult } from "../../types/database.ts";
import { closeEndpoint, serviceConnectionString, type EndpointConfig } from "./connection-endpoint.ts";
import { postgresService, readonlyPostgresService } from "../postgres.service.ts";

/** A readonly connection goes through pools on which Postgres itself refuses writes. */
function service(config: DbConnectionConfig) {
  return config.readonly ? readonlyPostgresService : postgresService;
}

/** The URL, plus the parameter naming the connection's SSH tunnel and certificate files when it has them. */
function connectionString(config: DbConnectionConfig): string {
  if (!config.connectionString) throw new Error("Missing connectionString");
  return serviceConnectionString(config as EndpointConfig);
}

/** Thin adapter wrapping the existing PostgresService to implement DatabaseAdapter */
export const postgresAdapter: DatabaseAdapter = {
  async testConnection(config: DbConnectionConfig): Promise<{ ok: boolean; error?: string }> {
    if (!config.connectionString) return { ok: false, error: "Missing connectionString" };
    return service(config).testConnection(connectionString(config));
  },

  async probe(config) {
    return service(config).probe(connectionString(config));
  },

  listDatabases: (config) => service(config).listDatabases(connectionString(config)),

  async close(config) {
    if (!config.connectionString) return;
    const url = connectionString(config);
    await Promise.all([postgresService.close(url), readonlyPostgresService.close(url)]);
    // After the pools: their connections are channels inside the tunnel.
    closeEndpoint(config as EndpointConfig);
  },

  async getTables(config: DbConnectionConfig): Promise<DbTableInfo[]> {
    const tables = await service(config).getTables(connectionString(config));
    return tables.map((t) => ({ name: t.name, schema: t.schema, rowCount: t.rowCount }));
  },

  async getTableSchema(config: DbConnectionConfig, table: string, schema = "public"): Promise<DbColumnInfo[]> {
    return service(config).getTableSchema(connectionString(config), table, schema);
  },

  async getTableData(config: DbConnectionConfig, table: string, opts): Promise<DbPagedData> {
    return service(config).getTableData(
      connectionString(config), table, opts.schema ?? "public",
      opts.page, opts.limit, opts.orderBy, opts.orderDir,
    );
  },

  async executeQuery(config: DbConnectionConfig, sql: string): Promise<DbQueryResult> {
    return service(config).executeQuery(connectionString(config), sql);
  },

  async describeTable(config, table, schema = "public") {
    return service(config).describeTable(connectionString(config), table, schema);
  },

  async selectRows(config, stmt) {
    return service(config).selectRows(connectionString(config), stmt);
  },

  streamRows(config, stmt, limits, opts) {
    return service(config).streamRows(connectionString(config), stmt, limits, opts);
  },

  async countRows(config, stmt, timeoutMs) {
    return service(config).countRows(connectionString(config), stmt, timeoutMs);
  },

  async estimateRows(config, table, schema = "public") {
    return service(config).estimateRows(connectionString(config), table, schema);
  },

  async runQuery(config, sql) {
    return service(config).runQuery(connectionString(config), sql);
  },

  async openQuerySession(config) {
    return service(config).openQuerySession(connectionString(config));
  },

  async listObjects(config) {
    return service(config).listObjects(connectionString(config));
  },

  async listColumns(config) {
    return service(config).listColumns(connectionString(config));
  },

  async getStructure(config, table, schema = "public") {
    return service(config).getStructure(connectionString(config), table, schema);
  },

  async listForeignKeys(config) {
    return service(config).listForeignKeys(connectionString(config));
  },

  async getObjectSql(config, obj) {
    return service(config).getObjectSql(connectionString(config), obj);
  },

  async applyChangeset(config, statements) {
    return service(config).applyChangeset(connectionString(config), statements, config.isolationLevel);
  },

  async planAlterTable(config, base, current, diff, references) {
    return service(config).planAlterTable(connectionString(config), base, current, diff, references);
  },

  async applyDdl(config, plan) {
    return service(config).applyDdl(connectionString(config), plan);
  },

  async openWriteSession(config) {
    return service(config).openWriteSession(connectionString(config));
  },
};
