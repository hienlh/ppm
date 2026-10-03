/**
 * What a DDL generator hands the Save dialog and the adapter that runs it.
 */

export interface DdlStatement {
  sql: string;
  /**
   * Runs outside the transaction the rest shares, before or after it: SQLite ignores
   * `PRAGMA foreign_keys` inside a transaction, and rebuilding a table needs it off.
   */
  phase?: "before" | "after";
  /**
   * The statement reports problems rather than causing them, so its result is read: `foreign-keys`
   * is `PRAGMA foreign_key_check`, whose rows are rows that no longer have a parent; `schema`
   * compiles every view and trigger, which a rebuilt table can leave broken. Either fails the
   * script only over a problem the script made, not one the database already had.
   */
  check?: "foreign-keys" | "schema";
  /** The table a check is about. */
  table?: string;
}

export interface DdlPlan {
  statements: DdlStatement[];
  /** SQLite rebuilds the table: the Save dialog asks for "Allow recreate" before it runs. */
  recreate: boolean;
  /** Things the script does that the user did not ask for in so many words, e.g. dropping another table's foreign key. */
  warnings: string[];
}

/** A change this engine (or this version of it) cannot make, said in words the Save dialog shows. */
export class DdlUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DdlUnsupportedError";
  }
}

/**
 * A statement of a script failed. `index` is its place in the plan (-1 for the COMMIT that ends
 * one); `applied` is how many statements stay done: none where the script ran in one transaction
 * (Postgres, SQLite), and those before it on MySQL, where each DDL statement commits on its own.
 */
export class DdlApplyError extends Error {
  constructor(message: string, readonly statement: string, readonly index: number, readonly applied: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DdlApplyError";
  }
}

/** A driver's error as the Save dialog shows it: Postgres keeps what depends on what in `detail`. */
export function ddlErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const detail = (e as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" && detail.trim() ? `${message}. ${detail.trim()}` : message;
}

/** The script as the Save dialog shows it, one statement per paragraph. */
export function ddlScript(statements: readonly DdlStatement[]): string {
  return statements.map((s) => (s.sql.startsWith("--") ? s.sql : `${s.sql};`)).join("\n");
}
