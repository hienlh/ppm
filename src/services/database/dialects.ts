import type { DbType } from "../../types/database.ts";
import type { SqlDialect } from "./dialect.ts";
import { postgresDialect } from "./dialect-postgres.ts";
import { sqliteDialect } from "./dialect-sqlite.ts";
import { mysqlDialect } from "./dialect-mysql.ts";

export { classifyColumnType } from "../../shared/db-column-kind.ts";

const DIALECTS: Record<DbType, SqlDialect> = {
  postgres: postgresDialect,
  sqlite: sqliteDialect,
  mysql: mysqlDialect,
  mariadb: mysqlDialect,
};

export function dialectFor(type: DbType): SqlDialect {
  const dialect = DIALECTS[type];
  if (!dialect) throw new Error(`No SQL dialect for database type: ${type}`);
  return dialect;
}
