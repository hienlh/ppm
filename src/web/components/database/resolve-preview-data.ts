import { formatCellValue, detectLang } from "./glide-grid-types";
import type { PreviewData } from "./glide-data-preview-panel";

/** Reference to the previewed row/cell — content is derived from live rows, never snapshotted */
export interface PreviewSource {
  kind: "row" | "cell";
  rowIdx: number;
  /** Stable row identity when a PK exists, so reloads that reorder rows still resolve */
  pk: string | null;
  colName?: string;
}

interface ResolveContext {
  displayRows: Record<string, unknown>[];
  pkCol: string | null;
  selectedTable?: string | null;
  connectionId?: number;
}

/** Read the PK of a row as a string, or null when unavailable */
export function rowPk(row: Record<string, unknown>, pkCol: string | null): string | null {
  if (!pkCol) return null;
  const val = row[pkCol];
  return val == null ? null : String(val);
}

/**
 * Builds preview panel content from the CURRENT rows.
 * Called on every row change so an open preview reflects reloaded data.
 */
export function resolvePreviewData(source: PreviewSource | null, ctx: ResolveContext): PreviewData | null {
  if (!source) return null;
  const { displayRows, pkCol, selectedTable, connectionId } = ctx;
  const { kind, rowIdx, pk, colName } = source;

  // PK lookup first — row order/index can change between reloads
  const byPk = pkCol && pk !== null ? displayRows.find((r) => rowPk(r, pkCol) === pk) : undefined;
  const row = byPk ?? displayRows[rowIdx];
  if (!row) return null;

  const table = selectedTable ?? "";
  const suffix = table ? ` — ${table}` : "";

  if (kind === "row") {
    return {
      title: pk ? `Row #${pk}${suffix}` : `Row${suffix}`,
      content: JSON.stringify(row, null, 2),
      language: "json",
      viewerKey: `${connectionId}:${table}:row:${pk ?? ""}`,
    };
  }

  if (!colName) return null;
  const val = formatCellValue(row[colName]);
  const label = pk ?? String(rowIdx);
  return {
    title: `${colName} #${label}${suffix}`,
    content: val,
    language: detectLang(val),
    viewerKey: `${connectionId}:${table}:${colName}:${label}`,
  };
}
