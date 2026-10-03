/**
 * How one database engine spells the SQL the grid needs. Everything the server
 * generates for a table view goes through a dialect, so a new engine is a new
 * dialect rather than another round of string patching (the filter row used to
 * emit `ILIKE`, which SQLite rejects outright).
 *
 * Values never pass through here on their way to the database: statements use
 * `placeholder()` and the driver binds the value. `literal()` exists only to
 * show a statement to a person — a preview, the audit log, "Open query".
 */

import type { DialectName } from "../../shared/db-types.ts";
import type { ColumnKind } from "../../shared/db-column-kind.ts";

export type { ColumnKind, DialectName };

/** What the grid knows about a column, enough to pick the right SQL for it. */
export interface DialectColumn {
  name: string;
  /** Type as the catalog declares it, e.g. `character varying(255)`, `INTEGER`. */
  type: string;
  /** Coarse class of the type, which is what dialect decisions depend on. */
  kind: ColumnKind;
}

export interface SqlDialect {
  readonly name: DialectName;
  quoteIdent(name: string): string;
  /** `schema.table`, or just the table for engines without schemas. */
  qualify(table: string, schema?: string | null): string;
  /** Parameter marker for the 1-based `index`-th value. */
  placeholder(index: number): string;
  /** Paging clause; both operands are placeholders so they bind like any value. */
  limitOffset(limitPlaceholder: string, offsetPlaceholder: string): string;
  /** `col` as text, for operators that only make sense on text (contains, trim). */
  asText(columnSql: string, column: DialectColumn): string;
  /**
   * Case-insensitive `LIKE` of `columnSql` against a pattern parameter whose
   * `%`, `_` and `\` are already escaped with a backslash (`likePattern`).
   */
  likeInsensitive(columnSql: string, patternPlaceholder: string, column: DialectColumn): string;
  isTrue(columnSql: string): string;
  isFalse(columnSql: string): string;
  /**
   * Left operand for comparing a date/time column with a wall-clock bound.
   * SQLite stores dates as text in several shapes, so it normalises first.
   */
  dateOperand(columnSql: string, column: DialectColumn): string;
  /** The bound value to bind for a `dateRange` edge. */
  dateBound(wallClock: string, offset: string | undefined, column: DialectColumn): string;
  /**
   * Render a value as SQL text — for display only, never executed. The column's `kind` tells a
   * Postgres array, which only reads its own text form, from the same array held by a json column.
   */
  literal(value: unknown, kind?: ColumnKind): string;
  /** `left` equals `right`, with NULL equal to NULL. */
  nullSafeEquals(left: string, right: string): string;
  /** An INSERT that gives every column its default. */
  insertDefaultValues(qualifiedTable: string): string;
  /**
   * SQL that turns the placeholder of a value written to `column` into the
   * column's type. Usually the placeholder itself; see the Postgres dialect
   * for the types where the driver would otherwise send the wrong thing.
   */
  bindAs(placeholder: string, column: DialectColumn, value: unknown): string;
}

/** Escape `%`, `_` and the escape character itself so `text` matches literally. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export type LikeShape = "contains" | "startsWith" | "endsWith";

/** Build the pattern for a `LIKE ... ESCAPE '\'` match of the given shape. */
export function likePattern(text: string, shape: LikeShape): string {
  const escaped = escapeLike(text);
  if (shape === "startsWith") return `${escaped}%`;
  if (shape === "endsWith") return `%${escaped}`;
  return `%${escaped}%`;
}

/**
 * Shared display rendering: numbers and booleans bare, everything else a quoted
 * string with quotes doubled. Objects are JSON — `String()` would print
 * `[object Object]` and hide what was written.
 */
export function ansiLiteral(
  value: unknown,
  booleans: { t: string; f: string } = { t: "TRUE", f: "FALSE" },
  bytes: (hex: string) => string = (hex) => `'\\x${hex}'`,
): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? booleans.t : booleans.f;
  if (value instanceof Uint8Array) return bytes(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex"));
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `'${String(value)}'`;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === "object") {
    try { return `'${(JSON.stringify(value) ?? "").replace(/'/g, "''")}'`; } catch { /* fall through */ }
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Quote an identifier with `"`, doubling any `"` inside it. */
export function doubleQuoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
