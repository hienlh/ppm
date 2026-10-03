/**
 * What the server reads from a database's catalog: the objects it holds and
 * the full shape of one table. Shared because the sidebar, the Structure tab,
 * References and the Save dialog's cascade list all render it, and the server
 * builds changesets from the same description.
 */

export type DbObjectKind = "table" | "view" | "matview" | "function" | "procedure" | "trigger" | "sequence";

export interface DbObject {
  /** `null` on engines without schemas (SQLite). */
  schema: string | null;
  name: string;
  kind: DbObjectKind;
  /** Argument list of a function or procedure, which is what tells overloads apart. */
  args?: string;
  /** The table a trigger fires on. */
  table?: string;
  /** Rows the engine's statistics say a table holds; absent when it keeps none. */
  rowEstimate?: number;
}

export interface DbObjectList {
  /** Every schema, including empty ones, so a new schema shows up before it has tables. */
  schemas: string[];
  objects: DbObject[];
}

/** One column of a table or view, as the tree's search by column name or data type reads it. */
export interface DbColumnRef {
  schema: string | null;
  table: string;
  name: string;
  /** Declared type, as the catalog prints it. */
  type: string;
}

export type FkAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";

export interface DbForeignKey {
  name: string | null;
  /** The table holding the key columns. */
  schema: string | null;
  table: string;
  columns: string[];
  /** The table the key points at, and its columns in the same order. */
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
}

export interface DbStructureColumn {
  name: string;
  /** Declared type, as the catalog prints it. */
  type: string;
  nullable: boolean;
  /** Default expression as SQL text. */
  defaultValue: string | null;
  comment: string | null;
  /** The database fills it in on insert: serial, identity, or SQLite's rowid alias. */
  autoIncrement: boolean;
  /** Computed from other columns; cannot be written. */
  generated: boolean;
  /** The expression a generated column is computed from, as the catalog prints it; null otherwise. */
  computedExpression: string | null;
  /**
   * The rest is what redefining the column has to say again or lose — MySQL's `CHANGE COLUMN`
   * restates a whole column and SQLite rebuilds the whole table — so the editor carries it even
   * though it offers no field for it.
   *
   * A collation of the column's own: set only when it is not what the column would get anyway
   * (the type's in Postgres, the table's in MySQL, none declared in SQLite).
   */
  collation?: string | null;
  /** A generated column's value is stored rather than computed on read. */
  computedStored?: boolean;
  /** MySQL's `ON UPDATE CURRENT_TIMESTAMP`, as the catalog prints the expression. */
  onUpdate?: string | null;
  /** Postgres: an identity column, `GENERATED ALWAYS` or `BY DEFAULT`. A serial has none. */
  identity?: "always" | "default" | null;
  /** SQLite: the rowid alias was declared `AUTOINCREMENT`, so rowids are never reused. */
  sqliteAutoincrement?: boolean;
}

export interface DbPrimaryKey {
  name: string | null;
  /** In key order, which is not always column order. */
  columns: string[];
}

/** One part of an index key: a column, or an expression. */
export interface DbIndexKey {
  /** The column's own name; null for an expression part. */
  column: string | null;
  /** An expression part as the catalog prints it; null for a column. */
  expression: string | null;
  descending: boolean;
  /** Postgres `NULLS FIRST`/`NULLS LAST`, set only when it is not the direction's default. */
  nulls?: "first" | "last";
  /** MySQL's prefix length, `col(10)`. */
  length?: number;
  /** Postgres operator class, set only when it is not the type's default (`jsonb_path_ops`). */
  opclass?: string;
}

export interface DbIndex {
  name: string;
  /** Column names, or the expression text for an expression index — as shown, e.g. `col(10)` for a prefix. */
  columns: string[];
  /** The same key, part by part, as recreating the index needs it. */
  keys: DbIndexKey[];
  unique: boolean;
  /** Backs the primary key. */
  primary: boolean;
  /** Predicate of a partial index. */
  where: string | null;
  /** Postgres access method (btree, gin, …). */
  method: string | null;
}

export interface DbUniqueConstraint {
  name: string | null;
  columns: string[];
}

export interface DbCheckConstraint {
  name: string | null;
  expression: string;
  /** SQLite: the column whose definition declares it, which it is dropped with; absent for a table constraint. */
  column?: string;
}

export interface DbTableStructure {
  schema: string | null;
  name: string;
  kind: "table" | "view" | "matview" | "foreign";
  columns: DbStructureColumn[];
  primaryKey: DbPrimaryKey | null;
  /** Keys this table holds. */
  foreignKeys: DbForeignKey[];
  /** Keys other tables hold that point at this one ("dependencies" in DBGate). */
  references: DbForeignKey[];
  indexes: DbIndex[];
  uniques: DbUniqueConstraint[];
  checks: DbCheckConstraint[];
  comment: string | null;
  /** MySQL's storage engine (`InnoDB`); absent elsewhere. */
  engine?: string | null;
  /** SQLite `WITHOUT ROWID`. */
  withoutRowid?: boolean;
  /** SQLite `STRICT` (3.37+). */
  strict?: boolean;
  /**
   * The columns that address one row for an edit or a delete: the primary key,
   * or SQLite's rowid (under whichever of `rowid`, `_rowid_`, `oid` no column
   * shadows) for a table that has none. Empty when rows cannot be addressed —
   * the grid is then read-only.
   */
  rowKey: string[];
  /** True when `rowKey` is SQLite's rowid rather than real columns. */
  rowKeyIsRowid: boolean;
}

/** Names one object for `GET /connections/:id/object-sql`. */
export interface DbObjectRef {
  schema: string | null;
  name: string;
  kind: DbObjectKind;
  /** A function's or procedure's argument list, which tells overloads apart. */
  args?: string;
  /** The table a trigger belongs to: a trigger's name is unique per table, not per schema. */
  table?: string;
}

/**
 * The SQL tab's scripts for one object: its own CREATE as the server holds it, and for a table or
 * view the SELECT (and for a table the INSERT) a Query tab starts from.
 */
export interface DbObjectScripts {
  /** What the object is: a table, view or materialized view asked for as one of the others answers as what it is. */
  kind: DbObjectKind;
  create: string;
  select?: string;
  insert?: string;
}

/**
 * A map key for one table. Not `schema.table`: both names may contain a dot,
 * so `a.b` + `c` and `a` + `b.c` would collide. No identifier holds a NUL.
 */
export function tableKey(schema: string | null, table: string): string {
  return `${schema ?? ""}\u0000${table}`;
}
