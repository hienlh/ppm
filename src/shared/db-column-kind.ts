/**
 * The coarse class of a column's type, from the type name its catalog
 * declares. Shared because both halves need it: the server picks SQL by it
 * (text operators cast, date bounds carry an offset only for an instant), and
 * the filter row reads what was typed by it — `5` is a number on a number
 * column and the text "5" on a text column, and `2021` names a whole year on a
 * date column.
 */

import type { DbType } from "./db-types.ts";

export type ColumnKind = "text" | "number" | "boolean" | "date" | "datetime" | "datetimetz" | "time" | "binary" | "json" | "other";

/**
 * Classify a Postgres type as `format_type()` prints it. Anything not listed is
 * "other" (uuid, enums, arrays, geometry…), which only changes how text
 * operators cast the column.
 */
export function classifyPostgresType(type: string): ColumnKind {
  const t = type.toLowerCase();
  // `integer[]` is an array, not a number: only its text form can be filtered.
  if (t.endsWith("[]")) return "other";
  if (/^(character varying|varchar|character|char|bpchar|text|name|citext)\b/.test(t)) return "text";
  if (/^(smallint|integer|bigint|int[248]?|numeric|decimal|real|double precision|float[48]?|money|oid|smallserial|serial|bigserial)\b/.test(t)) return "number";
  if (t === "boolean" || t === "bool") return "boolean";
  if (t === "date") return "date";
  if (/^timestamp(\(\d+\))? with time zone$/.test(t) || t === "timestamptz") return "datetimetz";
  if (/^timestamp/.test(t)) return "datetime";
  if (/^time/.test(t)) return "time";
  if (t === "bytea") return "binary";
  if (t === "json" || t === "jsonb") return "json";
  return "other";
}

/**
 * Classify a declared SQLite type. SQLite itself only has affinities, but the
 * declared name says more about what the column holds (`DATETIME` is numeric
 * affinity yet always holds text), and the grid needs that to pick operators.
 */
export function classifySqliteType(type: string): ColumnKind {
  const t = type.toUpperCase();
  if (/BOOL/.test(t)) return "boolean";
  if (/^DATE$/.test(t)) return "date";
  if (/DATETIME|TIMESTAMP/.test(t)) return "datetime";
  if (/^TIME$/.test(t)) return "time";
  if (/JSON/.test(t)) return "json";
  // SQLite's own affinity rules, in its own order (INT before CHAR before BLOB).
  if (/INT/.test(t)) return "number";
  if (/CHAR|CLOB|TEXT/.test(t)) return "text";
  // An untyped column (`CREATE TABLE t(a, b)`) holds whatever was put in it —
  // usually text and numbers, so it is not treated as binary.
  if (t === "") return "other";
  if (/BLOB/.test(t)) return "binary";
  if (/REAL|FLOA|DOUB|NUM|DEC/.test(t)) return "number";
  return "other";
}

/**
 * Classify a MySQL/MariaDB type as `information_schema.COLUMNS.COLUMN_TYPE`
 * prints it (`int unsigned`, `tinyint(1)`, `enum('a','b')`, `datetime(3)`).
 *
 * `tinyint(1)` is how MySQL stores BOOLEAN, and MySQL 8 keeps printing that
 * one display width precisely so clients can tell. A MariaDB JSON column is a
 * `longtext` with a `json_valid` check, so it classifies as text.
 */
export function classifyMysqlType(type: string): ColumnKind {
  const t = type.toLowerCase().trim();
  if (/^(tinyint\(1\)|bool|boolean|bit\(1\))(\s|$)/.test(t)) return "boolean";
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|dec|fixed|float|double|real|bit|year)\b/.test(t)) return "number";
  if (/^(char|varchar|tinytext|text|mediumtext|longtext|enum|set|national)\b/.test(t)) return "text";
  if (t === "date") return "date";
  // TIMESTAMP holds an instant but is read and written in the session's time
  // zone, which is also how the grid shows it — so a bound is wall-clock time.
  if (/^(datetime|timestamp)\b/.test(t)) return "datetime";
  if (/^time\b/.test(t)) return "time";
  if (/^(binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/.test(t)) return "binary";
  if (t === "json") return "json";
  return "other";
}

const CLASSIFIERS: Record<DbType, (type: string) => ColumnKind> = {
  postgres: classifyPostgresType,
  sqlite: classifySqliteType,
  mysql: classifyMysqlType,
  mariadb: classifyMysqlType,
};

export function classifyColumnType(type: DbType, declared: string): ColumnKind {
  return (CLASSIFIERS[type] ?? (() => "other"))(declared);
}
