/**
 * DBGate's Import/Export tab: a job on the server that moves rows between one database and files,
 * one table at a time, while the tab reads its progress. Export reads tables or a query into files
 * the browser then downloads; Import reads uploaded files into tables.
 *
 * Shared by the tab and the routes: the storage types and their options as DBGate names them, the
 * requests that start a job, and what a job reports back.
 */

// ── Storage types ──

/**
 * The file formats, in the order DBGate lists them (its own three, then its CSV, Excel and XML
 * plugins). `import` marks the ones a file can be read from here; Excel and XML only export.
 */
export const IMPEXP_FILE_FORMATS = [
  { id: "jsonl", label: "JSON lines/NDJSON file(s)", extension: "jsonl", import: true },
  { id: "json", label: "JSON file(s)", extension: "json", import: true },
  { id: "sql", label: "SQL file(s)", extension: "sql", import: false },
  { id: "csv", label: "CSV file(s)", extension: "csv", import: true },
  { id: "xlsx", label: "MS Excel file(s)", extension: "xlsx", import: false },
  { id: "xml", label: "XML file(s)", extension: "xml", import: false },
] as const;

export type ImpExpFileFormat = (typeof IMPEXP_FILE_FORMATS)[number]["id"];
export type ImportFileFormat = "csv" | "json" | "jsonl";

export function impExpFileFormat(id: ImpExpFileFormat): (typeof IMPEXP_FILE_FORMATS)[number] {
  return IMPEXP_FILE_FORMATS.find((f) => f.id === id)!;
}

export function isImpExpFileFormat(value: unknown): value is ImpExpFileFormat {
  return typeof value === "string" && IMPEXP_FILE_FORMATS.some((f) => f.id === value);
}

export function isImportFileFormat(value: unknown): value is ImportFileFormat {
  return value === "csv" || value === "json" || value === "jsonl";
}

/** The format a file is read as, from its name, when the source list is empty: as DBGate picks one. */
export function importFormatOfFileName(name: string): ImportFileFormat | null {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  if (ext === "csv" || ext === "tsv" || ext === "txt") return "csv";
  if (ext === "json") return "json";
  if (ext === "jsonl" || ext === "ndjson") return "jsonl";
  return null;
}

// ── Format options ──

export type CsvDelimiter = "," | ";" | "\t" | "|";
export type CsvRecordDelimiter = "\n" | "\r\n" | "\r";
export type CsvBooleanFormat = "true_false" | "true_false_upper" | "1_0";

export const CSV_DELIMITERS: readonly { value: CsvDelimiter; label: string }[] = [
  { value: ",", label: "Comma (,)" },
  { value: ";", label: "Semicolon (;)" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe (|)" },
];

export const CSV_RECORD_DELIMITERS: readonly { value: CsvRecordDelimiter; label: string }[] = [
  { value: "\n", label: "LF" },
  { value: "\r", label: "CR" },
  { value: "\r\n", label: "CRLF" },
];

export const CSV_BOOLEAN_FORMATS: readonly { value: CsvBooleanFormat; label: string; words: readonly [string, string] }[] = [
  { value: "true_false", label: "true/false", words: ["true", "false"] },
  { value: "true_false_upper", label: "TRUE/FALSE", words: ["TRUE", "FALSE"] },
  { value: "1_0", label: "1/0", words: ["1", "0"] },
];

/** CSV as a file is written. */
export interface CsvWriteOptions {
  delimiter: CsvDelimiter;
  /** Every value in quotes; NULL stays an empty field, as Postgres's COPY leaves it. */
  quoted: boolean;
  header: boolean;
  bom: boolean;
  recordDelimiter: CsvRecordDelimiter;
  booleanFormat: CsvBooleanFormat;
}

/** CSV as a file is read. `""` is Auto-detect. */
export interface CsvReadOptions {
  delimiter: CsvDelimiter | "";
  header: boolean;
}

/** DBGate's JSON options, the same both ways. */
export interface JsonOptions {
  style: "array" | "object";
  /** The key each row is found under, in "Object" style; `_key` when empty. */
  keyField: string;
  /** The key of the outermost object the rows are under; none when empty. */
  rootField: string;
}

export interface XmlWriteOptions {
  /** `root` when empty. */
  rootElement: string;
  /** `row` when empty. */
  itemElement: string;
}

export interface ExportFormatOptions {
  csv: CsvWriteOptions;
  json: JsonOptions;
  xml: XmlWriteOptions;
  /** One `data.xlsx` with a sheet for each table, rather than a file for each. */
  xlsxSingleFile: boolean;
}

export interface ImportFormatOptions {
  csv: CsvReadOptions;
  json: JsonOptions;
}

export const DEFAULT_KEY_FIELD = "_key";

export const DEFAULT_EXPORT_OPTIONS: ExportFormatOptions = {
  csv: { delimiter: ",", quoted: false, header: true, bom: false, recordDelimiter: "\n", booleanFormat: "true_false" },
  json: { style: "array", keyField: "", rootField: "" },
  xml: { rootElement: "", itemElement: "" },
  xlsxSingleFile: false,
};

export const DEFAULT_IMPORT_OPTIONS: ImportFormatOptions = {
  csv: { delimiter: "", header: true },
  json: { style: "array", keyField: "", rootField: "" },
};

/** The one workbook Create single file writes. */
export const XLSX_SINGLE_FILE_NAME = "data.xlsx";

// ── Columns ──

/**
 * One row of Configure columns: `src` goes out as `dst`, unless it is not used. An empty mapping
 * copies every column as it is.
 */
export interface ColumnMapEntry {
  src: string;
  dst: string;
  skip?: boolean;
}

/** Why a mapping cannot be used — DBGate's wording — or null when it can. */
export function columnMapProblem(entries: readonly ColumnMapEntry[]): string | null {
  const used = entries.filter((e) => !e.skip);
  if (used.some((e) => !e.src.trim() || !e.dst.trim())) return "Source and target columns must be defined";
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const e of used) {
    if (seen.has(e.dst)) duplicates.add(e.dst);
    seen.add(e.dst);
  }
  return duplicates.size ? `Target columns must be unique, duplicates found: ${[...duplicates].join(", ")}` : null;
}

// ── Starting a job ──

/** Rows of one job at most. A database has rarely more tables than this worth one run. */
export const IMPEXP_MAX_ITEMS = 1_000;

/** Columns one mapping may list. */
export const IMPEXP_MAX_MAPPED_COLUMNS = 4_096;

/** Characters of SQL a Query source may have. */
export const IMPEXP_MAX_QUERY_CHARS = 1_000_000;

/** A file the tab may upload for Import: what Bun takes in one request body by default. */
export const IMPORT_MAX_FILE_BYTES = 128 * 1024 * 1024;

/**
 * `POST /api/db/connections/:id/impexp/export[?database=]`: the tables of one schema, or one query,
 * into files. `target` is each file's name — or, with Create single file, its sheet's.
 */
export interface ExportJobRequest {
  source:
    | { type: "database"; schema?: string; tables: { name: string; target: string; columns?: ColumnMapEntry[] }[] }
    | { type: "query"; sql: string; target: string; columns?: ColumnMapEntry[] };
  format: ImpExpFileFormat;
  options: ExportFormatOptions;
  /** Put every file into one zip of this name. */
  zip?: { name: string } | null;
}

/** DBGate's actions for a table rows are imported into. */
export const IMPORT_ACTIONS = [
  { id: "createTable", label: "Create table/append" },
  { id: "appendData", label: "Append data" },
  { id: "truncate", label: "Truncate and import" },
  { id: "dropCreateTable", label: "Drop and create table" },
] as const;

export type ImportAction = (typeof IMPORT_ACTIONS)[number]["id"];

export function isImportAction(value: unknown): value is ImportAction {
  return typeof value === "string" && IMPORT_ACTIONS.some((a) => a.id === value);
}

/** `POST /api/db/connections/:id/impexp/import[?database=]`: uploaded files into tables of one schema. */
export interface ImportJobRequest {
  format: ImportFileFormat;
  options: ImportFormatOptions;
  schema?: string;
  files: { upload: string; source: string; target: string; action: ImportAction; columns?: ColumnMapEntry[] }[];
}

export interface ImpExpJobStarted {
  jobId: string;
}

// ── A job's progress ──

export type ImpExpItemState = "queued" | "running" | "done" | "error" | "stopped";
export type ImpExpJobState = "running" | "done" | "error" | "stopped";
export type ImpExpMessageLevel = "info" | "warning" | "error" | "debug";

export interface ImpExpItemStatus {
  source: string;
  target: string;
  state: ImpExpItemState;
  rowsRead: number;
  rowsWritten: number;
  error?: string;
}

export interface ImpExpMessage {
  level: ImpExpMessageLevel;
  text: string;
  /** Epoch milliseconds. */
  time: number;
}

export interface ImpExpOutputFile {
  name: string;
  size: number;
}

/**
 * `GET /api/db/impexp/jobs/:id[?since=n]`: the job as it stands. `messages` are the ones from the
 * `since`-th on, so the tab asks only for what it has not seen; `messageCount` is how many there are.
 */
export interface ImpExpJobStatus {
  id: string;
  kind: "export" | "import";
  state: ImpExpJobState;
  items: ImpExpItemStatus[];
  messages: ImpExpMessage[];
  messageCount: number;
  files: ImpExpOutputFile[];
  startedAt: number;
  endedAt: number | null;
}

/** How often the tab asks for a running job's progress. */
export const IMPEXP_POLL_MS = 1_000;

// ── Uploads ──

/** `PUT /api/db/impexp/uploads?name=`: the file is on the server under `id`. */
export interface ImportUpload {
  id: string;
  name: string;
  size: number;
}

/** Rows Preview shows, as DBGate's does. */
export const IMPORT_PREVIEW_ROWS = 100;

/** `POST /api/db/impexp/uploads/:id/preview`: the first rows as Import would read them. */
export interface ImportPreview {
  columns: string[];
  rows: unknown[][];
  warnings: string[];
}

// ── Names ──

/**
 * Why `name` cannot name a file of a job, or null when it can: a plain name with no folder in it.
 * The server keeps the files under names of its own; this one is what the download and the zip
 * entry are called, and a zip entry holding `/` or `..` would be unpacked outside its folder.
 */
export function outputFileNameProblem(name: string): string | null {
  if (!name.trim()) return "The file needs a name";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return `"${name}" holds a control character`;
  if (/[/\\]/.test(name)) return `"${name}" is a path; give a file name`;
  if (/^\.\.?$/.test(name.trim())) return `"${name}" is not a file name`;
  if (new TextEncoder().encode(name).length > 255) return `"${name.slice(0, 40)}…" is longer than a file name may be`;
  return null;
}

/** The file a row writes by default: DBGate's `<source>.<extension>`. */
export function defaultExportFileName(source: string, format: ImpExpFileFormat): string {
  const base = source.replace(/[/\\]/g, "_") || "export";
  return `${base}.${impExpFileFormat(format).extension}`;
}

/** DBGate's default name for the zip, `zip-archive-YYYY-MM-DD-HH-mm-ss.zip`, from the local time `at`. */
export function defaultZipName(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `zip-archive-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}.zip`;
}

/** A source file's row name: its name without the extension, as DBGate shows it. */
export function importSourceName(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, "") || fileName;
}
