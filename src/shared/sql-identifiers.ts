/**
 * Quoting for the few statements the browser writes itself — a table's first
 * query, the query a foreign key opens. Everything the grid runs is built on the
 * server by the connection's dialect; these only have to read the same way.
 *
 * MySQL is the one that differs: a double-quoted word there is a *string*, so
 * `SELECT * FROM "users"` is a syntax error rather than a table, and a
 * backslash in a string literal is an escape.
 */
import type { ColumnKind } from "./db-column-kind";
import type { DbBinaryValue } from "./db-grid";
import type { DialectName } from "./db-types";

export function quoteIdentifier(name: string, dialect: DialectName): string {
  return dialect === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string, dialect: DialectName): string {
  const text = dialect === "mysql" ? value.replace(/\\/g, "\\\\") : value;
  return `'${text.replace(/'/g, "''")}'`;
}

/** Digits as a number column sends them past 2^53, and as MySQL sends a DECIMAL. */
const NUMBER_TEXT = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

function isBinary(value: unknown): value is DbBinaryValue {
  return typeof value === "object" && value !== null && typeof (value as DbBinaryValue).$binary === "string"
    && typeof (value as DbBinaryValue).size === "number";
}

function base64Hex(base64: string): string {
  const raw = atob(base64);
  let hex = "";
  for (let i = 0; i < raw.length; i++) hex += raw.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/**
 * A value as the grid holds it — the JSON the server sent — written as a literal, for SQL the
 * browser writes out for a person to run (Copy as SQL, Generate SQL). Spelled as the server's
 * dialects spell `literal()`, so a statement reads the same whichever side wrote it. A number column
 * past 2^53 arrives as its digits in a string, written bare. Bytes the server sent only the start
 * of cannot be written: a comment says so in their place, and the statement then fails to run
 * rather than storing the first 64 KB of them.
 *
 * A Postgres array arrives as a JSON array, which an array column does not read (`'[1,2]'` is a
 * "malformed array literal"): it is written in Postgres's own array text, `'{"1","2"}'`. Only a
 * json column's arrays stay JSON, and only the column's kind can tell the two apart.
 */
export function sqlLiteral(value: unknown, dialect: DialectName, kind?: ColumnKind): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return dialect === "sqlite" ? (value ? "1" : "0") : value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : quoteLiteral(String(value), dialect);
  if (typeof value === "string") return kind === "number" && NUMBER_TEXT.test(value) ? value : quoteLiteral(value, dialect);
  if (isBinary(value)) {
    if (value.truncated) return notLoaded(value);
    const hex = base64Hex(value.$binary);
    return dialect === "postgres" ? `'\\x${hex}'` : `X'${hex}'`;
  }
  if (dialect === "postgres" && kind !== "json" && Array.isArray(value)) {
    const cut = truncatedIn(value);
    return cut ? notLoaded(cut) : postgresArrayLiteral(value, (item) =>
      isBinary(item) ? `\\x${base64Hex(item.$binary)}` : typeof item === "object" ? JSON.stringify(item) : String(item));
  }
  return quoteLiteral(JSON.stringify(value) ?? "", dialect);
}

function notLoaded(value: DbBinaryValue): string {
  return `/* ${value.size} bytes, not loaded */`;
}

function truncatedIn(items: readonly unknown[]): DbBinaryValue | null {
  for (const item of items) {
    const cut = Array.isArray(item) ? truncatedIn(item) : isBinary(item) && item.truncated ? item : null;
    if (cut) return cut;
  }
  return null;
}

/**
 * A Postgres array as a literal of its own text form, `'{"1","2"}'`, `'{{"a",NULL},{"b","c"}}'`:
 * each element quoted, so a comma, brace, space or the word NULL inside one stays part of it, and
 * the element type's own input reads the text whatever the type is. `element` writes one element
 * that is neither NULL nor an array, since the browser and the server hold bytes differently.
 */
export function postgresArrayLiteral(items: readonly unknown[], element: (item: unknown) => string): string {
  return quoteLiteral(postgresArrayText(items, element), "postgres");
}

/** A Postgres array's own text form, `{"1","2"}`, as `postgresArrayLiteral` quotes it — what a bound parameter carries. */
export function postgresArrayText(items: readonly unknown[], element: (item: unknown) => string): string {
  return `{${items.map((item) => {
    if (item === null || item === undefined) return "NULL";
    if (Array.isArray(item)) return postgresArrayText(item, element);
    return `"${element(item).replace(/[\\"]/g, "\\$&")}"`;
  }).join(",")}}`;
}
