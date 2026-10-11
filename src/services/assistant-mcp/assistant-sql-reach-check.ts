import type { DialectName } from "../../shared/db-types.ts";
import type { ConnectionRow } from "../db.service.ts";
import { getAdapter } from "../database/adapter-registry.ts";
import { connConfig } from "../../server/routes/database-route-helpers.ts";
import type { SqlSafety } from "./assistant-sql-safety.ts";
import { nameCandidates } from "./assistant-sql-reach-names.ts";
import { parsePostgresReach, postgresReachSql, postgresReachVerdict } from "./assistant-sql-reach-postgres.ts";
import { mysqlReachSql, mysqlReachVerdict } from "./assistant-sql-reach-mysql.ts";

/**
 * The second half of proving that a query the Assistant wants to run only reads: what it reaches
 * that its text does not show. `assistantSqlSafety` has already passed the text; this asks the
 * database's catalog about the views, policies and same-named functions behind it, on the
 * connection's read-only path, and never plans or runs the query itself. Any doubt — a catalog
 * that cannot be read, an answer in a shape not expected, too many names — is "not proven", so
 * the user is asked; it never means "run anyway".
 *
 * SQLite needs no catalog: a view there can only call SQLite's own functions (it has no stored
 * functions, and PPM registers none), the one built-in with an effect beyond the file,
 * `load_extension()`, is refused by bun:sqlite ("not authorized"; from a view, "unsafe use of
 * load_extension()"), and the file is opened read-only.
 */

/** Runs one catalog read on the connection, answering its rows. */
export type CatalogReader = (sql: string) => Promise<unknown[][]>;

/** How long PPM waits for the catalog before asking the user instead. The server stops the read at 5 s. */
const CATALOG_DEADLINE_MS = 10_000;

/** A catalog reader on `conn`'s read-only path: pools the server keeps read-only, whatever the connection allows. Not audited — the read is PPM's own. */
export function connectionCatalogReader(conn: ConnectionRow): CatalogReader {
  const adapter = getAdapter(conn.type);
  const config = { ...connConfig(conn), readonly: true };
  return async (sql) => (await adapter.runQuery(config, sql)).rows;
}

function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${CATALOG_DEADLINE_MS / 1000} s`)), CATALOG_DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function reachSafety(sql: string, dialect: "postgres" | "mysql", called: ReadonlySet<string>, read: CatalogReader): Promise<SqlSafety> {
  const names = nameCandidates(sql, dialect);
  if (!names) return { proven: false, reason: "it names too many things for PPM to check what they reach" };
  if (dialect === "mysql") return mysqlReachVerdict(names, called, await withDeadline(read(mysqlReachSql(names))));
  const rows = await withDeadline(read(postgresReachSql(names)));
  return postgresReachVerdict(sql, called, parsePostgresReach(rows[0]?.[0]));
}

/**
 * Whether `sql`, already proven by its text to call only the safe-listed functions `called`
 * (see `assistantSqlSafety`), also reaches nothing beyond them on this database; when not, why.
 */
export async function assistantSqlReachSafety(
  sql: string,
  dialect: DialectName,
  called: ReadonlySet<string>,
  read: CatalogReader,
): Promise<SqlSafety> {
  if (dialect === "sqlite") return { proven: true };
  try {
    return await reachSafety(sql, dialect, called, read);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    return { proven: false, reason: `PPM could not read the catalog to check what it reaches (${message.slice(0, 300)})` };
  }
}
