/**
 * Every engine a connection can be. Anything that lists engines — the stored
 * CHECK, the routes, the CLI, the connection form — reads this list instead of
 * spelling the union out again, so a new engine is one entry here plus an
 * adapter and a dialect.
 *
 * MariaDB is its own entry, as DBGate has it: it is a different product with
 * its own logo and version line, but it speaks MySQL's protocol and dialect
 * and shares its adapter.
 */
export const DB_TYPES = ["postgres", "mysql", "mariadb", "sqlite"] as const;

export type DbType = (typeof DB_TYPES)[number];

export const DB_TYPE_LABELS: Record<DbType, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlite: "SQLite",
};

export function isDbType(value: unknown): value is DbType {
  return typeof value === "string" && (DB_TYPES as readonly string[]).includes(value);
}

/** How an engine spells its SQL: the quoting, comments and string escapes a statement is read with. */
export type DialectName = "postgres" | "sqlite" | "mysql";

export function dialectNameOf(type: DbType): DialectName {
  return type === "mariadb" ? "mysql" : type;
}
