import { stat } from "node:fs/promises";
import { readXlsxSheet, XlsxReadError, type XlsxSheet } from "../../services/xlsx/xlsx-reader.ts";

/** Largest workbook the preview opens. */
export const XLSX_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

/**
 * One sheet of the workbook at `abs`, for both `xlsx-sheet` routes. The caller has already held
 * the path to what it may read; this gates the type and size before reading it into memory.
 */
export async function readXlsxPreview(abs: string, sheetParam: string | undefined): Promise<XlsxSheet> {
  const st = await stat(abs);
  if (!st.isFile()) throw new XlsxReadError("Not a file.");
  if (st.size > XLSX_PREVIEW_MAX_BYTES) throw new XlsxReadError("File too large to preview.", 413);
  const sheet = sheetParam ? Number(sheetParam) : 0;
  if (!Number.isInteger(sheet) || sheet < 0) throw new XlsxReadError("Invalid sheet.");
  return readXlsxSheet(new Uint8Array(await Bun.file(abs).arrayBuffer()), sheet);
}
