/**
 * DBGate's Import/Export tab as data: the form the tab edits — where rows come from, where they
 * go, and how each source maps to its target — kept in the tab's metadata so it survives a reload,
 * and the requests Run sends. Export reads tables or a query into files; Import reads uploaded
 * files into tables. One side is always a database, so the form holds one: the source of an
 * export, the target of an import (Database → Database is not offered).
 *
 * Pure: it imports no store, so it runs under `bun:test`.
 */
import type { DbTarget } from "@/lib/db-tabs";
import {
  CSV_BOOLEAN_FORMATS, CSV_DELIMITERS, CSV_RECORD_DELIMITERS, DEFAULT_EXPORT_OPTIONS, DEFAULT_IMPORT_OPTIONS,
  IMPEXP_FILE_FORMATS, IMPEXP_MAX_ITEMS, IMPEXP_MAX_MAPPED_COLUMNS, IMPORT_MAX_FILE_BYTES, defaultExportFileName,
  defaultZipName, importFormatOfFileName, importSourceName, isImportAction, outputFileNameProblem,
  type ColumnMapEntry, type ExportFormatOptions, type ExportJobRequest, type ImpExpFileFormat, type ImpExpItemStatus,
  type ImpExpJobStatus, type ImpExpMessage, type ImpExpMessageLevel, type ImportAction, type ImportFileFormat,
  type ImportFormatOptions, type ImportJobRequest, type JsonOptions,
} from "../../../../shared/db-impexp";

// ─── Storage types ───────────────────────────────────────────────────────────

export type ImpExpSourceType = "database" | "query" | ImportFileFormat;
export type ImpExpTargetType = "database" | ImpExpFileFormat;

export interface StorageOption<T> {
  value: T;
  label: string;
}

/** DBGate's source Storage types: Database, the formats a file can be read from, then Query. */
export const SOURCE_TYPE_OPTIONS: readonly StorageOption<ImpExpSourceType>[] = [
  { value: "database", label: "Database" },
  ...IMPEXP_FILE_FORMATS.filter((f) => f.import).map((f) => ({ value: f.id as ImportFileFormat, label: f.label })),
  { value: "query", label: "Query" },
];

export function isFileSource(type: ImpExpSourceType): type is ImportFileFormat {
  return type !== "database" && type !== "query";
}

/** The target Storage types `source` can go to: files go into a database, a database or a query into files. */
export function targetTypeOptions(source: ImpExpSourceType): StorageOption<ImpExpTargetType>[] {
  return isFileSource(source)
    ? [{ value: "database", label: "Database" }]
    : IMPEXP_FILE_FORMATS.map((f) => ({ value: f.id, label: f.label }));
}

/** The file format a database or a query is exported to until another is picked: CSV, as in DBGate. */
const DEFAULT_FILE_TARGET: ImpExpFileFormat = "csv";

// ─── The form ────────────────────────────────────────────────────────────────

/** A database one side reads or writes, and on Postgres its schema — null for the list's default. */
export interface ImpExpDatabase {
  target: DbTarget | null;
  schema: string | null;
}

/** A file uploaded for Import: the server keeps it under `id`. */
export interface ImpExpUpload {
  id: string;
  name: string;
  size: number;
}

/** One row of Map source tables/files. */
export interface ImpExpRow {
  /** Unique in the list: a table, the query, a file's name less its extension, or the template row. */
  source: string;
  /** The Target box as typed; left out, or blank, it is the row's default. */
  target?: string;
  /** Import only; Create table/append when left out. */
  action?: ImportAction;
  /** Configure columns; left out, the source's columns are copied as they are. */
  columns?: ColumnMapEntry[];
  /** Import only: the file the row reads. */
  upload?: ImpExpUpload;
}

export interface ImpExpForm {
  sourceType: ImpExpSourceType;
  targetType: ImpExpTargetType;
  /** The database side: the source of an export, the target of an import. */
  db: ImpExpDatabase;
  /** A Query source's SQL. */
  sql: string;
  rows: ImpExpRow[];
  exportOptions: ExportFormatOptions;
  importOptions: ImportFormatOptions;
  /** Export to ZIP file. */
  zip: boolean;
  /** The zip's name as typed; blank takes DBGate's dated name when Run is pressed. */
  zipName: string;
}

/**
 * The row Import on a table starts with, shown as "(not selected)": it holds the table, and the
 * first file added takes it over — DBGate's `__TEMPLATE__`.
 */
export const TEMPLATE_SOURCE = "__TEMPLATE__";

/** The one row of a Query source that names none of its own. */
export const QUERY_SOURCE = "query";

export function newImpExpForm(init: Partial<ImpExpForm> = {}): ImpExpForm {
  return {
    sourceType: "database",
    targetType: DEFAULT_FILE_TARGET,
    db: { target: null, schema: null },
    sql: "",
    rows: [],
    exportOptions: DEFAULT_EXPORT_OPTIONS,
    importOptions: DEFAULT_IMPORT_OPTIONS,
    zip: false,
    zipName: "",
    ...init,
  };
}

export const isImportForm = (form: ImpExpForm): boolean => isFileSource(form.sourceType);

// ─── Where it was opened ─────────────────────────────────────────────────────

/**
 * Export of what a table's grid shows, as DBGate fills it in: the grid's SELECT — its filters and
 * sort, no paging — under the table's name, and its visible columns when some are hidden.
 */
export function gridExportForm(db: ImpExpDatabase, table: string, sql: string, visibleColumns?: readonly string[]): ImpExpForm {
  const columns = visibleColumns?.length ? { columns: visibleColumns.map((c) => ({ src: c, dst: c })) } : {};
  return newImpExpForm({ sourceType: "query", db, sql, rows: [{ source: table || QUERY_SOURCE, ...columns }] });
}

/** Export of tables or views picked in the tree; none yet for a database. */
export function databaseExportForm(db: ImpExpDatabase, tables: readonly string[] = []): ImpExpForm {
  return setTables(newImpExpForm({ db }), tables);
}

/** Import of CSV files into a database, or into one table through the template row. */
export function importIntoForm(db: ImpExpDatabase, table?: string): ImpExpForm {
  return newImpExpForm({
    sourceType: "csv", targetType: "database", db,
    rows: table ? [{ source: TEMPLATE_SOURCE, target: table }] : [],
  });
}

// ─── Editing it ──────────────────────────────────────────────────────────────

/**
 * The source's Storage type changed. Its rows go with it — tables, a query and files are different
 * lists — except between two file formats, whose files are then read the new way. The target
 * follows: a database for files, a file format for a database or a query.
 */
export function setSourceType(form: ImpExpForm, type: ImpExpSourceType): ImpExpForm {
  if (type === form.sourceType) return form;
  const rows = isFileSource(type) && isFileSource(form.sourceType) ? form.rows : type === "query" ? [{ source: QUERY_SOURCE }] : [];
  const targetType: ImpExpTargetType = isFileSource(type)
    ? "database"
    : form.targetType === "database" ? DEFAULT_FILE_TARGET : form.targetType;
  return { ...form, sourceType: type, targetType, rows };
}

/** The target's Storage type; one the source cannot go to is refused. */
export function setTargetType(form: ImpExpForm, type: ImpExpTargetType): ImpExpForm {
  if (type === form.targetType || !targetTypeOptions(form.sourceType).some((o) => o.value === type)) return form;
  return { ...form, targetType: type };
}

/**
 * Another server, database or schema. A Database source's tables belong to the one it had, so
 * they go; a query and an import's files stay.
 */
export function setDatabase(form: ImpExpForm, db: ImpExpDatabase): ImpExpForm {
  return { ...form, db, rows: form.sourceType === "database" ? [] : form.rows };
}

/** The Tables / views box: these, in this order, each keeping what was set on its row. */
export function setTables(form: ImpExpForm, names: readonly string[]): ImpExpForm {
  const byName = new Map(form.rows.map((r) => [r.source, r]));
  const rows = [...new Set(names)].slice(0, IMPEXP_MAX_ITEMS).map((n) => byName.get(n) ?? { source: n });
  return { ...form, rows };
}

/** All tables, All views, All matviews: these added after the ones already chosen. */
export function addTables(form: ImpExpForm, names: readonly string[]): ImpExpForm {
  return setTables(form, [...form.rows.map((r) => r.source), ...names]);
}

/** A row's trash can. */
export function removeRow(form: ImpExpForm, source: string): ImpExpForm {
  return { ...form, rows: form.rows.filter((r) => r.source !== source) };
}

export function updateRow(form: ImpExpForm, source: string, change: Partial<Omit<ImpExpRow, "source">>): ImpExpForm {
  return { ...form, rows: form.rows.map((r) => (r.source === source ? { ...r, ...change } : r)) };
}

/** The uploads `next` no longer reads, which the server can let go of. */
export function droppedUploads(prev: ImpExpForm, next: ImpExpForm): string[] {
  const kept = new Set(next.rows.flatMap((r) => (r.upload ? [r.upload.id] : [])));
  return prev.rows.flatMap((r) => (r.upload && !kept.has(r.upload.id) ? [r.upload.id] : []));
}

/**
 * Uploaded files become rows, named by the file without its extension; a file named like a row
 * already there replaces that row's file and keeps its settings. Into a list holding no file yet,
 * the first file's extension picks the Storage type; later files are read as the type in use, as
 * DBGate reads them. The first file takes over the template row, with its table and action.
 */
export function addUploads(form: ImpExpForm, uploads: readonly ImpExpUpload[]): ImpExpForm {
  if (!isFileSource(form.sourceType) || uploads.length === 0) return form;
  const template = form.rows.find((r) => r.source === TEMPLATE_SOURCE);
  let rows = form.rows.filter((r) => r.source !== TEMPLATE_SOURCE);
  const sourceType = rows.length === 0 ? importFormatOfFileName(uploads[0]!.name) ?? form.sourceType : form.sourceType;
  for (const upload of uploads) {
    const source = importSourceName(upload.name);
    if (rows.some((r) => r.source === source)) {
      rows = rows.map((r) => (r.source === source ? { ...r, upload } : r));
    } else if (rows.length < IMPEXP_MAX_ITEMS) {
      const fromTemplate = template && rows.length === 0
        ? { ...(template.target ? { target: template.target } : {}), ...(template.action ? { action: template.action } : {}) }
        : {};
      rows = [...rows, { source, upload, ...fromTemplate }];
    }
  }
  return { ...form, sourceType, rows };
}

// ─── What a row shows ────────────────────────────────────────────────────────

/** The Target box before anything is typed in it: DBGate's defaults. */
export function defaultRowTarget(form: ImpExpForm, row: ImpExpRow): string {
  if (isFileSource(form.sourceType)) return row.source === TEMPLATE_SOURCE ? "" : row.source;
  const format = form.targetType === "database" ? DEFAULT_FILE_TARGET : form.targetType;
  // With Create single file, the target is the sheet.
  if (format === "xlsx" && form.exportOptions.xlsxSingleFile) return row.source;
  return defaultExportFileName(row.source, format);
}

/** What a row writes to: the Target box, or its default while the box is blank. */
export function rowTarget(form: ImpExpForm, row: ImpExpRow): string {
  return row.target?.trim() ? row.target : defaultRowTarget(form, row);
}

/** The Source cell: the template row reads "(not selected)", as DBGate shows it. */
export function rowSourceLabel(row: ImpExpRow): string {
  return row.source === TEMPLATE_SOURCE ? "(not selected)" : row.source;
}

/** The Columns cell's link. */
export function columnsLinkText(columns: readonly ColumnMapEntry[] | undefined): string {
  const used = (columns ?? []).filter((c) => !c.skip).length;
  return used > 0 ? `(${used} columns)` : "(copy from source)";
}

/** DBGate's tab title, `<source>-><target>(<rows>)`: a database by its name ("DB" without one), a query as "Query", files by their format. */
export function impExpTitle(form: ImpExpForm, databaseName: string | null | undefined): string {
  const db = databaseName || "DB";
  const source = form.sourceType === "database" ? db : form.sourceType === "query" ? "Query" : form.sourceType.toUpperCase();
  const target = form.targetType === "database" ? db : form.targetType.toUpperCase();
  return `${source}->${target}(${form.rows.length})`;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

/** Why Run cannot start yet, for its tooltip; null when it can. A readonly connection takes no import. */
export function runBlocker(form: ImpExpForm, readonly: boolean): string | null {
  const importing = isFileSource(form.sourceType);
  if (!form.db.target) return importing ? "Choose the database to import into" : "Choose the database to export from";
  if (importing) {
    if (readonly) return "The connection is read only: nothing can be imported into it";
    return form.rows.some((r) => r.upload) ? null : "Add at least one file";
  }
  if (form.sourceType === "query" && !form.sql.trim()) return "The query is empty";
  if (form.rows.length === 0) return "Choose at least one table or view";
  // Sheets of one workbook may share a name; files may not.
  if (!(form.targetType === "xlsx" && form.exportOptions.xlsxSingleFile)) {
    const seen = new Set<string>();
    for (const row of form.rows) {
      const name = rowTarget(form, row);
      const problem = outputFileNameProblem(name);
      if (problem) return problem;
      // A zip, or a folder on Windows or macOS, would not tell `A.csv` from `a.csv`.
      if (seen.has(name.toLowerCase())) return `Two rows write to "${name}": give each its own file name`;
      seen.add(name.toLowerCase());
    }
  }
  return form.zip && form.zipName.trim() ? outputFileNameProblem(form.zipName.trim()) : null;
}

const mapped = (row: ImpExpRow | undefined): { columns?: ColumnMapEntry[] } => (row?.columns?.length ? { columns: row.columns } : {});

/**
 * The export Run starts, with the source names of its rows in its order. `schema` is the one the
 * Schema box shows; `now` names a zip left unnamed.
 */
export function exportRequest(form: ImpExpForm, schema: string | null, now: Date): { request: ExportJobRequest; rows: string[] } {
  const queryRow = form.rows[0] ?? { source: QUERY_SOURCE };
  const source: ExportJobRequest["source"] = form.sourceType === "query"
    ? { type: "query", sql: form.sql, target: rowTarget(form, queryRow), ...mapped(queryRow) }
    : {
        type: "database",
        ...(schema ? { schema } : {}),
        tables: form.rows.map((r) => ({ name: r.source, target: rowTarget(form, r), ...mapped(r) })),
      };
  return {
    request: {
      source,
      format: form.targetType === "database" ? DEFAULT_FILE_TARGET : form.targetType,
      options: form.exportOptions,
      zip: form.zip ? { name: form.zipName.trim() || defaultZipName(now) } : null,
    },
    rows: form.sourceType === "query" ? [queryRow.source] : form.rows.map((r) => r.source),
  };
}

/** The import Run starts: every row holding a file, with their source names in its order. */
export function importRequest(form: ImpExpForm, schema: string | null): { request: ImportJobRequest; rows: string[] } {
  const files = form.rows.filter((r): r is ImpExpRow & { upload: ImpExpUpload } => !!r.upload);
  return {
    request: {
      format: isFileSource(form.sourceType) ? form.sourceType : "csv",
      options: form.importOptions,
      ...(schema ? { schema } : {}),
      files: files.map((r) => ({
        upload: r.upload.id, source: r.source, target: rowTarget(form, r), action: r.action ?? "createTable", ...mapped(r),
      })),
    },
    rows: files.map((r) => r.source),
  };
}

/** Why a file is not uploaded at all, said in the browser; null when it can go. */
export function uploadProblem(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `${file.name} is empty`;
  if (file.size > IMPORT_MAX_FILE_BYTES) {
    return `${file.name} is larger than ${IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB, the most one file can be`;
  }
  return null;
}

// ─── Progress ────────────────────────────────────────────────────────────────

const count = (n: number): string => n.toLocaleString("en-US");

/** The Status cell's words, as DBGate puts them. */
export function itemStatusText(item: ImpExpItemStatus): string {
  switch (item.state) {
    case "queued":
      return "Queued";
    case "running":
      if (item.rowsWritten) return `${count(item.rowsWritten)} rows written`;
      return item.rowsRead ? `${count(item.rowsRead)} rows read` : "Running";
    case "done": {
      const n = item.rowsWritten || item.rowsRead;
      return n ? `${count(n)} rows written` : "Done";
    }
    case "error":
      return "Error";
    case "stopped":
      return "Stopped";
  }
}

/** The Messages pane's switches, in DBGate's order; Debug starts off. */
export const MESSAGE_LEVELS: readonly { level: ImpExpMessageLevel; label: string }[] = [
  { level: "debug", label: "Debug" },
  { level: "info", label: "Info" },
  { level: "warning", label: "Warning" },
  { level: "error", label: "Error" },
];

export const DEFAULT_SHOWN_LEVELS: readonly ImpExpMessageLevel[] = ["info", "warning", "error"];

/** The messages the switches and the "Filter log messages" box let through. */
export function filterMessages<T extends ImpExpMessage>(messages: readonly T[], shown: readonly ImpExpMessageLevel[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return messages.filter((m) => shown.includes(m.level) && (!q || m.text.toLowerCase().includes(q)));
}

/** DBGate's Delta and Duration: "0", milliseconds under a second, tenths under ten, whole seconds after. */
export function formatDuration(ms: number): string {
  if (ms === 0) return "0";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.round(ms / 1000)} s`;
}

/** The Time column: the local clock, `HH:mm:ss`. */
export function messageClock(time: number): string {
  const d = new Date(time);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface MessageLine extends ImpExpMessage {
  /** Its place in the whole log, which filtering leaves as it is. */
  number: number;
  /** Since the log's first message. */
  delta: string;
  /** Since the message before it in the log; "n/a" for the first. */
  duration: string;
}

/** The Messages table: Number, Delta and Duration taken over the whole log, then the switches and the filter applied. */
export function messageLines(messages: readonly ImpExpMessage[], shown: readonly ImpExpMessageLevel[], query: string): MessageLine[] {
  const first = messages[0]?.time ?? 0;
  const lines = messages.map((m, i) => ({
    ...m,
    number: i + 1,
    delta: formatDuration(m.time - first),
    duration: i === 0 ? "n/a" : formatDuration(m.time - messages[i - 1]!.time),
  }));
  return filterMessages(lines, shown, query);
}

/** How many messages of each level the log holds, for the switches. */
export function levelCounts(messages: readonly ImpExpMessage[]): Record<ImpExpMessageLevel, number> {
  const counts: Record<ImpExpMessageLevel, number> = { debug: 0, info: 0, warning: 0, error: 0 };
  for (const m of messages) counts[m.level]++;
  return counts;
}

// ─── The job a tab follows ───────────────────────────────────────────────────

/** The job Run started last, kept in the tab's metadata so a reload follows it again. */
export interface ImpExpJobRef {
  id: string;
  kind: "export" | "import";
  /** The source names of the rows it was started with, in its order: the n-th is its n-th item. */
  rows: string[];
}

export function readJobRef(raw: unknown): ImpExpJobRef | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !/^[\w-]{1,64}$/.test(raw.id)) return null;
  if (raw.kind !== "export" && raw.kind !== "import") return null;
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).filter((r): r is string => typeof r === "string" && r.length <= MAX_NAME);
  return { id: raw.id, kind: raw.kind, rows: rows.slice(0, IMPEXP_MAX_ITEMS) };
}

/** Each row's line of the job's progress, by the row's source name; a row added since has none. */
export function itemsByRow(job: ImpExpJobRef | null, items: readonly ImpExpItemStatus[]): Map<string, ImpExpItemStatus> {
  const byRow = new Map<string, ImpExpItemStatus>();
  job?.rows.forEach((source, i) => {
    const item = items[i];
    if (item) byRow.set(source, item);
  });
  return byRow;
}

/** How a job just started stands until its first report comes back: running, every row queued. */
export function startingStatus(id: string, kind: ImpExpJobRef["kind"], rows: readonly string[], now: number): ImpExpJobStatus {
  return {
    id, kind, state: "running",
    items: rows.map((source) => ({ source, target: "", state: "queued", rowsRead: 0, rowsWritten: 0 })),
    messages: [], messageCount: 0, files: [], startedAt: now, endedAt: null,
  };
}

// ─── Configure columns ───────────────────────────────────────────────────────

/**
 * What Reset puts back, as DBGate builds it: the source's columns when there is no target table,
 * the target table's when the source's are not known, and with both the source's columns the
 * table has, by exact name.
 */
export function resetColumnMap(sourceColumns: readonly string[] | null, targetColumns: readonly string[] | null): ColumnMapEntry[] {
  if (sourceColumns && !targetColumns) return sourceColumns.map((c) => ({ src: c, dst: c }));
  if (targetColumns && !sourceColumns) return targetColumns.map((c) => ({ src: c, dst: c }));
  if (sourceColumns && targetColumns) {
    const inTarget = new Set(targetColumns);
    return sourceColumns.filter((c) => inTarget.has(c)).map((c) => ({ src: c, dst: c }));
  }
  return [];
}

export function sameColumnMap(a: readonly ColumnMapEntry[], b: readonly ColumnMapEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.src === b[i]!.src && e.dst === b[i]!.dst && !!e.skip === !!b[i]!.skip);
}

/** What OK keeps: nothing — copy from source — for an empty list or one Reset would give back. */
export function confirmedColumnMap(value: readonly ColumnMapEntry[], reset: readonly ColumnMapEntry[]): ColumnMapEntry[] | undefined {
  if (value.length === 0 || sameColumnMap(value, reset)) return undefined;
  return value.map((e) => ({ src: e.src, dst: e.dst, ...(e.skip ? { skip: true } : {}) }));
}

// ─── Reading it back ─────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_NAME = 1_000;
const str = (v: unknown, fallback = "", max = MAX_NAME): string => (typeof v === "string" && v.length <= max ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
function pick<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function readTarget(v: unknown): DbTarget | null {
  if (!isRecord(v)) return null;
  if (v.kind === "file") {
    const path = str(v.path, "", 4096);
    if (!path) return null;
    const projectName = str(v.projectName);
    return { kind: "file", path, ...(projectName ? { projectName } : {}) };
  }
  if (v.kind !== "connection" || typeof v.connectionId !== "number" || !Number.isInteger(v.connectionId) || v.connectionId <= 0) return null;
  const database = str(v.database);
  return { kind: "connection", connectionId: v.connectionId, ...(database ? { database } : {}) };
}

function readColumns(v: unknown): ColumnMapEntry[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > IMPEXP_MAX_MAPPED_COLUMNS) return undefined;
  const entries = v.filter(isRecord).map((e) => ({ src: str(e.src), dst: str(e.dst), ...(e.skip === true ? { skip: true } : {}) }));
  return entries.length ? entries : undefined;
}

function readUpload(v: unknown): ImpExpUpload | undefined {
  if (!isRecord(v) || !str(v.id) || typeof v.size !== "number") return undefined;
  return { id: str(v.id), name: str(v.name, "file"), size: v.size };
}

function readJson(v: unknown, d: JsonOptions): JsonOptions {
  const o = isRecord(v) ? v : {};
  return { style: pick(o.style, ["array", "object"] as const, d.style), keyField: str(o.keyField), rootField: str(o.rootField) };
}

/**
 * The form a tab's metadata holds, as it is now: anything missing or of the wrong shape takes its
 * default, since what comes back out of storage is whatever was put there.
 */
export function readImpExpForm(raw: unknown): ImpExpForm {
  const base = newImpExpForm();
  if (!isRecord(raw)) return base;
  const sourceType = pick(raw.sourceType, SOURCE_TYPE_OPTIONS.map((o) => o.value), base.sourceType);
  const targets = targetTypeOptions(sourceType).map((o) => o.value);
  const targetType = pick(raw.targetType, targets, isFileSource(sourceType) ? "database" : DEFAULT_FILE_TARGET);
  const db = isRecord(raw.db) ? raw.db : {};
  const seen = new Set<string>();
  const stored = (Array.isArray(raw.rows) ? raw.rows : []).filter(isRecord).flatMap((r): ImpExpRow[] => {
    const source = str(r.source);
    if (!source || seen.has(source) || seen.size >= IMPEXP_MAX_ITEMS) return [];
    seen.add(source);
    const target = typeof r.target === "string" ? str(r.target) : undefined;
    const columns = readColumns(r.columns);
    const upload = readUpload(r.upload);
    return [{
      source,
      ...(target !== undefined ? { target } : {}),
      ...(isImportAction(r.action) ? { action: r.action } : {}),
      ...(columns ? { columns } : {}),
      ...(upload ? { upload } : {}),
    }];
  });
  // A query is one row, whatever was stored.
  const rows = sourceType === "query" ? [stored[0] ?? { source: QUERY_SOURCE }] : stored;
  const e = isRecord(raw.exportOptions) ? raw.exportOptions : {};
  const csv = isRecord(e.csv) ? e.csv : {};
  const xml = isRecord(e.xml) ? e.xml : {};
  const de = DEFAULT_EXPORT_OPTIONS;
  const i = isRecord(raw.importOptions) ? raw.importOptions : {};
  const icsv = isRecord(i.csv) ? i.csv : {};
  const di = DEFAULT_IMPORT_OPTIONS;
  return {
    sourceType,
    targetType,
    db: { target: readTarget(db.target), schema: typeof db.schema === "string" && db.schema ? str(db.schema) || null : null },
    sql: str(raw.sql, "", 1_000_000),
    rows,
    exportOptions: {
      csv: {
        delimiter: pick(csv.delimiter, CSV_DELIMITERS.map((x) => x.value), de.csv.delimiter),
        quoted: bool(csv.quoted, de.csv.quoted),
        header: bool(csv.header, de.csv.header),
        bom: bool(csv.bom, de.csv.bom),
        recordDelimiter: pick(csv.recordDelimiter, CSV_RECORD_DELIMITERS.map((x) => x.value), de.csv.recordDelimiter),
        booleanFormat: pick(csv.booleanFormat, CSV_BOOLEAN_FORMATS.map((x) => x.value), de.csv.booleanFormat),
      },
      json: readJson(e.json, de.json),
      xml: { rootElement: str(xml.rootElement), itemElement: str(xml.itemElement) },
      xlsxSingleFile: bool(e.xlsxSingleFile, de.xlsxSingleFile),
    },
    importOptions: {
      csv: {
        delimiter: pick(icsv.delimiter, ["", ...CSV_DELIMITERS.map((x) => x.value)], di.csv.delimiter),
        header: bool(icsv.header, di.csv.header),
      },
      json: readJson(i.json, di.json),
    },
    zip: bool(raw.zip, false),
    zipName: str(raw.zipName),
  };
}
