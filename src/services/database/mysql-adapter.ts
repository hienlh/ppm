import type { DatabaseAdapter, DbConnectionConfig } from "../../types/database.ts";
import { closeEndpoint, serviceConnectionString, type EndpointConfig } from "./connection-endpoint.ts";
import { mysqlService, readonlyMysqlService } from "../mysql.service.ts";

/** A readonly connection goes through pools whose sessions MySQL itself keeps read-only. */
function service(config: DbConnectionConfig) {
  return config.readonly ? readonlyMysqlService : mysqlService;
}

/** A connection with a default database lists only that one, unless its form says otherwise. */
function listing(config: DbConnectionConfig) {
  return { allDatabases: config.singleDatabase === false };
}

/** The URL, plus the parameter naming the connection's SSH tunnel and certificate files when it has them. */
function connectionString(config: DbConnectionConfig): string {
  if (!config.connectionString) throw new Error("Missing connectionString");
  return serviceConnectionString(config as EndpointConfig);
}

/**
 * MySQL and MariaDB. A schema is a database; with none given, the one the
 * connection string names is used.
 */
export const mysqlAdapter: DatabaseAdapter = {
  async testConnection(config) {
    if (!config.connectionString) return { ok: false, error: "Missing connectionString" };
    return service(config).testConnection(connectionString(config));
  },

  probe: (config) => service(config).probe(connectionString(config)),
  listDatabases: (config) => service(config).listDatabases(connectionString(config)),
  close: async (config) => {
    if (!config.connectionString) return;
    const url = connectionString(config);
    await Promise.all([mysqlService.close(url), readonlyMysqlService.close(url)]);
    // After the pools: their connections are channels inside the tunnel.
    closeEndpoint(config as EndpointConfig);
  },
  getTables: (config) => service(config).getTables(connectionString(config), listing(config)),
  getTableSchema: (config, table, schema) => service(config).getTableSchema(connectionString(config), table, schema),
  getTableData: (config, table, opts) => service(config).getTableData(
    connectionString(config), table, opts.schema, opts.page, opts.limit, opts.orderBy, opts.orderDir,
  ),
  executeQuery: (config, sql) => service(config).executeQuery(connectionString(config), sql),
  describeTable: (config, table, schema) => service(config).describeTable(connectionString(config), table, schema),
  selectRows: (config, stmt) => service(config).selectRows(connectionString(config), stmt),
  streamRows: (config, stmt, limits, opts) => service(config).streamRows(connectionString(config), stmt, limits, opts),
  countRows: (config, stmt, timeoutMs) => service(config).countRows(connectionString(config), stmt, timeoutMs),
  estimateRows: (config, table, schema) => service(config).estimateRows(connectionString(config), table, schema),
  runQuery: (config, sql) => service(config).runQuery(connectionString(config), sql),
  openQuerySession: (config) => service(config).openQuerySession(connectionString(config)),
  listObjects: (config) => service(config).listObjects(connectionString(config), listing(config)),
  listColumns: (config) => service(config).listColumns(connectionString(config), listing(config)),
  getStructure: (config, table, schema) => service(config).getStructure(connectionString(config), table, schema),
  listForeignKeys: (config) => service(config).listForeignKeys(connectionString(config)),
  getObjectSql: (config, obj) => service(config).getObjectSql(connectionString(config), obj),
  applyChangeset: (config, statements) => service(config).applyChangeset(connectionString(config), statements, config.isolationLevel),
  planAlterTable: (config, base, current, diff, references) => service(config).planAlterTable(connectionString(config), base, current, diff, references),
  applyDdl: (config, plan) => service(config).applyDdl(connectionString(config), plan),
  openWriteSession: (config) => service(config).openWriteSession(connectionString(config)),
};
