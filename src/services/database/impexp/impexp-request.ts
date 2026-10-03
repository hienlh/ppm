/**
 * The requests that start an Import/Export job, checked: what the routes take, as the runners take
 * it. A file name, an option or a column mapping that cannot be used is a 400 here, before a job
 * starts — not an error halfway through one.
 */
import {
  CSV_BOOLEAN_FORMATS, CSV_DELIMITERS, CSV_RECORD_DELIMITERS, DEFAULT_EXPORT_OPTIONS, DEFAULT_IMPORT_OPTIONS, IMPEXP_MAX_ITEMS,
  IMPEXP_MAX_MAPPED_COLUMNS, IMPEXP_MAX_QUERY_CHARS, columnMapProblem, isImpExpFileFormat, isImportAction, isImportFileFormat,
  outputFileNameProblem, type ColumnMapEntry, type CsvWriteOptions, type ExportFormatOptions, type ImpExpFileFormat,
  type ImportAction, type ImportFileFormat, type ImportFormatOptions, type JsonOptions, type XmlWriteOptions,
} from "../../../shared/db-impexp.ts";
import type { DbType } from "../../../shared/db-types.ts";
import { isUploadId } from "./import-uploads.ts";

export class ImpExpRequestError extends Error {}

function fail(message: string): never {
  throw new ImpExpRequestError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Characters a name in a request — a table, a column, an option — may have. */
const MAX_NAME_CHARS = 1024;

/** `value`, or `fallback` when it is absent; anything but one of `allowed` is refused. */
function choice<T>(value: unknown, allowed: readonly T[], fallback: T, what: string): T {
  if (value === undefined) return fallback;
  return allowed.includes(value as T) ? (value as T) : fail(`${what} is not one of its choices`);
}

function flag(value: unknown, fallback: boolean, what: string): boolean {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : fail(`${what} must be true or false`);
}

function text(value: unknown, fallback: string, what: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") fail(`${what} must be text`);
  return value.length > MAX_NAME_CHARS ? fail(`${what} is longer than ${MAX_NAME_CHARS} characters`) : value;
}

function section(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined) return {};
  return isRecord(value) ? value : fail(`${what} must be an object`);
}

export function parseJsonOptions(value: unknown, fallback: JsonOptions): JsonOptions {
  const o = section(value, "options.json");
  return {
    style: choice(o.style, ["array", "object"] as const, fallback.style, "JSON style"),
    keyField: text(o.keyField, fallback.keyField, "Key field"),
    rootField: text(o.rootField, fallback.rootField, "Root field"),
  };
}

/** Export's format options; one left out takes its default. */
export function parseExportOptions(value: unknown): ExportFormatOptions {
  const o = section(value, "options");
  const csv = section(o.csv, "options.csv");
  const xml = section(o.xml, "options.xml");
  const d = DEFAULT_EXPORT_OPTIONS;
  const csvOptions: CsvWriteOptions = {
    delimiter: choice(csv.delimiter, CSV_DELIMITERS.map((x) => x.value), d.csv.delimiter, "Delimiter"),
    quoted: flag(csv.quoted, d.csv.quoted, "Quoted"),
    header: flag(csv.header, d.csv.header, "Has header row"),
    bom: flag(csv.bom, d.csv.bom, "Write BOM"),
    recordDelimiter: choice(csv.recordDelimiter, CSV_RECORD_DELIMITERS.map((x) => x.value), d.csv.recordDelimiter, "Record Delimiter"),
    booleanFormat: choice(csv.booleanFormat, CSV_BOOLEAN_FORMATS.map((x) => x.value), d.csv.booleanFormat, "Boolean Format"),
  };
  const xmlOptions: XmlWriteOptions = {
    rootElement: text(xml.rootElement, d.xml.rootElement, "Root element name"),
    itemElement: text(xml.itemElement, d.xml.itemElement, "Item element name"),
  };
  return {
    csv: csvOptions,
    json: parseJsonOptions(o.json, d.json),
    xml: xmlOptions,
    xlsxSingleFile: flag(o.xlsxSingleFile, d.xlsxSingleFile, "Create single file"),
  };
}

/** Configure columns of one row; none, or an empty list, copies every column as it is. */
export function parseColumnMap(value: unknown, where: string): ColumnMapEntry[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(`${where}: columns must be a list`);
  if (value.length > IMPEXP_MAX_MAPPED_COLUMNS) fail(`${where}: at most ${IMPEXP_MAX_MAPPED_COLUMNS} columns can be mapped`);
  const entries = value.map((e): ColumnMapEntry => {
    if (!isRecord(e) || typeof e.src !== "string" || typeof e.dst !== "string" || (e.skip !== undefined && typeof e.skip !== "boolean")) {
      fail(`${where}: every column needs a source and a target name`);
    }
    if (e.src.length > MAX_NAME_CHARS || e.dst.length > MAX_NAME_CHARS) fail(`${where}: a column name is longer than ${MAX_NAME_CHARS} characters`);
    return { src: e.src, dst: e.dst, ...(e.skip ? { skip: true } : {}) };
  });
  if (!entries.length) return undefined;
  const problem = columnMapProblem(entries);
  if (problem) fail(`${where}: ${problem}`);
  if (entries.every((e) => e.skip)) fail(`${where}: no column is used`);
  return entries;
}

// ── Export ──

/** One row of an export: what it reads, and the file — or, with Create single file, the sheet — it writes. */
export interface ExportItemPlan {
  /** As the row's Source column names it. */
  source: string;
  target: string;
  columns?: ColumnMapEntry[];
  read: { type: "table"; table: string; schema: string | null } | { type: "query"; sql: string };
}

export interface ExportJobPlan {
  format: ImpExpFileFormat;
  options: ExportFormatOptions;
  items: ExportItemPlan[];
  /** The one zip every file goes into, by the name it downloads as; null for none. */
  zip: string | null;
}

/** What a Query source's row is called, as DBGate names it. */
export const QUERY_SOURCE_NAME = "query";

function targetName(value: unknown, where: string): string {
  if (typeof value !== "string") fail(`${where}: the target must be a file name`);
  const problem = outputFileNameProblem(value);
  return problem ? fail(problem) : value;
}

/** A sheet of Create single file: Excel's own rules make any name one, and an empty one is the source's. */
function sheetName(value: unknown, source: string, where: string): string {
  const name = text(value, "", `${where}: the target`).trim();
  return name || source;
}

function zipName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail("zip must be an object");
  const name = targetName(value.name, "zip");
  return /\.zip$/i.test(name) ? name : `${name}.zip`;
}

/**
 * `POST /connections/:id/impexp/export`'s body. A Query source's SQL is taken as it is: whether it
 * may run is the route's to say, by the same rules as a typed query.
 */
export function parseExportJobRequest(raw: unknown, defaultSchema: string | null): ExportJobPlan {
  if (!isRecord(raw)) fail("Request body must be an object");
  if (!isImpExpFileFormat(raw.format)) fail("format is not one Export writes");
  const format = raw.format;
  const options = parseExportOptions(raw.options);
  const sheets = format === "xlsx" && options.xlsxSingleFile;
  const source = section(raw.source, "source");

  let items: ExportItemPlan[];
  if (source.type === "database") {
    const schema = source.schema === undefined || source.schema === null || source.schema === ""
      ? defaultSchema
      : text(source.schema, "", "schema");
    if (!Array.isArray(source.tables) || source.tables.length === 0) fail("Choose at least one table or view");
    if (source.tables.length > IMPEXP_MAX_ITEMS) fail(`At most ${IMPEXP_MAX_ITEMS} tables can be exported at once`);
    items = source.tables.map((t: unknown, i): ExportItemPlan => {
      if (!isRecord(t) || typeof t.name !== "string" || !t.name) fail(`Table ${i + 1} needs a name`);
      const table = text(t.name, "", "A table name");
      const where = `"${table}"`;
      return {
        source: table,
        target: sheets ? sheetName(t.target, table, where) : targetName(t.target, where),
        read: { type: "table", table, schema },
        ...withColumns(parseColumnMap(t.columns, where)),
      };
    });
  } else if (source.type === "query") {
    if (typeof source.sql !== "string" || !source.sql.trim()) fail("The query is empty");
    if (source.sql.length > IMPEXP_MAX_QUERY_CHARS) fail(`The query is longer than ${IMPEXP_MAX_QUERY_CHARS.toLocaleString("en-US")} characters`);
    items = [{
      source: QUERY_SOURCE_NAME,
      target: sheets ? sheetName(source.target, QUERY_SOURCE_NAME, "The query") : targetName(source.target, "The query"),
      read: { type: "query", sql: source.sql },
      ...withColumns(parseColumnMap(source.columns, "The query")),
    }];
  } else {
    fail("source.type must be database or query");
  }

  // Sheets that share a name are told apart by the workbook; files are not, and a zip or a folder
  // on Windows or macOS would not tell `A.csv` from `a.csv` either.
  if (!sheets) {
    const seen = new Set<string>();
    for (const item of items) {
      const key = item.target.toLowerCase();
      if (seen.has(key)) fail(`Two rows write to "${item.target}": give each its own file name`);
      seen.add(key);
    }
  }
  return { format, options, items, zip: zipName(raw.zip) };
}

function withColumns(columns: ColumnMapEntry[] | undefined): { columns?: ColumnMapEntry[] } {
  return columns ? { columns } : {};
}

// ── Import ──

/** One row of an import: the uploaded file it reads, and the table it writes. */
export interface ImportItemPlan {
  upload: string;
  /** As the row's Source column names it: the file's name without its extension. */
  source: string;
  target: string;
  action: ImportAction;
  columns?: ColumnMapEntry[];
}

export interface ImportJobPlan {
  format: ImportFileFormat;
  options: ImportFormatOptions;
  /** The schema every table is in; null for an engine without schemas. */
  schema: string | null;
  items: ImportItemPlan[];
}

/**
 * Why `name` cannot name a table Import writes, or null: Postgres keeps 63 bytes of a name and
 * would cut a longer one silently, MySQL and MariaDB refuse more than 64 characters.
 */
export function importTableNameProblem(name: string, type: DbType): string | null {
  if (!name.trim()) return "The target table needs a name";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return `"${name}" holds a control character`;
  if (type === "postgres" && Buffer.byteLength(name) > 63) return `"${name}" is longer than the 63 bytes Postgres keeps of a name`;
  if ((type === "mysql" || type === "mariadb") && [...name].length > 64) return `"${name}" is longer than the 64 characters a table name may have`;
  return null;
}

/** Import's reading options; one left out takes its default. */
export function parseImportOptions(value: unknown): ImportFormatOptions {
  const o = section(value, "options");
  const csv = section(o.csv, "options.csv");
  const d = DEFAULT_IMPORT_OPTIONS;
  return {
    csv: {
      delimiter: choice(csv.delimiter, ["", ...CSV_DELIMITERS.map((x) => x.value)] as const, d.csv.delimiter, "Delimiter"),
      header: flag(csv.header, d.csv.header, "Has header row"),
    },
    json: parseJsonOptions(o.json, d.json),
  };
}

/** `POST /impexp/uploads/:id/preview`'s body: how the file is read, and Configure columns of its row. */
export function parseImportPreviewRequest(raw: unknown): { format: ImportFileFormat; options: ImportFormatOptions; columns?: ColumnMapEntry[] } {
  if (!isRecord(raw)) fail("Request body must be an object");
  if (!isImportFileFormat(raw.format)) fail("format is not one Import reads");
  return { format: raw.format, options: parseImportOptions(raw.options), ...withColumns(parseColumnMap(raw.columns, "Preview")) };
}

/** `POST /connections/:id/impexp/import`'s body. */
export function parseImportJobRequest(raw: unknown, type: DbType, defaultSchema: string | null): ImportJobPlan {
  if (!isRecord(raw)) fail("Request body must be an object");
  if (!isImportFileFormat(raw.format)) fail("format is not one Import reads");
  const format = raw.format;
  const schema = raw.schema === undefined || raw.schema === null || raw.schema === "" ? defaultSchema : text(raw.schema, "", "schema");
  if (!Array.isArray(raw.files) || raw.files.length === 0) fail("Add at least one file");
  if (raw.files.length > IMPEXP_MAX_ITEMS) fail(`At most ${IMPEXP_MAX_ITEMS} files can be imported at once`);
  const items = raw.files.map((f: unknown, i): ImportItemPlan => {
    if (!isRecord(f)) fail(`File ${i + 1} must be an object`);
    if (!isUploadId(f.upload)) fail(`File ${i + 1}: upload is not the id of an uploaded file`);
    const source = text(f.source, "", `File ${i + 1}: source`).trim() || `file ${i + 1}`;
    const where = `"${source}"`;
    const target = text(f.target, "", `${where}: the target`);
    const problem = importTableNameProblem(target, type);
    if (problem) fail(`${where}: ${problem}`);
    if (!isImportAction(f.action)) fail(`${where}: action is not one of its choices`);
    return { upload: f.upload, source, target, action: f.action, ...withColumns(parseColumnMap(f.columns, where)) };
  });
  return { format, options: parseImportOptions(raw.options), schema, items };
}
