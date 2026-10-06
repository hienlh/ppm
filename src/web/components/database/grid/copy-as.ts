/**
 * DBGate's Copy and Copy advanced: the rows the selection lies on by the columns it lies in, written
 * in one of nine formats. Ctrl+C writes the one chosen with Set format (DBGate's default: the values
 * alone, tab-separated); every value is the one the cell shows now, edits included. A cell a new row
 * was given nothing in has no value: it is left out of JSON, YAML and SQL, and empty in text.
 *
 * NULL is empty in text and CSV, `null` in JSON and YAML and `NULL` in SQL. Where DBGate writes
 * every value bare, text quotes one holding a tab, a line break or a quote — the way a spreadsheet
 * does, so a pasted multi-line value stays one cell — and CSV quotes as RFC 4180 has it. Copied on
 * its own, a single value is never quoted.
 */
import yaml from "js-yaml";
import type { ColumnKind } from "../../../../shared/db-column-kind";
import type { DialectName } from "../../../../shared/db-types";
import { quoteIdentifier, sqlLiteral } from "../../../../shared/sql-identifiers";
import { formCopyText } from "./form-view-model";

export type CopyFormat =
  | "textWithHeaders" | "textWithoutHeaders" | "headers" | "csv" | "json" | "jsonLines" | "yaml" | "inserts" | "updates";

/** DBGate's: the menu item that copies in a format, and its name in "Set format: …". */
export const COPY_FORMATS: readonly { id: CopyFormat; label: string; name: string }[] = [
  { id: "textWithHeaders", label: "Copy with headers", name: "With headers" },
  { id: "textWithoutHeaders", label: "Copy without headers", name: "Without headers" },
  { id: "headers", label: "Copy only headers", name: "Only Headers" },
  { id: "csv", label: "Copy as CSV", name: "CSV" },
  { id: "json", label: "Copy as JSON", name: "JSON" },
  { id: "jsonLines", label: "Copy as JSON lines/NDJSON", name: "JSON lines/NDJSON" },
  { id: "yaml", label: "Copy as YAML", name: "YAML" },
  { id: "inserts", label: "Copy as SQL INSERTs", name: "SQL INSERTs" },
  { id: "updates", label: "Copy as SQL UPDATEs", name: "SQL UPDATEs" },
];

export const DEFAULT_COPY_FORMAT: CopyFormat = "textWithoutHeaders";

export function copyFormatLabel(format: CopyFormat): string {
  return COPY_FORMATS.find((f) => f.id === format)!.label;
}

export interface CopyData {
  /** In the order the grid shows them; hidden ones are not among them. */
  columns: readonly string[];
  /** One per row, in order: every value the row shows now, not only the columns copied. */
  rows: readonly Readonly<Record<string, unknown>>[];
  /**
   * Each row as the database holds it, which an UPDATE finds it by: a key edited and not yet saved
   * is still the old one there. `rows` when absent.
   */
  stored?: readonly Readonly<Record<string, unknown>>[];
}

/** Where Copy as SQL writes to. */
export interface CopySqlTarget {
  /** A query's rows name no table: DBGate writes `target`. */
  table: string;
  schema?: string | null;
  dialect: DialectName;
  /** What an UPDATE finds its row by: the primary key, else the first column, as DBGate has it. */
  keyColumns: readonly string[];
  /** A number column's digits are written bare even when they arrive as a string. */
  kinds?: ReadonlyMap<string, ColumnKind>;
}

const LINE = "\r\n";

/** A Postgres table is named with its schema, so the statement reads the same whatever the search path; MySQL's runs in the tab's database. */
export function sqlTableName(target: Pick<CopySqlTarget, "table" | "schema" | "dialect">): string {
  const name = quoteIdentifier(target.table, target.dialect);
  return target.dialect === "postgres" && target.schema ? `${quoteIdentifier(target.schema, "postgres")}.${name}` : name;
}

function cellText(value: unknown): string {
  return formCopyText(value);
}

function quoteText(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function quoteCsv(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function textFormat({ columns, rows }: CopyData, headers: boolean): string {
  // A single value copied as it is: what is pasted is exactly what the cell holds.
  if (!headers && rows.length === 1 && columns.length === 1) return cellText(rows[0]![columns[0]!]);
  const lines = rows.map((row) => columns.map((c) => quoteText(cellText(row[c]))).join("\t"));
  if (headers) lines.unshift(columns.map(quoteText).join("\t"));
  return lines.join(LINE);
}

function csvFormat({ columns, rows }: CopyData): string {
  const lines = [columns.map(quoteCsv).join(",")];
  for (const row of rows) lines.push(columns.map((c) => quoteCsv(cellText(row[c]))).join(","));
  return lines.join(LINE);
}

/** A row's values in column order, those it has none for left out. */
function rowObject(row: Readonly<Record<string, unknown>>, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) if (row[c] !== undefined) out[c] = row[c];
  return out;
}

function insertsFormat({ columns, rows }: CopyData, target: CopySqlTarget): string {
  const table = sqlTableName(target);
  const out: string[] = [];
  for (const row of rows) {
    const set = columns.filter((c) => row[c] !== undefined);
    if (!set.length) continue;
    const names = set.map((c) => quoteIdentifier(c, target.dialect)).join(", ");
    const values = set.map((c) => sqlLiteral(row[c], target.dialect, target.kinds?.get(c))).join(", ");
    out.push(`INSERT INTO ${table} (${names}) VALUES (${values});`);
  }
  return out.join("\n");
}

/** `"id"=1 AND "region" IS NULL`: a row found by its key, NULL included. */
export function sqlKeyCondition(row: Readonly<Record<string, unknown>>, keyColumns: readonly string[], target: Pick<CopySqlTarget, "dialect" | "kinds">): string {
  return keyColumns.map((c) => {
    const name = quoteIdentifier(c, target.dialect);
    const value = row[c];
    return value === null || value === undefined ? `${name} IS NULL` : `${name}=${sqlLiteral(value, target.dialect, target.kinds?.get(c))}`;
  }).join(" AND ");
}

function updatesFormat({ columns, rows, stored }: CopyData, target: CopySqlTarget): string {
  const table = sqlTableName(target);
  const out: string[] = [];
  rows.forEach((row, i) => {
    const set = columns.filter((c) => row[c] !== undefined);
    if (!set.length || !target.keyColumns.length) return;
    const assignments = set.map((c) => `${quoteIdentifier(c, target.dialect)}=${sqlLiteral(row[c], target.dialect, target.kinds?.get(c))}`).join(", ");
    out.push(`UPDATE ${table} SET ${assignments} WHERE ${sqlKeyCondition(stored?.[i] ?? row, target.keyColumns, target)};`);
  });
  return out.join("\n");
}

/** The selection written in `format`. */
export function formatCopy(format: CopyFormat, data: CopyData, target: CopySqlTarget): string {
  switch (format) {
    case "textWithHeaders": return textFormat(data, true);
    case "textWithoutHeaders": return textFormat(data, false);
    case "headers": return data.columns.map(quoteText).join("\t");
    case "csv": return csvFormat(data);
    case "json": return JSON.stringify(data.rows.map((row) => rowObject(row, data.columns)), null, 2);
    case "jsonLines": return data.rows.map((row) => JSON.stringify(rowObject(row, data.columns))).join(LINE);
    case "yaml": return yaml.dump(data.rows.map((row) => rowObject(row, data.columns)));
    case "inserts": return insertsFormat(data, target);
    case "updates": return updatesFormat(data, target);
  }
}

const FORMAT_KEY = "ppm-db-copy-format";

/** What Ctrl+C copies on this device: Set format's choice, kept in the browser. */
export function readCopyFormat(): CopyFormat {
  try {
    const kept = localStorage.getItem(FORMAT_KEY);
    return COPY_FORMATS.some((f) => f.id === kept) ? (kept as CopyFormat) : DEFAULT_COPY_FORMAT;
  } catch {
    return DEFAULT_COPY_FORMAT;
  }
}

export function keepCopyFormat(format: CopyFormat): void {
  try {
    localStorage.setItem(FORMAT_KEY, format);
  } catch { /* private mode: the choice lasts as long as the page */ }
}
