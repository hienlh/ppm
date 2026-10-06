/**
 * DBGate's Export ▸: the file for one of its quick export formats, written as the rows come off the
 * database. The text formats are in `grid-export-text.ts`, MS Excel in `grid-export-xlsx.ts`.
 */
import { textFile, type ExportColumn, type ExportTarget } from "./grid-export-text.ts";
import { xlsxFile } from "./grid-export-xlsx.ts";

export type { ExportColumn, ExportTarget };

/** The file, a piece at a time, from batches of rows holding the columns' values in order. */
export function exportFile(target: ExportTarget, columns: readonly ExportColumn[], batches: AsyncIterable<unknown[][]>): AsyncGenerator<Uint8Array> {
  return target.format === "xlsx" ? xlsxFile(columns, batches, target.table) : textFile(target, columns, batches);
}
