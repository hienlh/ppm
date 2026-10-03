/**
 * DBGate's Cell data view (`CellDataWidget.svelte`), the part that is not drawing: its formats, the
 * one Autodetect picks for what is selected, and what each format makes of the selected cells. Every
 * cell is read as it reads now — an edit's value, and on a new row only what was put in.
 */
import type { GridSelection } from "@glideapps/glide-data-grid";
import type { DbBinaryValue } from "../../../../shared/db-grid";
import { formatByteSize, isBinaryValue, leadingBytes } from "./cell-display";
import { columnNameMatches } from "./form-view-model";
import { forEachSelectedCell } from "./selection-stats";

export type CellDataFormat = "textWrap" | "text" | "form" | "json" | "jsonExpanded" | "jsonRow" | "picture" | "html" | "xml";

/** What the Format box holds: a format, or Autodetect's pick. */
export type CellDataChoice = "autodetect" | CellDataFormat;

export interface CellDataFormatInfo {
  id: CellDataFormat;
  title: string;
  /** Shows one cell: with any other number selected it says "Must be selected one cell". */
  single: boolean;
}

/** DBGate's formats, in its order. Its Map is left out: PPM has no map to draw on. */
export const CELL_DATA_FORMATS: readonly CellDataFormatInfo[] = [
  { id: "textWrap", title: "Text (wrap)", single: false },
  { id: "text", title: "Text (no wrap)", single: false },
  { id: "form", title: "Form", single: false },
  { id: "json", title: "Json", single: true },
  { id: "jsonExpanded", title: "Json - expanded", single: true },
  { id: "jsonRow", title: "Json - Row", single: false },
  { id: "picture", title: "Picture", single: true },
  { id: "html", title: "HTML", single: false },
  { id: "xml", title: "XML", single: false },
];

export function cellDataFormat(id: CellDataFormat): CellDataFormatInfo {
  return CELL_DATA_FORMATS.find((f) => f.id === id)!;
}

/** What the Format box says for a choice: "Autodetect - Json" while Autodetect picks Json. */
export function choiceTitle(choice: CellDataChoice, detected: CellDataFormat): string {
  return choice === "autodetect" ? `Autodetect - ${cellDataFormat(detected).title}` : cellDataFormat(choice).title;
}

/** Cells the view reads at most: a whole column of a table read to the end can be a million. */
export const CELL_DATA_MAX_CELLS = 100_000;

/** One selected cell. */
export interface CellDataCell {
  /** The row's place among the grid's rows. */
  row: number;
  column: string;
  /** As the cell reads now; undefined on a new row's cell nothing was put in. */
  value: unknown;
  /** Its row is selected whole, from its number. */
  fullRow: boolean;
}

export interface CellDataSelection {
  /** Row by row, left to right in each — the order the text formats put them in. None past the cap. */
  cells: CellDataCell[];
  /** Every cell the selection covers. */
  total: number;
}

export const NO_CELL_DATA: CellDataSelection = { cells: [], total: 0 };

/** The cells `sel` covers, within `columns` (the grid's, in its order) and `rowCount` rows. */
export function collectCellData(
  sel: GridSelection, columns: readonly string[], rowCount: number, valueAt: (row: number, column: string) => unknown,
): CellDataSelection {
  const places: [row: number, col: number][] = [];
  let total = 0;
  forEachSelectedCell(sel, columns.length, rowCount, (c, r) => {
    if (++total <= CELL_DATA_MAX_CELLS) places.push([r, c]);
  });
  if (total > CELL_DATA_MAX_CELLS) return { cells: [], total };
  places.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cells = places.map(([row, col]) => {
    const column = columns[col]!;
    return { row, column, value: valueAt(row, column), fullRow: sel.rows.hasIndex(row) };
  });
  return { cells, total };
}

/** The rows the cells lie on, once each, in order — `cells` being row by row, as `collectCellData` lists them. */
export function rowsOfCells(cells: readonly CellDataCell[]): number[] {
  const rows: number[] = [];
  for (const cell of cells) if (rows[rows.length - 1] !== cell.row) rows.push(cell.row);
  return rows;
}

/** Whether a text reads as JSON. */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * DBGate's Autodetect, in its order: a whole row is a form; one value is JSON when it is an object
 * or a list, or text holding one, and XML when it is text in angle brackets; anything else is text.
 * PPM adds a picture for bytes that start the way an image does.
 */
export function autodetectFormat(cells: readonly CellDataCell[]): CellDataFormat {
  if (cells[0]?.fullRow) return "form";
  const value = cells.length === 1 ? cells[0]!.value : null;
  if (isBinaryValue(value)) return imageType(value) ? "picture" : "textWrap";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("[") || trimmed.startsWith("{")) && parsesAsJson(trimmed)) return "json";
    if (value.startsWith("<") && value.endsWith(">")) return "xml";
    return "textWrap";
  }
  if (value !== null && typeof value === "object") return "json";
  return "textWrap";
}

/** What the view says instead of a format, in DBGate's order; null when the format has something to show. */
export function cellDataMessage(format: CellDataFormatInfo, selection: CellDataSelection): string | null {
  if (selection.total > CELL_DATA_MAX_CELLS) {
    return `Too many cells selected (${selection.total.toLocaleString()}): the view reads at most ${CELL_DATA_MAX_CELLS.toLocaleString()}`;
  }
  if (format.single && selection.total !== 1) return "Must be selected one cell";
  if (selection.total === 0) return "No data selected";
  return null;
}

/** Bytes on one line of the hex text. */
const HEX_LINE = 16;

/** Bytes as hex, sixteen to a line; a value the server sent only the start of says so after them. */
export function binaryHex(value: DbBinaryValue): string {
  let raw = "";
  try {
    raw = atob(value.$binary);
  } catch {
    // Not base64: there are no bytes to show.
  }
  const lines: string[] = [];
  for (let at = 0; at < raw.length; at += HEX_LINE) {
    const line: string[] = [];
    for (let i = at; i < Math.min(at + HEX_LINE, raw.length); i++) line.push(raw.charCodeAt(i).toString(16).toUpperCase().padStart(2, "0"));
    lines.push(line.join(" "));
  }
  if (value.truncated) lines.push(`… ${formatByteSize(value.size)} in all: only the first ${formatByteSize(raw.length)} were read`);
  return lines.join("\n");
}

/** One value as the text formats show it, as DBGate's: NULL as nothing, an object as indented JSON, bytes in hex. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (isBinaryValue(value)) return binaryHex(value);
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** The text formats' text: each selected value on a line of its own. */
export function cellsText(cells: readonly CellDataCell[]): string {
  return cells.map((c) => cellText(c.value)).join("\n");
}

export type JsonRead = { ok: true; value: unknown } | { ok: false };

/**
 * One value as the Json formats read it, as DBGate's: an object or a list as it is, anything else
 * parsed as JSON text — so a number is a number and `hello` is "Error parsing JSON". Bytes are not JSON.
 */
export function readJson(value: unknown): JsonRead {
  if (value === undefined || isBinaryValue(value)) return { ok: false };
  if (value !== null && typeof value === "object") return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(String(value)) };
  } catch {
    return { ok: false };
  }
}

/** Json - Row: one row as an object, several as a list of them. */
export function rowsJson(rows: readonly Record<string, unknown>[]): unknown {
  return rows.length === 1 ? rows[0] : rows;
}

/** A value the Form format draws as a tree, as DBGate's: an object or a list — or long text holding one. */
export function formJsonValue(value: unknown): object | null {
  if (isBinaryValue(value)) return null;
  if (value !== null && typeof value === "object") return value;
  // DBGate's `isJsonLikeLongString`: short text stays text, however it is spelled.
  if (typeof value !== "string" || value.length <= 100 || !/^\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Two rows' values alike, as DBGate compares them: NULL and a new row's empty cell are. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  return typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b);
}

/** One field of the Form format. */
export interface CellDataField {
  column: string;
  /** What every selected row holds; undefined when they differ. */
  value: unknown;
  /** The rows hold different values: "(Multiple values)". */
  multiple: boolean;
}

/**
 * The Form format's fields: one per column of the grid, in its order, whose value is the rows' when
 * they agree. Filter columns keeps the names it matches, as the form view's Column name filter does;
 * Hide NULL values drops the fields with nothing in them.
 */
export function cellDataFields(
  columns: readonly string[], rows: readonly Record<string, unknown>[], filter: string, hideNull: boolean,
): CellDataField[] {
  const fields: CellDataField[] = [];
  for (const column of columns) {
    if (!columnNameMatches(filter, column)) continue;
    const first = rows[0]?.[column];
    const multiple = rows.some((row) => !sameValue(row[column], first));
    if (hideNull && !multiple && first == null) continue;
    fields.push({ column, value: multiple ? undefined : first, multiple });
  }
  return fields;
}

/** The start of each image type a browser draws, by the bytes it begins with. */
const IMAGE_SIGNATURES: readonly { mime: string; matches: (b: readonly number[]) => boolean }[] = [
  { mime: "image/png", matches: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x) },
  { mime: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", matches: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { mime: "image/webp", matches: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP" },
  { mime: "image/bmp", matches: (b) => b[0] === 0x42 && b[1] === 0x4d },
  { mime: "image/x-icon", matches: (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
  { mime: "image/avif", matches: (b) => ascii(b, 4, 4) === "ftyp" && /^avi[fs]$/.test(ascii(b, 8, 4)) },
];

function ascii(bytes: readonly number[], from: number, length: number): string {
  return String.fromCharCode(...bytes.slice(from, from + length));
}

/** The image type the bytes begin as, or null. */
export function imageType(value: DbBinaryValue): string | null {
  const head = leadingBytes(value.$binary, 12);
  return IMAGE_SIGNATURES.find((s) => s.matches(head))?.mime ?? null;
}

/** How many of the value's bytes came with the row. */
export function bytesRead(value: DbBinaryValue): number {
  return Math.floor((value.$binary.replace(/=+$/, "").length * 3) / 4);
}

/**
 * Picture's source: the bytes as a data URL, typed by how they begin — or as PNG, which is all
 * DBGate ever says and a browser looks past. Null when the value holds no bytes.
 */
export function pictureUrl(value: unknown): string | null {
  if (!isBinaryValue(value) || value.size === 0) return null;
  return `data:${imageType(value) ?? "image/png"};base64,${value.$binary}`;
}

/** What the HTML frame may load: images and fonts written into the value, nothing from anywhere else. */
export const HTML_FRAME_POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";

/**
 * Tags the value loses: a `<meta>` refresh would load another page into the frame with no click
 * asking — the policy does not cover navigation — and a `<link>` can reach the network where the
 * policy does not look (a DNS prefetch). Every one goes, whatever its attributes say, since an
 * attribute's value can spell `refresh` in character references.
 */
const NAVIGATING_TAGS = /<(?:meta|link)\b[^>]*>/gi;

/**
 * The HTML format's page, for a frame that runs no script (`sandbox=""`): the value under a policy
 * that loads nothing from the network — DBGate sanitizes instead, with DOMPurify — and the app's
 * colours, with no DNS prefetching for its links.
 */
export function htmlDocument(html: string, colors: { text: string; background: string }): string {
  let body = html;
  // Again until none is left: taking one out can join the text around it into another.
  for (let before = ""; before !== body;) {
    before = body;
    body = body.replace(NAVIGATING_TAGS, "");
  }
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_FRAME_POLICY}">`
    + `<meta http-equiv="x-dns-prefetch-control" content="off">`
    + `<style>html{color:${colors.text};background:${colors.background};font:12.5px/1.5 system-ui,sans-serif}</style>${body}`;
}
