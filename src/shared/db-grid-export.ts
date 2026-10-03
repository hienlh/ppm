/**
 * DBGate's Export ▸ from a table's data: every row the grid's filters leave, in its sort, written by
 * the server to one file the browser downloads. The formats are DBGate's quick exports, in the
 * order its menu lists them; their names, too, are its own.
 */
import type { FilterGroup, GridSort } from "./db-grid";

export const GRID_EXPORT_FORMATS = [
  { id: "json", label: "JSON", extension: "json" },
  { id: "jsonl", label: "JSON lines/NDJSON", extension: "jsonl" },
  { id: "sql", label: "SQL", extension: "sql" },
  { id: "csv", label: "CSV file", extension: "csv" },
  { id: "csvSemicolon", label: "CSV file (semicolon separated)", extension: "csv" },
  { id: "csvExcel", label: "CSV file for MS Excel", extension: "csv" },
  { id: "tsv", label: "TSV file (tab separated)", extension: "tsv" },
  { id: "xlsx", label: "MS Excel", extension: "xlsx" },
  { id: "xml", label: "XML file", extension: "xml" },
] as const;

export type GridExportFormat = (typeof GRID_EXPORT_FORMATS)[number]["id"];

const FORMAT_IDS = new Set<string>(GRID_EXPORT_FORMATS.map((f) => f.id));

export function isGridExportFormat(value: unknown): value is GridExportFormat {
  return typeof value === "string" && FORMAT_IDS.has(value);
}

export function gridExportFormat(id: GridExportFormat): (typeof GRID_EXPORT_FORMATS)[number] {
  return GRID_EXPORT_FORMATS.find((f) => f.id === id)!;
}

/** Most columns one export may name. A table has far fewer: Postgres stops at 1,600. */
export const GRID_EXPORT_MAX_COLUMNS = 4_096;

/**
 * `POST /connections/:id/grid/export`: what the grid shows, without its paging. `columns` are the
 * ones it shows, in its order, hidden ones left out; every one must be a column of the table.
 */
export interface GridExportRequest {
  table: string;
  schema?: string;
  filters?: FilterGroup[];
  anyColumn?: FilterGroup[];
  sort?: GridSort[];
  columns: string[];
  format: GridExportFormat;
}

/**
 * The answer: the file is ready to download from `GET /api/db/grid-export/<ticket>`, once, within
 * `GRID_EXPORT_TICKET_TTL_MS`. The rows are read as the download goes; nothing is written to disk.
 */
export interface GridExportTicket {
  ticket: string;
  fileName: string;
}

/**
 * `POST /connections/:id/grid/cell`: Save cell to file for a value the grid has only the start of —
 * bytes past the preview `/grid` sends. The row is found again by `key`, as `/grid` named its row
 * key; the file is downloaded by ticket, as an export's is, under `fileName`.
 */
export interface GridCellRequest {
  table: string;
  schema?: string;
  column: string;
  key: Record<string, unknown>;
  fileName: string;
}

/** Where an export's file is downloaded from: the ticket after it is the request's whole authority. */
export const GRID_EXPORT_DOWNLOAD_PREFIX = "/api/db/grid-export/";

export const gridExportDownloadUrl = (ticket: string): string => `${GRID_EXPORT_DOWNLOAD_PREFIX}${encodeURIComponent(ticket)}`;

/** How long a ticket waits for its download to start before the rows it holds are let go. */
export const GRID_EXPORT_TICKET_TTL_MS = 30_000;

/** `name` with what no file system takes replaced and no dot or space at either end; `fallback` when nothing is left. */
export function safeFileName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "") || fallback;
}

/** The file's name: the table's, as DBGate names a quick export — a table may be called anything, `/` and all. */
export function gridExportFileName(table: string, format: GridExportFormat): string {
  return `${safeFileName(table, "export")}.${gridExportFormat(format).extension}`;
}
