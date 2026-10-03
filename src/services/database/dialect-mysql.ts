import { ansiLiteral, type DialectColumn, type SqlDialect } from "./dialect.ts";

export { classifyMysqlType } from "../../shared/db-column-kind.ts";

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function asText(columnSql: string, column: DialectColumn): string {
  return column.kind === "text" ? columnSql : `CAST(${columnSql} AS CHAR)`;
}

/**
 * A string written out for MySQL, which reads a backslash in a literal as an
 * escape: `C:\temp` has to be `'C:\\temp'` or it comes back holding a tab.
 * (A server running NO_BACKSLASH_ESCAPES reads it literally; the text is for
 * people, and the default mode is what a copied statement will usually meet.)
 */
function stringLiteral(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export const mysqlDialect: SqlDialect = {
  name: "mysql",
  quoteIdent,
  // A MySQL "schema" is a database; with none named, the connection's own is used.
  qualify: (table, schema) => (schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table)),
  placeholder: () => "?",
  limitOffset: (limit, offset) => `LIMIT ${limit} OFFSET ${offset}`,
  asText,
  // Matched by the column's collation, as DBGate does: the default `_ci`
  // collations ignore case (and MySQL 8's `_ai_ci` accents too), a `_bin` or
  // `_cs` column is compared the way its owner declared it, and a prefix match
  // can still use the column's index — `LOWER(col)` would give that up.
  // The escape is named: with NO_BACKSLASH_ESCAPES in the server's sql_mode,
  // LIKE has no default one, and the `\%`, `\_` and `\\` of `likePattern`
  // would stop matching what they stand for (on MySQL for every column, on
  // MariaDB for some character sets). CHAR(92) is a backslash in either mode,
  // where a '\\' literal would itself depend on it.
  likeInsensitive: (columnSql, pattern, column) => `${asText(columnSql, column)} LIKE ${pattern} ESCAPE CHAR(92)`,
  // MySQL's own truthiness: any non-zero value in a tinyint(1) is true.
  isTrue: (col) => `${col} <> 0`,
  isFalse: (col) => `${col} = 0`,
  dateOperand: (col) => col,
  dateBound: (wallClock) => wallClock,
  literal(value) {
    if (typeof value === "string") return stringLiteral(value);
    if (value !== null && typeof value === "object" && !(value instanceof Uint8Array) && !(value instanceof Date)) {
      try { return stringLiteral(JSON.stringify(value) ?? ""); } catch { /* fall through */ }
    }
    return ansiLiteral(value, { t: "TRUE", f: "FALSE" }, (hex) => `X'${hex}'`);
  },
  nullSafeEquals: (left, right) => `${left} <=> ${right}`,
  insertDefaultValues: (table) => `INSERT INTO ${table} () VALUES ()`,
  // The server converts what a prepared statement sends: text into JSON, a
  // boolean into 1/0, digits into BIGINT and DECIMAL without rounding.
  bindAs: (placeholder) => placeholder,
};
