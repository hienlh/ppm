import { ansiLiteral, doubleQuoteIdent, type SqlDialect } from "./dialect.ts";

export { classifySqliteType } from "../../shared/db-column-kind.ts";

export const sqliteDialect: SqlDialect = {
  name: "sqlite",
  quoteIdent: doubleQuoteIdent,
  // One database per connection: ATTACH is refused, so there is no schema to name.
  qualify: (table) => doubleQuoteIdent(table),
  placeholder: () => "?",
  limitOffset: (limit, offset) => `LIMIT ${limit} OFFSET ${offset}`,
  // SQLite converts any value to text for LIKE and TRIM on its own.
  asText: (columnSql) => columnSql,
  // LIKE ignores case for ASCII letters only: "Ä" and "ä" stay different
  // without the ICU extension, which bun:sqlite does not load.
  likeInsensitive: (columnSql, pattern) => `${columnSql} LIKE ${pattern} ESCAPE '\\'`,
  isTrue: (col) => `${col} = 1`,
  isFalse: (col) => `${col} = 0`,
  // Dates are text in several shapes (`2024-02-15`, `2024-02-15T10:00:00`,
  // `2024-02-15 10:00:00.123`); strftime() puts them all in one sortable form.
  // Not datetime(), which drops the milliseconds: a value picked from the
  // column would then fall outside the millisecond it names.
  dateOperand: (col) => `strftime('%Y-%m-%d %H:%M:%f', ${col})`,
  dateBound: (wallClock) => wallClock,
  literal: (value) => ansiLiteral(value, { t: "1", f: "0" }, (hex) => `X'${hex}'`),
  nullSafeEquals: (left, right) => `${left} IS ${right}`,
  insertDefaultValues: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  // bun:sqlite stores what it is given with SQLite's own affinity rules.
  bindAs: (placeholder) => placeholder,
};
