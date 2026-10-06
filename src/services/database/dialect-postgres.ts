import { postgresArrayLiteral } from "../../shared/sql-identifiers.ts";
import { ansiLiteral, doubleQuoteIdent, type DialectColumn, type SqlDialect } from "./dialect.ts";

export { classifyPostgresType } from "../../shared/db-column-kind.ts";

/** One element of an array as the driver holds it, in the text Postgres reads it from. */
function arrayElementText(item: unknown): string {
  if (item instanceof Uint8Array) return `\\x${Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString("hex")}`;
  if (item instanceof Date) return item.toISOString();
  return typeof item === "object" ? JSON.stringify(item) : String(item);
}

function asText(columnSql: string, column: DialectColumn): string {
  return column.kind === "text" ? columnSql : `CAST(${columnSql} AS TEXT)`;
}

export const postgresDialect: SqlDialect = {
  name: "postgres",
  quoteIdent: doubleQuoteIdent,
  qualify(table, schema) {
    return `${doubleQuoteIdent(schema || "public")}.${doubleQuoteIdent(table)}`;
  },
  placeholder: (index) => `$${index}`,
  limitOffset: (limit, offset) => `LIMIT ${limit} OFFSET ${offset}`,
  asText,
  likeInsensitive(columnSql, pattern, column) {
    // E'' keeps the escape a single backslash whatever standard_conforming_strings says.
    return `${asText(columnSql, column)} ILIKE ${pattern} ESCAPE E'\\\\'`;
  },
  isTrue: (col) => `${col} = TRUE`,
  isFalse: (col) => `${col} = FALSE`,
  dateOperand: (col) => col,
  dateBound(wallClock, offset, column) {
    // A timestamptz holds an instant, so the bound needs the user's zone to mean
    // "midnight where I am". Every other date type holds wall-clock time and
    // takes the bound as written.
    return column.kind === "datetimetz" && offset ? `${wallClock}${offset}` : wallClock;
  },
  literal: (value, kind) => (kind !== "json" && Array.isArray(value) ? postgresArrayLiteral(value, arrayElementText) : ansiLiteral(value)),
  nullSafeEquals: (left, right) => `${left} IS NOT DISTINCT FROM ${right}`,
  insertDefaultValues: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  bindAs(placeholder, column, value) {
    // postgres.js serialises a parameter by the type the server says it
    // expects, and for three types text goes wrong: a boolean is written as
    // `x === true`, so 'true' is stored as false; JSON text is JSON.stringify'd
    // into a JSON *string*; bytea wants a Buffer. Sent as text and cast, the
    // value is parsed by Postgres itself, which is what a person typing it means.
    const text = typeof value === "string" || typeof value === "number";
    const cast = column.kind === "json" || (column.kind === "boolean" && text) || (column.kind === "binary" && text);
    return cast ? `CAST(${placeholder}::text AS ${column.type})` : placeholder;
  },
};
