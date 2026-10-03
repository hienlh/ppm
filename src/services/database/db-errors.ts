/**
 * Refusals that mean "this connection is readonly", whichever layer made them.
 * Both are audited as `blocked` and answered with 403, like the first check.
 */

/** PPM refused a statement before sending it: it is not a plain read. */
export class ReadonlyViolationError extends Error {
  readonly status = 403;
  constructor(message = "Connection is readonly — only SELECT queries allowed. Change this in PPM web UI.") {
    super(message);
  }
}

/** What a readonly connection answers to the table editor's Save and the tree's structure commands. */
export const READONLY_STRUCTURE = "Connection is readonly — changing the structure is disabled. Change this in PPM web UI.";

/** What a readonly connection answers to Import. */
export const READONLY_IMPORT = "Connection is readonly — importing is disabled. Change this in PPM web UI.";

/** The SQLSTATE for a write inside a READ ONLY transaction, on Postgres, MySQL and MariaDB alike. */
const READ_ONLY_SQL_TRANSACTION = "25006";

/**
 * The database itself refused a write: Postgres, MySQL or MariaDB inside a
 * READ ONLY transaction, or SQLite on a file opened read-only. This is what
 * catches `SELECT nextval('s')` and a function that deletes, which read like
 * reads. postgres.js carries the SQLSTATE in `code`; mysql2 in `sqlState`,
 * its `code` being the error's name (`ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`).
 */
export function isReadonlyRefusal(e: unknown): boolean {
  if (e instanceof ReadonlyViolationError) return true;
  const err = e as { code?: unknown; sqlState?: unknown } | null;
  return err?.code === READ_ONLY_SQL_TRANSACTION || err?.sqlState === READ_ONLY_SQL_TRANSACTION || err?.code === "SQLITE_READONLY";
}

/**
 * A statement of a Query tab run that failed: the database's message, and where in the statement it
 * points when the database says — a 1-based character (Postgres) or a 1-based line (MySQL). `cause`
 * is the driver's own error, which `isReadonlyRefusal` reads. `fatal`: the session itself is gone,
 * so nothing after this statement can run on it.
 */
export class QueryStatementError extends Error {
  constructor(
    message: string,
    readonly where: { position?: number; line?: number } = {},
    override readonly cause?: unknown,
    readonly fatal = false,
  ) {
    super(message);
  }
}

/** What a person reads when a readonly connection refused something, whichever layer refused it. */
export function readonlyRefusalMessage(e: unknown): string {
  if (e instanceof ReadonlyViolationError) return e.message;
  return `Connection is readonly — the database refused a write: ${(e as Error | null)?.message ?? String(e)}`;
}
