import type { SqlSafety } from "./assistant-sql-safety.ts";

/**
 * What a MySQL or MariaDB query reaches beyond its own text, from `information_schema`.
 *
 * - A view can call a stored function, and its definition is not always readable (it needs
 *   SHOW VIEW), so reading any view is not proven: every view in the current database, or in
 *   one the query's words could name, whose name the query's words could be.
 * - A bare built-in name cannot be shadowed: the server resolves a bare `name(` to a built-in
 *   function first, then to a loadable function (which may not share a built-in's name), and only
 *   then to a stored function of the current database; a stored function named like a built-in
 *   is reachable only as `db.name(`, which the text check already refuses. But the safe list
 *   also holds Postgres-only names (`initcap`, `split_part`) that MySQL does not have, and those
 *   reach a stored function of the same name — so a call is not proven when the current database
 *   has a stored function named like it. Loadable functions are not listed by either server
 *   without privileges on the `mysql` schema; only an administrator installs one, and that is
 *   trusted the way a Postgres C function is.
 *
 * Every name is sent hex-encoded and compared case-insensitively: how a server reads a backslash
 * and whether table names are case-sensitive both depend on its settings.
 */

/** The catalog query: rows of [kind, schema, name], kind being "view" or "function". */
export function mysqlReachSql(names: readonly string[]): string {
  const named = names.length
    ? ` OR CONVERT(TABLE_SCHEMA USING utf8mb4) COLLATE utf8mb4_general_ci IN (${names
      .map((n) => `CONVERT(X'${Buffer.from(n, "utf8").toString("hex")}' USING utf8mb4) COLLATE utf8mb4_general_ci`)
      .join(", ")})`
    : "";
  return `SELECT /*+ MAX_EXECUTION_TIME(5000) */ 'view' AS kind, TABLE_SCHEMA AS db, TABLE_NAME AS name
FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()${named}
UNION ALL
SELECT 'function', ROUTINE_SCHEMA, ROUTINE_NAME
FROM information_schema.ROUTINES WHERE ROUTINE_TYPE = 'FUNCTION' AND ROUTINE_SCHEMA = DATABASE()`;
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase();

/**
 * Whether a query whose words are `names` and which calls the safe-listed functions `called`
 * stays proven given the catalog's `rows`; when not, why. A row in a shape it does not expect throws.
 */
export function mysqlReachVerdict(names: readonly string[], called: ReadonlySet<string>, rows: readonly unknown[][]): SqlSafety {
  for (const row of rows) {
    const [kind, db, name] = row.map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : v));
    if (typeof kind !== "string" || typeof db !== "string" || typeof name !== "string") {
      throw new Error("information_schema answered in an unexpected shape");
    }
    if (kind === "view" && names.some((n) => sameName(n, name))) {
      return { proven: false, reason: `it may read the view ${db}.${name}, and a view can call stored functions PPM does not check` };
    }
    if (kind === "function" && [...called].some((n) => sameName(n, name))) {
      return { proven: false, reason: `it calls ${name.toLowerCase()}(), and the current database has a stored function of that name` };
    }
  }
  return { proven: true };
}
