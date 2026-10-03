/**
 * The arithmetic of DBGate's form view (`FormView.svelte`), kept apart so it can be tested. One row
 * is laid out as tables of (name, value) pairs side by side: as many fields go down each as the
 * height holds, the rest start a new pair to the right, so the form only ever scrolls sideways.
 *
 * The cursor is DBGate's `[row, column]` over that layout: an even column is a pair's names, the
 * odd one after it the pair's values. Field `i` sits at row `i % perColumn` of pair
 * `i / perColumn`.
 */
import type { RowCountView } from "../glide-grid-types";
import { NO_FIELD_TEXT, NULL_TEXT, formatBinary, isBinaryValue } from "./cell-display";

/** One field's line, as the mockup draws it. */
export const FORM_ROW_HEIGHT = 30;

/** What the form keeps free under the last field, as DBGate does for its row count label. */
const FORM_FOOT = 22;

/** Fields one pair holds in `height` pixels: at least one, or nothing could be shown. */
export function fieldsPerColumn(height: number): number {
  if (!Number.isFinite(height)) return 1;
  return Math.max(1, Math.floor((height - FORM_FOOT) / FORM_ROW_HEIGHT));
}

/** The fields, a pair at a time. */
export function formChunks<T>(fields: readonly T[], perColumn: number): T[][] {
  const per = Math.max(1, perColumn);
  const chunks: T[][] = [];
  for (let i = 0; i < fields.length; i += per) chunks.push(fields.slice(i, i + per));
  return chunks;
}

/** DBGate's form cursor: `[row in the pair, column]`, the column even on a name and odd on a value. */
export type FormCell = readonly [row: number, col: number];

export const isValueCell = (cell: FormCell) => cell[1] % 2 === 1;

/** The field a cell shows. */
export function fieldOfCell(cell: FormCell, perColumn: number): number {
  return Math.floor(cell[1] / 2) * perColumn + cell[0];
}

/** Where field `field` is drawn: on its value, or on its name. */
export function cellOfField(field: number, perColumn: number, onName = false): FormCell {
  const per = Math.max(1, perColumn);
  return [field % per, Math.floor(field / per) * 2 + (onName ? 0 : 1)];
}

/**
 * The cell kept inside the layout, as DBGate's `moveCurrentCell` keeps it: past the last pair it
 * stops on the last pair's values, and past a short last pair's end on its last field.
 */
export function clampFormCell(cell: FormCell, fieldCount: number, perColumn: number): FormCell {
  if (fieldCount <= 0) return [0, 1];
  const per = Math.max(1, perColumn);
  const pairs = Math.ceil(fieldCount / per);
  let [row, col] = cell;
  if (row < 0) row = 0;
  if (col < 0) col = 0;
  if (col >= pairs * 2) col = pairs * 2 - 1;
  const inPair = Math.min(per, fieldCount - Math.floor(col / 2) * per);
  if (row >= inPair) row = inPair - 1;
  return [row, col];
}

/**
 * DBGate's match of a column name against the Column name filter (`filterName` in dbgate-tools):
 * commas separate alternatives, any of which may match; spaces separate words, each of which must.
 * A word typed all in capitals matches the capitals of the name's words, in order — `CA` is
 * `created_at`, `UID` is `userID` — and any other word is looked for inside the name, ignoring case.
 */
export function columnNameMatches(filter: string, name: string): boolean {
  if (!filter.trim()) return true;
  return filter.split(",").some((alternative) => {
    const words = alternative.split(" ").map((w) => w.trim()).filter(Boolean);
    return words.length > 0 && words.every((word) => wordMatches(word, name));
  });
}

function wordMatches(word: string, name: string): boolean {
  if (!name) return false;
  if (/^[A-Z]+$/.test(word)) return subsequence(word, nameCapitals(name));
  return name.toUpperCase().includes(word.toUpperCase());
}

/**
 * The capitals of a name once each of its words starts with one: `created_at` is `CA`, `userID`
 * `UID`, `XMLHttpRequest` `XMLHR`. Words break at anything not a letter or digit, where a small
 * letter meets a capital, and where letters meet digits.
 */
export function nameCapitals(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z\d]+|(?<=\d)(?=[A-Za-z])|(?<=[A-Za-z])(?=\d)/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("")
    .replace(/[^A-Z]/g, "");
}

/** Whether every letter of `letters` appears in `text`, in order. */
function subsequence(letters: string, text: string): boolean {
  let at = 0;
  for (const ch of text) if (ch === letters[at]) at++;
  return at === letters.length;
}

export interface FormCursorContext {
  fieldCount: number;
  perColumn: number;
  /** The Column name filter, which ↑ and ↓ on a name jump through. */
  nameFilter: string;
  names: readonly string[];
}

/**
 * Where a key moves the form's cursor, as DBGate's `handleCursorMove` moves it; null for a key that
 * does not move it. Ctrl+↑ / Ctrl+↓ / Ctrl+Home / Ctrl+End are not moves but the row's First,
 * Previous, Next and Last, which the caller has taken before this.
 */
export function moveFormCell(
  cell: FormCell, key: string, ctrl: boolean, ctx: FormCursorContext,
): FormCell | null {
  const { fieldCount, perColumn, nameFilter } = ctx;
  if (fieldCount <= 0) return null;
  const per = Math.max(1, perColumn);
  const pairs = Math.ceil(fieldCount / per);
  const clamp = (next: FormCell) => clampFormCell(next, fieldCount, per);
  const [row, col] = cell;
  if (ctrl) {
    if (key === "ArrowLeft") return clamp([row, 0]);
    if (key === "ArrowRight") return clamp([row, pairs * 2 - 1]);
    return null;
  }
  // On a name, with a Column name filter typed, ↑ and ↓ go to the matching names only.
  const jumping = !isValueCell(cell) && nameFilter.trim() !== "";
  switch (key) {
    case "ArrowLeft": return clamp([row, col - 1]);
    case "ArrowRight": return clamp([row, col + 1]);
    case "ArrowUp": return jumping ? nextMatching(cell, -1, ctx) : clamp([row - 1, col]);
    case "ArrowDown": return jumping ? nextMatching(cell, 1, ctx) : clamp([row + 1, col]);
    case "PageUp": return clamp([0, col]);
    case "PageDown": return clamp([per - 1, col]);
    case "Home": return clamp([0, 0]);
    case "End": return clamp([per - 1, pairs * 2 - 1]);
    default: return null;
  }
}

/**
 * The next field down (or up) whose name the filter matches, wrapping round once; with none, the
 * last field (or the first). DBGate puts the cursor on row `index % fieldCount` of the field's
 * pair, which lands on the wrong field from the second pair on; this goes to the field itself.
 */
function nextMatching(cell: FormCell, step: 1 | -1, ctx: FormCursorContext): FormCell {
  const { fieldCount, perColumn, nameFilter, names } = ctx;
  const matches = (i: number) => columnNameMatches(nameFilter, names[i] ?? "");
  const inRange = (i: number) => i >= 0 && i < fieldCount;
  let i = fieldOfCell(cell, perColumn) + step;
  while (inRange(i) && !matches(i)) i += step;
  if (!inRange(i)) {
    i = step === 1 ? 0 : fieldCount - 1;
    while (inRange(i) && !matches(i)) i += step;
  }
  if (!inRange(i)) i = step === 1 ? fieldCount - 1 : 0;
  return cellOfField(i, perColumn, true);
}

/** First · Previous · Next · Last, as the form's toolbar and keys name them. */
export type FormNavigation = "first" | "previous" | "next" | "last";

/** The row a navigation lands on among `rowCount` rows; Last is the caller's while more rows can be read. */
export function navigateFormRow(index: number, to: FormNavigation, rowCount: number): number {
  if (rowCount <= 0) return 0;
  const last = rowCount - 1;
  switch (to) {
    case "first": return 0;
    case "previous": return Math.max(0, Math.min(last, index - 1));
    case "next": return Math.min(last, Math.max(0, index + 1));
    case "last": return last;
  }
}

/**
 * DBGate's label in the form's corner: `Row: 2 / 14`. The total is what the table's "Rows: N" knows
 * — exact, the database's estimate (`~`), or Many once the count gave up — and Loading row count...
 * while it is still being counted. A new row has no place among the table's rows yet.
 */
export function formRowLabel(index: number, rowsShown: number, loaded: number, count: RowCountView | null): string {
  if (rowsShown <= 0 || index < 0 || index >= rowsShown) return "No data";
  if (index >= loaded) return `New row ${(index - loaded + 1).toLocaleString()}`;
  const current = `Row: ${(index + 1).toLocaleString()}`;
  const total = count?.total;
  if (!total) return `${current} / ???`;
  switch (total.kind) {
    case "exact": return `${current} / ${Math.max(total.count, loaded).toLocaleString()}`;
    case "estimate": return `${current} / ~${total.count.toLocaleString()}`;
    case "many": return `${current} / Many`;
    case "atLeast": return count.counting ? "Loading row count..." : `${current} / ${total.count.toLocaleString()}+`;
  }
}

/** How a field reads what is typed into it: as a number, as true or false, or as the text itself. */
export type FormFieldKind = "number" | "boolean" | "text";

export type FormParse = { ok: true; value: unknown } | { ok: false; error: string };

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const INTEGER = /^[+-]?\d+$/;
/** The significant digits a JavaScript number keeps of any decimal. */
const EXACT_DIGITS = 15;

/** Whether `text`, a decimal number, reads as a JavaScript number with no digit lost. */
function keepsEveryDigit(text: string, n: number): boolean {
  if (INTEGER.test(text)) return Number.isSafeInteger(n);
  const mantissa = text.replace(/^[+-]/, "").replace(/e.*$/i, "").replace(".", "");
  return mantissa.replace(/^0+/, "").replace(/0+$/, "").length <= EXACT_DIGITS;
}
const TRUE_TEXT = new Set(["true", "t", "1"]);
const FALSE_TEXT = new Set(["false", "f", "0"]);

/**
 * What a field holds once its editor is left with `text` in it. Emptied is NULL, as a cell cleared
 * in the grid is. A number column takes decimal numbers only — not `0x10`, which JavaScript would
 * read as 16 — and one with more digits than a JavaScript number keeps goes as typed, so no digit
 * of a bigint or a long numeric is lost on the way: the database reads it.
 */
export function parseFormText(text: string, kind: FormFieldKind): FormParse {
  if (text === "") return { ok: true, value: null };
  const trimmed = text.trim();
  if (kind === "number") {
    const n = Number(trimmed);
    if (!DECIMAL.test(trimmed) || !Number.isFinite(n)) return { ok: false, error: "Not a number" };
    return { ok: true, value: keepsEveryDigit(trimmed, n) ? n : trimmed };
  }
  if (kind === "boolean") {
    const word = trimmed.toLowerCase();
    if (TRUE_TEXT.has(word)) return { ok: true, value: true };
    if (FALSE_TEXT.has(word)) return { ok: true, value: false };
    return { ok: false, error: "Not true or false" };
  }
  return { ok: true, value: text };
}

/** What a field's editor opens with: nothing for NULL, objects as JSON. */
export function formEditText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** What a field shows: DBGate's (NULL) and (No Field), bytes as their size and first bytes, objects as JSON. */
export function formDisplayText(value: unknown): string {
  if (value === undefined) return NO_FIELD_TEXT;
  if (value === null) return NULL_TEXT;
  if (isBinaryValue(value)) return formatBinary(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** What Ctrl+C copies from a field, as the grid copies a cell: nothing for NULL. */
export function formCopyText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return isBinaryValue(value) ? formatBinary(value) : formEditText(value);
}
