/**
 * Import's writer for one table: what the row's action does to the table — Create table/append,
 * Append data, Truncate and import, Drop and create table, as DBGate names them — and the file's
 * rows as multi-row INSERTs in the transaction of a write session.
 *
 * Values are bound, never spliced into the SQL, and go as the text the file holds, which the
 * database reads by its own rules for the column's type. Only what text cannot carry is turned
 * into something else first: bytes from base64 or `{"$binary": …}`, 1/0 for a boolean on an
 * engine that has none, a JSON array into a Postgres array, a JSON file's string into a JSON column.
 */
import type { ColumnKind } from "../../../shared/db-column-kind.ts";
import type { ImportAction } from "../../../shared/db-impexp.ts";
import type { DbTableStructure } from "../../../shared/db-structure.ts";
import { blankColumn, type TableModel } from "../../../shared/db-table-model.ts";
import type { DbType, DialectName } from "../../../shared/db-types.ts";
import { postgresArrayText } from "../../../shared/sql-identifiers.ts";
import type { DbWriteSession } from "../../../types/database.ts";
import { createTablePlan, dropTablePlan, truncateTablePlan, type TableRef } from "../ddl/ddl-objects.ts";
import { classifyColumnType, dialectFor } from "../dialects.ts";
import type { MappedColumns } from "./column-map.ts";
import { JsonText, type FileValue } from "./readers/file-rows.ts";
import { jsonArrayTexts } from "./readers/json-reader.ts";

export class ImportTableError extends Error {}

/** The one type a table Import creates gives every column, as DBGate's does: any value fits, NULL too. */
const TEXT_TYPE: Record<DialectName, string> = { postgres: "text", mysql: "longtext", sqlite: "TEXT" };

/** Bytes of values one INSERT carries at most, under MariaDB's default 16 MB packet with room to spare. */
export const MAX_INSERT_BYTES = 4 * 1024 * 1024;

/** A column rows are written to, and the place of its value in the rows the file reader hands over. */
export interface ImportColumn {
  name: string;
  type: string;
  kind: ColumnKind;
  index: number;
}

export interface ImportTablePlan {
  /** Run first, in order: DROP TABLE, CREATE TABLE or TRUNCATE. */
  ddl: string[];
  /** What the DDL does, for the messages. */
  steps: string[];
  columns: ImportColumn[];
  warnings: string[];
}

const tableLabel = (t: TableRef): string => (t.schema ? `${t.schema}.${t.name}` : t.name);

const listed = (names: readonly string[]): string => names.join(", ");

/** The keys other tables hold on `table`, by those tables' names. */
function referencingTables(table: TableRef, structure: DbTableStructure): string[] {
  const others = structure.references.filter((fk) => !(fk.table === table.name && (fk.schema ?? null) === (table.schema ?? null)));
  return [...new Set(others.map((fk) => (fk.schema && fk.schema !== table.schema ? `${fk.schema}.${fk.table}` : fk.table)))];
}

/** The file's columns, all of them, into a table Import creates. */
function createPlan(dialect: DialectName, table: TableRef, mapped: MappedColumns, ddl: string[], steps: string[]): ImportTablePlan {
  const model: TableModel = {
    schema: table.schema,
    name: table.name,
    columns: mapped.names.map((name, i) => ({ ...blankColumn(`c${i}`, name), type: TEXT_TYPE[dialect] })),
    primaryKey: null, indexes: [], uniques: [], foreignKeys: [], checks: [], comment: null, engine: null, withoutRowid: false, strict: false,
  };
  return {
    ddl: [...ddl, ...createTablePlan(dialect, model).statements.map((s) => s.sql)],
    steps: [...steps, `Creating table ${tableLabel(table)}`],
    columns: mapped.names.map((name, i) => ({ name, type: TEXT_TYPE[dialect], kind: "text", index: mapped.indexes[i]! })),
    warnings: [],
  };
}

/**
 * Columns that must hold a JSON document by a `json_valid` check of their own, which is all that
 * MariaDB's JSON is: a LONGTEXT with that check. Its type reads as text, but a JSON file's string
 * has to go into it as a JSON string, as it does into MySQL's JSON, or the check refuses the row.
 */
function jsonCheckedColumns(structure: DbTableStructure): Set<string> {
  const names = new Set<string>();
  for (const check of structure.checks) {
    const m = /^json_valid\(`((?:[^`]|``)+)`\)$/i.exec(check.expression.trim());
    if (m) names.add(m[1]!.replace(/``/g, "`"));
  }
  return names;
}

/**
 * The file's columns into a table that exists: those the table has by the very same name, as
 * DBGate matches them. The table's other columns take their defaults; a file column the table
 * does not have, or one the database computes, is left out and said so.
 */
function appendPlan(type: DbType, table: TableRef, structure: DbTableStructure, mapped: MappedColumns, ddl: string[], steps: string[]): ImportTablePlan {
  const byName = new Map(structure.columns.map((c) => [c.name, c]));
  const jsonChecked = dialectFor(type).name === "mysql" ? jsonCheckedColumns(structure) : new Set<string>();
  const columns: ImportColumn[] = [];
  const absent: string[] = [];
  const computed: string[] = [];
  mapped.names.forEach((name, i) => {
    const column = byName.get(name);
    if (!column) absent.push(name);
    else if (column.generated) computed.push(name);
    else columns.push({ name, type: column.type, kind: jsonChecked.has(name) ? "json" : classifyColumnType(type, column.type), index: mapped.indexes[i]! });
  });
  const label = tableLabel(table);
  if (!columns.length) {
    const why = [
      absent.length ? `it has no ${absent.length === 1 ? "column" : "columns"} ${listed(absent)}` : "",
      computed.length ? `it computes ${listed(computed)} itself` : "",
    ].filter(Boolean).join(", and ");
    throw new ImportTableError(`None of the file's columns can be written to ${label}: ${why}`);
  }
  const warnings: string[] = [];
  if (absent.length) warnings.push(`${label} has no ${absent.length === 1 ? "column" : "columns"} ${listed(absent)}: left out`);
  if (computed.length) warnings.push(`${listed(computed)} ${computed.length === 1 ? "is" : "are"} computed by the database: left out`);
  return { ddl, steps, columns, warnings };
}

/**
 * What writing `mapped` into `table` takes for `action`, `structure` being the table as it is now
 * (null when there is none). Throws `ImportTableError` for what cannot be done, before anything is.
 */
export function planImportTable(type: DbType, action: ImportAction, table: TableRef, structure: DbTableStructure | null, mapped: MappedColumns): ImportTablePlan {
  const dialect = dialectFor(type).name;
  const label = tableLabel(table);
  if (structure && (structure.kind === "view" || structure.kind === "matview")) {
    throw new ImportTableError(`${label} is a ${structure.kind === "view" ? "view" : "materialized view"}: import into a table`);
  }
  switch (action) {
    case "appendData":
      if (!structure) throw new ImportTableError(`Table ${label} not found`);
      return appendPlan(type, table, structure, mapped, [], []);
    case "createTable":
      return structure ? appendPlan(type, table, structure, mapped, [], []) : createPlan(dialect, table, mapped, [], []);
    case "truncate": {
      if (!structure) return createPlan(dialect, table, mapped, [], []);
      // SQLite's DELETE FROM would run other tables' ON DELETE actions; Postgres and MySQL refuse to TRUNCATE such a table.
      const children = dialect === "sqlite" ? referencingTables(table, structure) : [];
      if (children.length) {
        throw new ImportTableError(`${listed(children)} ${children.length === 1 ? "has a foreign key" : "have foreign keys"} onto ${label}, so its rows cannot all be deleted: choose Append data, or remove the key in the Structure tab first`);
      }
      const plan = appendPlan(type, table, structure, mapped, [], []);
      return { ...plan, ddl: truncateTablePlan(dialect, table, []).statements.map((s) => s.sql), steps: [`Deleting the rows of ${label}`] };
    }
    case "dropCreateTable": {
      if (!structure) return createPlan(dialect, table, mapped, [], []);
      // Postgres and MySQL refuse to drop a table another one points at; SQLite's plan refuses it by name.
      const drop = dropTablePlan(dialect, table, dialect === "sqlite" ? structure.references : []);
      return createPlan(dialect, table, mapped, drop.statements.map((s) => s.sql), [`Dropping table ${label}`]);
    }
  }
}

// ── Values ──

/** A value a column cannot take, in words that follow "the value". */
class ValueError extends Error {}

type Convert = (value: Exclude<FileValue, null>) => unknown;

/** What text there is in a value: a JSON number, object or array as written, `true`/`false`. */
function textOf(value: Exclude<FileValue, null>): string {
  if (value instanceof JsonText) return value.text;
  return typeof value === "boolean" ? String(value) : value;
}

/** Strict base64, as PPM's CSV export writes bytes; a simple class, so a long value cannot backtrack. */
function isBase64(text: string): boolean {
  return text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
}

/** The bytes of PPM's JSON export, `{"$binary": "<base64>", "size": N}`; null for any other object. */
function binaryObject(text: string): Buffer | null {
  const o = JSON.parse(text) as unknown;
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const record = o as Record<string, unknown>;
  if (typeof record.$binary !== "string" || !isBase64(record.$binary)) return null;
  if (record.truncated === true) throw new ValueError("holds only the start of its bytes (\"truncated\": true)");
  return Buffer.from(record.$binary, "base64");
}

function binary(value: Exclude<FileValue, null>): Buffer {
  if (typeof value === "string" && isBase64(value)) return Buffer.from(value, "base64");
  const bytes = value instanceof JsonText && value.text.startsWith("{") ? binaryObject(value.text) : null;
  if (bytes) return bytes;
  throw new ValueError("is not base64, nor a {\"$binary\": …} object");
}

/** A JSON array as the text of a Postgres array; anything else as its own text. */
function postgresArray(value: Exclude<FileValue, null>): string {
  let json: string | null = value instanceof JsonText ? value.text : null;
  if (typeof value === "string" && value.trimStart().startsWith("[")) {
    try {
      JSON.parse(value);
      json = value;
    } catch {
      // Not JSON: Postgres reads it as it is, `{1,2}` included.
    }
  }
  const items = json === null ? null : jsonArrayTexts(json);
  return items ? postgresArrayText(items, (item) => item as string) : textOf(value);
}

/** How a value goes into `column`. `fromJson`: the file is JSON, whose strings are already decoded text. */
function converter(type: DbType, column: ImportColumn, fromJson: boolean): Convert {
  const dialect = dialectFor(type).name;
  if (dialect === "postgres" && column.type.endsWith("[]")) return postgresArray;
  switch (column.kind) {
    case "binary":
      return binary;
    case "boolean":
      // Postgres reads the text itself (`bindAs` casts it); MySQL's and SQLite's booleans are 1 and 0.
      if (dialect === "postgres") return textOf;
      return (value) => {
        if (typeof value === "boolean") return value ? 1 : 0;
        const text = textOf(value);
        const word = text.trim().toLowerCase();
        if (word === "true" || word === "1") return 1;
        if (word === "false" || word === "0") return 0;
        return text;
      };
    case "json":
      // A JSON file's string is a JSON string value; a CSV field is the document's text.
      return (value) => (typeof value === "string" && fromJson ? JSON.stringify(value) : textOf(value));
    default:
      return textOf;
  }
}

function byteSize(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return 8;
}

/**
 * Writes rows into one table through `session`, as many to an INSERT as the database's parameter
 * limit and `MAX_INSERT_BYTES` allow. `write` holds rows back until a statement is full; `flush`
 * sends what is held.
 */
export class ImportRowWriter {
  private readonly converts: Convert[];
  private readonly perStatement: number;
  private readonly table: string;
  private readonly names: string;
  private readonly placeholders: ((n: number) => string)[];
  private fullStatement: string | null = null;
  private held: unknown[] = [];
  private heldRows = 0;
  private heldBytes = 0;
  /** Rows the file handed over so far, which an error names by their place. */
  private seen = 0;
  /** Rows the database has taken so far. */
  written = 0;

  constructor(
    private readonly session: DbWriteSession,
    type: DbType,
    target: TableRef,
    private readonly columns: readonly ImportColumn[],
    fromJson: boolean,
    private readonly maxBytes = MAX_INSERT_BYTES,
  ) {
    const d = dialectFor(type);
    this.converts = columns.map((c) => converter(type, c, fromJson));
    this.perStatement = Math.max(1, Math.floor(session.maxParams / columns.length));
    this.table = d.name === "sqlite" ? d.quoteIdent(target.name) : d.qualify(target.name, target.schema);
    this.names = columns.map((c) => d.quoteIdent(c.name)).join(", ");
    // Postgres casts what it would otherwise misread (`bindAs`): a boolean's or a JSON value's text. Bytes go as bytes.
    this.placeholders = columns.map((c) => (n) => d.bindAs(d.placeholder(n), c, c.kind === "binary" ? Buffer.alloc(0) : ""));
  }

  /** The INSERT for one row, as the audit records what the import ran. */
  get template(): string {
    return this.insertSql(1);
  }

  async write(rows: readonly FileValue[][]): Promise<void> {
    for (const row of rows) {
      this.seen++;
      for (let c = 0; c < this.columns.length; c++) {
        const column = this.columns[c]!;
        const value = row[column.index] ?? null;
        let bound: unknown = null;
        if (value !== null) {
          try {
            bound = this.converts[c]!(value);
          } catch (e) {
            if (!(e instanceof ValueError)) throw e;
            throw new ImportTableError(`Row ${this.seen.toLocaleString("en-US")}, column ${column.name}: the value ${e.message}`);
          }
        }
        this.held.push(bound);
        this.heldBytes += byteSize(bound);
      }
      this.heldRows++;
      if (this.heldRows >= this.perStatement || this.heldBytes >= this.maxBytes) await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.heldRows) return;
    const params = this.held;
    const rows = this.heldRows;
    this.held = [];
    this.heldRows = 0;
    this.heldBytes = 0;
    const sql = rows === this.perStatement ? (this.fullStatement ??= this.insertSql(rows)) : this.insertSql(rows);
    this.written += await this.session.run({ sql, params });
  }

  private insertSql(rows: number): string {
    const groups: string[] = [];
    let n = 0;
    for (let r = 0; r < rows; r++) groups.push(`(${this.placeholders.map((p) => p(++n)).join(", ")})`);
    return `INSERT INTO ${this.table} (${this.names}) VALUES ${groups.join(", ")}`;
  }
}
