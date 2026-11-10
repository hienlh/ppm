/**
 * The decisions behind the Excel preview, kept out of the component so they can be tested
 * without a DOM or the stores it pulls in.
 */

/**
 * Which sheet to load after loading `requested` failed with HTTP `status`, or `null` to keep
 * showing the sheet already on screen. Only a 404 — the sheet is gone, e.g. the workbook lost a
 * sheet since the last load — moves to the first sheet. Anything else (a workbook caught half
 * written, a network error) keeps the sheet, and the next change of the file tries again.
 */
export function sheetAfterError(status: number | undefined, requested: number): number | null {
  return status === 404 && requested !== 0 ? 0 : null;
}

export const XLSX_MIN_COL_WIDTH = 64;
export const XLSX_MAX_COL_WIDTH = 320;
/** Rows looked at to size the columns. */
export const XLSX_WIDTH_SAMPLE_ROWS = 200;
/** One character of the grid's `text-xs font-mono`, and a cell's padding and border. */
const CHAR_PX = 7.2;
const CELL_PADDING_PX = 18;

/**
 * Each column's width in pixels: wide enough for its longest value in the first rows (and its
 * letter heading), held between 64 and 320 px. Longer values are shown in full by the cell bar.
 */
export function columnWidths(rows: readonly (readonly (string | null)[])[], columns: number): number[] {
  const longest = new Array<number>(columns).fill(0);
  const sample = Math.min(rows.length, XLSX_WIDTH_SAMPLE_ROWS);
  for (let r = 0; r < sample; r++) {
    const row = rows[r]!;
    for (let c = 0; c < Math.min(row.length, columns); c++) {
      const v = row[c];
      if (!v) continue;
      // A value with line breaks is as wide as its widest line.
      let len = 0;
      for (const line of v.split("\n")) len = Math.max(len, line.length);
      if (len > longest[c]!) longest[c] = len;
    }
  }
  return longest.map((len) =>
    Math.round(Math.min(XLSX_MAX_COL_WIDTH, Math.max(XLSX_MIN_COL_WIDTH, len * CHAR_PX + CELL_PADDING_PX))),
  );
}

/** `A`, `B` … `Z`, `AA` …: the letters of the 0-based `index`-th column. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
