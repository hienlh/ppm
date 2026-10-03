/**
 * What the Structure tab's Save and the tree's structure commands send, and what the server
 * answers. Every change goes through the same two calls: `structure/preview` turns it into the
 * script the Save changes dialog shows, `structure/apply` runs that script.
 */
import type { TableModel } from "./db-table-model";

export type StructureChange =
  /** The table editor's Save on an existing table: `base` is the table as the editor read it. */
  | { kind: "alter"; base: TableModel; current: TableModel }
  /** New table. */
  | { kind: "create"; current: TableModel }
  | { kind: "drop-table"; schema: string | null; table: string }
  | { kind: "truncate-table"; schema: string | null; table: string }
  | { kind: "rename-table"; schema: string | null; table: string; newName: string }
  /** A copy of the table with its rows, under `newName` (see `backupTableName`). */
  | { kind: "backup-table"; schema: string | null; table: string; newName: string }
  | { kind: "rename-column"; schema: string | null; table: string; column: string; newName: string }
  | { kind: "drop-column"; schema: string | null; table: string; column: string };

export type StructureChangeKind = StructureChange["kind"];

export interface StructureStatement {
  sql: string;
  /**
   * Runs outside the transaction the rest shares, before it or after it — after it whether or not
   * it committed, since it undoes what one before it set on the connection (SQLite's
   * `PRAGMA foreign_keys`).
   */
  phase?: "before" | "after";
}

export interface StructurePreview {
  /** The script, one statement per line, as `apply` runs it. */
  sql: string;
  /** The same statements one by one, in the order of the script: what a failure's `index` counts. */
  statements: StructureStatement[];
  /** SQLite rebuilds a table: `apply` runs only with `allowRecreate`. */
  recreate: boolean;
  /** What the script does beyond what was asked for in so many words. */
  warnings: string[];
  /** The script runs in one transaction (Postgres, SQLite); MySQL commits each DDL statement on its own. */
  transactional: boolean;
}

export interface StructureApplyRequest {
  change: StructureChange;
  /** The Save dialog's "Allow recreate" tick. */
  allowRecreate?: boolean;
  /**
   * The script the dialog showed. When the database changed since, the script `apply` builds is not
   * that one, and it refuses with 409 rather than run something nobody read.
   */
  sql?: string;
}

export interface StructureApplyResult {
  executionTimeMs: number;
}

/** Where a script stopped, for the "Error when saving" dialog; the `data` of a failed apply. */
export interface StructureFailure {
  /** The statement that failed, or `COMMIT`. */
  statement: string;
  /** Its place among the script's statements, from 0; -1 for the COMMIT that ends one. */
  index: number;
  /** How many statements stay done: none in one transaction, those before it on MySQL. */
  applied: number;
  /** How many statements the script has. */
  total: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * DBGate's name for a table backup, `_<table>_<yyyy-MM-dd-HH-mm-ss>`, in local time. DBGate writes
 * the hour as 1–12, so a backup made at 1 pm sorts before one made at 11 am the same day; this
 * writes 0–23.
 */
export function backupTableName(table: string, at: Date): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `_${table}_${date}-${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
}
