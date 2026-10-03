/**
 * DBGate's JSON documents over a table's rows. Edit row as JSON document opens a row as one object
 * and puts back what changed in it; Add JSON document makes a new row of an object, or one row of
 * each object in a list. Keys are column names. A value goes in as the grid's own editors put one
 * in: a number column takes a number, a boolean column true or false, any other column text — an
 * object or list written as its JSON, which is how a JSON column is typed into anywhere else.
 */
import { isBinaryValue } from "./cell-display";
import { parseFormText, type FormFieldKind } from "./form-view-model";

/** A column as the documents see it. */
export interface DocumentColumn {
  name: string;
  kind: FormFieldKind;
}

export type JsonDocuments =
  | { ok: true; documents: Record<string, unknown>[] }
  | { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !isBinaryValue(v);

/** The documents the text holds: one object, or — where `many` — a list of objects. */
export function readJsonDocuments(text: string, many: boolean): JsonDocuments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (isPlainObject(parsed)) return { ok: true, documents: [parsed] };
  if (!many || !Array.isArray(parsed)) return { ok: false, error: many ? "Write a JSON object, or a list of them" : "Write a JSON object" };
  if (parsed.length === 0) return { ok: false, error: "The list is empty: there is no row to add" };
  const stray = parsed.findIndex((item) => !isPlainObject(item));
  if (stray >= 0) return { ok: false, error: `Item ${stray + 1} of the list is not an object` };
  return { ok: true, documents: parsed as Record<string, unknown>[] };
}

/**
 * A row as Edit row as JSON document opens it: every column it has a value in, as the grid shows it
 * now. A new row's columns nothing was put in are left out, as they are left out of its INSERT.
 */
export function rowDocumentText(values: Readonly<Record<string, unknown>>, columns: readonly DocumentColumn[]): string {
  const doc: Record<string, unknown> = {};
  for (const c of columns) if (values[c.name] !== undefined) doc[c.name] = values[c.name];
  return JSON.stringify(doc, null, 2);
}

type Converted = { ok: true; value: unknown } | { ok: false; error: string };

/** A document's value as the column takes it. */
function convert(value: unknown, column: DocumentColumn): Converted {
  if (value === null) return { ok: true, value: null };
  if (isBinaryValue(value)) return { ok: false, error: `${column.name} holds bytes, which JSON cannot write` };
  if (column.kind === "number") {
    if (typeof value === "number") return { ok: true, value };
    if (typeof value !== "string") return { ok: false, error: `${column.name}: Not a number` };
  }
  if (column.kind === "boolean") {
    if (typeof value === "boolean") return { ok: true, value };
    if (typeof value !== "string" && typeof value !== "number") return { ok: false, error: `${column.name}: Not true or false` };
  }
  if (column.kind !== "text") {
    // An empty text is NULL to `parseFormText`, which is not what `""` says in JSON.
    if (value === "") return { ok: false, error: `${column.name}: ${column.kind === "number" ? "Not a number" : "Not true or false"}` };
    const read = parseFormText(String(value), column.kind);
    return read.ok ? read : { ok: false, error: `${column.name}: ${read.error}` };
  }
  return { ok: true, value: typeof value === "object" ? JSON.stringify(value) : String(value) };
}

function columnOf(key: string, columns: ReadonlyMap<string, DocumentColumn>): DocumentColumn | string {
  return columns.get(key) ?? `"${key}" is not a column of this table`;
}

export type DocumentChanges =
  | { ok: true; changes: { column: string; value: unknown }[] }
  | { ok: false; error: string };

/**
 * Edit row as JSON document: the values the document changes. A column left out keeps its value;
 * one the row does not let change — a saved row's key — may stay as it is but not be changed.
 */
export function documentChanges(
  doc: Readonly<Record<string, unknown>>,
  now: Readonly<Record<string, unknown>>,
  columns: readonly DocumentColumn[],
  canChange: (column: string) => boolean,
): DocumentChanges {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const changes: { column: string; value: unknown }[] = [];
  for (const [key, raw] of Object.entries(doc)) {
    const column = columnOf(key, byName);
    if (typeof column === "string") return { ok: false, error: column };
    const current = now[key];
    // Left as it was, whatever it holds — bytes too, which could not be written back.
    if (current !== undefined && JSON.stringify(raw) === JSON.stringify(current)) continue;
    const read = convert(raw, column);
    if (!read.ok) return read;
    // The same value written another way: `1` for SQLite's true, `"5"` for 5, an object as its text.
    const before = current === undefined ? null : convert(current, column);
    if (before?.ok && Object.is(before.value, read.value)) continue;
    if (!canChange(key)) return { ok: false, error: `${key} cannot be changed here` };
    changes.push({ column: key, value: read.value });
  }
  return { ok: true, changes };
}

export type NewRowValues =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; error: string };

/**
 * Add JSON document: a new row of each document. A column the database fills in itself — an
 * auto-increment key — is left out, as it is of the grid's own new rows.
 */
export function newRowValues(
  docs: readonly Readonly<Record<string, unknown>>[],
  columns: readonly DocumentColumn[],
  filledByDatabase: (column: string) => boolean,
): NewRowValues {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const rows: Record<string, unknown>[] = [];
  for (const [i, doc] of docs.entries()) {
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(doc)) {
      const column = columnOf(key, byName);
      const where = docs.length > 1 ? `Item ${i + 1}: ` : "";
      if (typeof column === "string") return { ok: false, error: where + column };
      if (filledByDatabase(key)) return { ok: false, error: `${where}${key} is filled in by the database: leave it out` };
      const read = convert(raw, column);
      if (!read.ok) return { ok: false, error: where + read.error };
      values[key] = read.value;
    }
    rows.push(values);
  }
  return { ok: true, rows };
}
