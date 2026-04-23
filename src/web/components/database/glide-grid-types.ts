/** Shared types for Glide Data Grid wrapper used by database-viewer and sqlite-viewer */

/** Unified column schema — superset of DbColumnInfo and sqlite ColumnInfo */
export interface GridColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue?: string | null;
  fk?: { table: string; column: string } | null;
}

/** Unified props interface for the Glide Data Grid wrapper component */
export interface GlideGridProps {
  /** Column names in display order */
  columns: string[];
  /** Row data array (current page) */
  rows: Record<string, unknown>[];
  /** Total row count across all pages */
  total: number;
  /** Rows per page */
  limit: number;
  /** Column schema metadata */
  schema: GridColumnSchema[];
  /** Whether data is currently loading */
  loading: boolean;
  /** Current page number (1-based) */
  page: number;
  onPageChange: (page: number) => void;
  /** Cell edit: (pkColumn, pkValue, editedColumn, newValue) */
  onCellUpdate: (pkCol: string, pkVal: unknown, col: string, val: unknown) => void;
  onRowDelete?: (pkCol: string, pkVal: unknown) => void;
  onBulkDelete?: (pkCol: string, pkValues: unknown[]) => void;
  onInsertRow?: (values: Record<string, unknown>) => Promise<void>;
  /** Current sort column */
  orderBy?: string | null;
  orderDir?: "ASC" | "DESC";
  onToggleSort?: (column: string) => void;
  onClearSort?: () => void;
  /** Per-column ILIKE filters (server-side) */
  columnFilters?: Record<string, string>;
  onColumnFilter?: (filters: Record<string, string>) => void;
  /** Metadata for export/viewer features */
  connectionId?: number;
  selectedTable?: string | null;
  selectedSchema?: string;
  connectionName?: string;
}

/** Threshold in bytes for showing cell viewer (eye button) */
export const LARGE_THRESHOLD = 200;

/** Check if a cell value needs the large data viewer */
export function needsViewer(val: unknown): boolean {
  if (val == null) return false;
  if (typeof val === "object") return true;
  const s = String(val);
  if (s.length >= LARGE_THRESHOLD) return true;
  const trimmed = s.trimStart();
  if ((trimmed[0] === "{" || trimmed[0] === "[") && (trimmed.endsWith("}") || trimmed.endsWith("]"))) return true;
  if (trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && trimmed.endsWith(">"))) return true;
  return false;
}

/** Format cell value for display — JSON-stringify objects, otherwise String() */
export function formatCellValue(val: unknown): string {
  if (val == null) return "NULL";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/** Detect language from cell content for syntax highlighting in viewer */
export function detectLang(text: string): string {
  const t = text.trimStart();
  if (t[0] === "{" || t[0] === "[") {
    try { JSON.parse(t); return "json"; } catch { /* not json */ }
  }
  if (t.startsWith("<?xml") || (t.startsWith("<") && /<\/\w+>/.test(t))) return "xml";
  if (t.startsWith("---") || /^\w+:\s/m.test(t)) return "yaml";
  return "plaintext";
}
