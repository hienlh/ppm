/**
 * Edits to one table, sent together and written in one transaction: the
 * grid's pending cells, new rows and deleted rows become a single changeset
 * rather than a request per cell, so a save either lands whole or not at all.
 */

/** The row-key columns' values, by column name: every primary key column, or SQLite's rowid. */
export type RowKey = Record<string, unknown>;

export interface ChangesetUpdate {
  key: RowKey;
  /** New values, by column. */
  set: Record<string, unknown>;
  /**
   * What the changed columns held when the row was loaded. The UPDATE requires
   * them still to hold it, so a value someone else changed in the meantime is
   * refused rather than overwritten. Columns whose values cannot be compared
   * exactly (JSON, binary, arrays) are left out of the check.
   */
  original?: Record<string, unknown>;
}

export interface ChangesetDelete {
  key: RowKey;
}

export interface Changeset {
  table: string;
  /** Postgres schema; ignored on SQLite. */
  schema?: string | null;
  inserts?: Record<string, unknown>[];
  updates?: ChangesetUpdate[];
  deletes?: ChangesetDelete[];
}

export interface TableRef {
  schema: string | null;
  table: string;
}

export interface ChangesetApplyRequest extends Changeset {
  /**
   * Tables ticked under "Delete references CASCADE": their rows that point at a
   * deleted row — directly or through other tables — are deleted first, in
   * the same transaction. The server works out the statements itself.
   */
  cascade?: TableRef[];
}

/** A table whose rows point, directly or through other tables, at the table rows are deleted from. */
export interface ChangesetReference extends TableRef {
  /** The chains of tables that lead from it to the deleted rows, e.g. `[["order_items", "orders", "users"]]`. */
  paths: string[][];
  /** Every key on every path already has ON DELETE CASCADE, so the database would delete these rows anyway. */
  cascadesInDb: boolean;
  /** What ticking it adds to the script. */
  script: string;
}

export interface ChangesetPreview {
  /** The statements `apply` runs without any cascade, values written out, one per line. */
  script: string;
  statementCount: number;
  /** Only when the changeset deletes rows. Deepest first, which is the order their deletes run in. */
  references: ChangesetReference[];
}

export interface ChangesetApplyResult {
  inserted: number;
  updated: number;
  deleted: number;
  /** Rows the ticked cascade deletes removed. */
  cascaded: number;
  executionTimeMs: number;
}

/** Why `apply` wrote nothing, sent as `data` beside the error message. */
export interface ChangesetFailure {
  /** 0-based position of the failing statement in the script; absent when the commit itself failed. */
  statementIndex?: number;
  statementCount: number;
  /** The failing statement, values written out. */
  sql?: string;
  /** An UPDATE or DELETE that should have hit exactly one row hit this many. */
  affected?: number;
}

/** Most operations one changeset may carry, so a request cannot hold a transaction open indefinitely. */
export const CHANGESET_MAX_OPERATIONS = 10_000;
