/**
 * Import's JSON readers. JSON holds its rows as an array of objects, or — Object style — as the
 * values of an object, each one's key going into the key field (`_key` when none is named); either
 * may sit under a root field of the outermost object. JSON Lines holds an object on each line.
 *
 * Neither file is parsed whole: each item is cut out of the text as it comes and parsed alone, so
 * a large file holds one item at a time. An item's values keep the text they were written with —
 * `9007199254740993` is not rounded on the way, and an object goes into a JSON column as written.
 * The first 1,000 items name the columns, in the order their keys first appear, as DBGate does.
 */
import { DEFAULT_KEY_FIELD, type JsonOptions } from "../../../../shared/db-impexp.ts";
import { uniqueColumnNames } from "../column-map.ts";
import { fileText } from "./file-text.ts";
import { JsonText, MAX_RECORD_CHARS, PlaceList, type FileRows, type FileValue } from "./file-rows.ts";

export class JsonReadError extends Error {}

/** Items whose keys name the columns; a key only a later item has is left out, and said so. */
const SAMPLED_ITEMS = 1_000;
/** Rows handed over at a time. */
const BATCH_ROWS = 1_000;
/** Key names a warning lists before it only says there are more. */
const LISTED_NAMES = 10;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const END = -1;

const isSpace = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

function tooLong(): JsonReadError {
  return new JsonReadError("A value in the file is longer than 32 MiB: is the file cut short, or not JSON?");
}

/** The character `c` as an error message quotes it. */
function shown(c: number): string {
  return c === END ? "the end of the file" : `"${String.fromCharCode(c)}"`;
}

// ── Cutting items out of the text ──

/** Reads JSON a piece of text at a time, a value at a time. */
class JsonScanner {
  private buf = "";
  private pos = 0;
  private ended = false;

  constructor(private readonly chunks: AsyncGenerator<string>) {}

  /** True once `buf[pos]` can be read; false at the end of the file. */
  private async more(): Promise<boolean> {
    while (this.pos >= this.buf.length) {
      if (this.ended) return false;
      const next = await this.chunks.next();
      if (next.done) {
        this.ended = true;
        return false;
      }
      this.buf = next.value;
      this.pos = 0;
    }
    return true;
  }

  /** The next character that is not white space, without taking it; `END` at the end of the file. */
  async peek(): Promise<number> {
    for (;;) {
      if (!(await this.more())) return END;
      const c = this.buf.charCodeAt(this.pos);
      if (!isSpace(c)) return c;
      this.pos++;
    }
  }

  /** Takes the character `peek` answered. */
  take(): void {
    this.pos++;
  }

  /**
   * The next value's text, whole: a string, a number or a literal, or an object or array with all
   * it holds. With `keep` false it is read past and not kept — a key other than the root field.
   */
  async value(keep: boolean): Promise<string> {
    const first = await this.peek();
    if (first === END || first === COMMA || first === COLON || first === CLOSE_OBJECT || first === CLOSE_ARRAY) {
      throw new JsonReadError(`Expected a value, found ${shown(first)}`);
    }
    const container = first === OPEN_OBJECT || first === OPEN_ARRAY;
    const bare = !container && first !== QUOTE;
    const pieces: string[] = [];
    let size = 0;
    let start = this.pos;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (;;) {
      if (this.pos >= this.buf.length) {
        if (keep) {
          size += this.buf.length - start;
          if (size > MAX_RECORD_CHARS) throw tooLong();
          pieces.push(this.buf.slice(start));
        }
        if (!(await this.more())) {
          if (bare) break;
          throw new JsonReadError("The file ends in the middle of a value: is it cut short?");
        }
        start = this.pos;
      }
      const c = this.buf.charCodeAt(this.pos);
      if (bare) {
        if (isSpace(c) || c === COMMA || c === CLOSE_OBJECT || c === CLOSE_ARRAY) break;
        this.pos++;
        continue;
      }
      this.pos++;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === BACKSLASH) escaped = true;
        else if (c === QUOTE) {
          inString = false;
          if (!container) break;
        }
      } else if (c === QUOTE) {
        inString = true;
      } else if (c === OPEN_OBJECT || c === OPEN_ARRAY) {
        depth++;
      } else if ((c === CLOSE_OBJECT || c === CLOSE_ARRAY) && --depth === 0) {
        break;
      }
    }
    if (!keep) return "";
    if (size + this.pos - start > MAX_RECORD_CHARS) throw tooLong();
    pieces.push(this.buf.slice(start, this.pos));
    return pieces.length === 1 ? pieces[0]! : pieces.join("");
  }

  /** An object's next key, and the colon after it. */
  async key(): Promise<string> {
    const c = await this.peek();
    if (c !== QUOTE) throw new JsonReadError(`Expected a key, found ${shown(c)}`);
    const key = JSON.parse(await this.value(true)) as string;
    const colon = await this.peek();
    if (colon !== COLON) throw new JsonReadError(`Expected ":" after the key "${key}", found ${shown(colon)}`);
    this.take();
    return key;
  }

  close(): Promise<unknown> {
    return this.chunks.return(undefined);
  }
}

/** An item: its text, the key it is under in Object style, and where it is, counted from 1. */
interface Item {
  text: string;
  key: string | null;
  place: number;
}

/** The items of the array or object `peek` is on, each with what follows it checked. */
async function* containerItems(s: JsonScanner, objectStyle: boolean): AsyncGenerator<Item> {
  const close = objectStyle ? CLOSE_OBJECT : CLOSE_ARRAY;
  s.take();
  if ((await s.peek()) === close) {
    s.take();
    return;
  }
  for (let place = 1; ; place++) {
    const key = objectStyle ? await s.key() : null;
    yield { text: await s.value(true), key, place };
    const c = await s.peek();
    if (c === close) {
      s.take();
      return;
    }
    if (c !== COMMA) throw new JsonReadError(`Expected "," or ${shown(close)} after item ${place.toLocaleString("en-US")}, found ${shown(c)}`);
    s.take();
  }
}

/** Moves past the outermost object's keys up to `rootField`'s value. */
async function findRootField(s: JsonScanner, rootField: string): Promise<void> {
  const missing = new JsonReadError(`The file has no "${rootField}" key at its top level`);
  const first = await s.peek();
  if (first !== OPEN_OBJECT) throw new JsonReadError(`The file is not a JSON object, so it has no "${rootField}" key: leave Root field empty`);
  s.take();
  if ((await s.peek()) === CLOSE_OBJECT) throw missing;
  for (;;) {
    if ((await s.key()) === rootField) return;
    await s.value(false);
    const c = await s.peek();
    if (c === CLOSE_OBJECT) throw missing;
    if (c !== COMMA) throw new JsonReadError(`Expected "," or "}" in the outermost object, found ${shown(c)}`);
    s.take();
  }
}

/** The items of a JSON file as `options` say where they are. */
async function* jsonItems(s: JsonScanner, options: JsonOptions): AsyncGenerator<Item> {
  const objectStyle = options.style === "object";
  if (options.rootField) await findRootField(s, options.rootField);
  const where = options.rootField ? `"${options.rootField}"` : "The file";
  const c = await s.peek();
  if (c === END) throw new JsonReadError("The file is empty");
  if (objectStyle && c === OPEN_ARRAY) throw new JsonReadError(`${where} is a JSON array, not an object: choose Array style`);
  if (!objectStyle && c === OPEN_OBJECT) {
    throw new JsonReadError(`${where} is a JSON object, not an array: choose Object style${options.rootField ? "" : ", or name the Root field the rows are under"}`);
  }
  if (c !== (objectStyle ? OPEN_OBJECT : OPEN_ARRAY)) throw new JsonReadError(`${where} is not a JSON ${objectStyle ? "object" : "array"}`);
  yield* containerItems(s, objectStyle);
  // Past a root field the rest of the object is left unread; a bare array or object must be all there is.
  if (!options.rootField && (await s.peek()) !== END) {
    throw new JsonReadError(`The file goes on after its JSON ${objectStyle ? "object" : "array"} ends: is it JSON Lines?`);
  }
}

/** The lines of a JSON Lines file that hold something; DBGate's header line, when first, is not a row. */
async function* lineItems(chunks: AsyncGenerator<string>): AsyncGenerator<Item> {
  let pieces: string[] = [];
  let size = 0;
  let line = 0;
  let first = true;
  const item = (text: string): Item | null => {
    line++;
    let i = 0;
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    if (i === text.length) return null;
    if (first) {
      first = false;
      try {
        if ((JSON.parse(text) as { __isStreamHeader?: unknown } | null)?.__isStreamHeader === true) return null;
      } catch {
        // Not JSON: said when the line is read as a row.
      }
    }
    return { text, key: null, place: line };
  };
  for await (const chunk of chunks) {
    let from = 0;
    for (let at = chunk.indexOf("\n"); at >= 0; at = chunk.indexOf("\n", from)) {
      pieces.push(chunk.slice(from, at));
      const found = item(pieces.length === 1 ? pieces[0]! : pieces.join(""));
      pieces = [];
      size = 0;
      from = at + 1;
      if (found) yield found;
    }
    if (from < chunk.length) {
      size += chunk.length - from;
      if (size > MAX_RECORD_CHARS) throw new JsonReadError(`Line ${(line + 1).toLocaleString("en-US")} is longer than 32 MiB`);
      pieces.push(chunk.slice(from));
    }
  }
  if (pieces.length) {
    const found = item(pieces.join(""));
    if (found) yield found;
  }
}

// ── An item's values ──

function skipSpace(text: string, i: number): number {
  while (i < text.length && isSpace(text.charCodeAt(i))) i++;
  return i;
}

/** Past the closing quote of the string starting at `i`. */
function stringEnd(text: string, i: number): number {
  for (i++; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH) i++;
    else if (c === QUOTE) return i + 1;
  }
  return i;
}

/** Where the value starting at `i` ends, in text already known to be JSON. */
function valueEnd(text: string, i: number): number {
  const first = text.charCodeAt(i);
  if (first === QUOTE) return stringEnd(text, i);
  if (first !== OPEN_OBJECT && first !== OPEN_ARRAY) {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (isSpace(c) || c === COMMA || c === CLOSE_OBJECT || c === CLOSE_ARRAY) break;
      i++;
    }
    return i;
  }
  let depth = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      i = stringEnd(text, i);
      continue;
    }
    if (c === OPEN_OBJECT || c === OPEN_ARRAY) depth++;
    else if ((c === CLOSE_OBJECT || c === CLOSE_ARRAY) && --depth === 0) return i + 1;
    i++;
  }
  return i;
}

/** A value as the item writes it: a string decoded, a number, object or array as its text. */
function fileValue(raw: string): FileValue {
  switch (raw.charCodeAt(0)) {
    case QUOTE:
      return JSON.parse(raw) as string;
    case 0x74: // true
      return true;
    case 0x66: // false
      return false;
    case 0x6e: // null
      return null;
    default:
      return new JsonText(raw);
  }
}

/**
 * The keys of an object item, in the order they are written, with their values; null when the
 * item is not an object. A key written twice keeps its first place and its last value, as
 * `JSON.parse` has it. A Map, so that a key such as `__proto__` is a key like any other.
 */
export function objectEntries(text: string): Map<string, FileValue> | null {
  let i = skipSpace(text, 0);
  if (text.charCodeAt(i) !== OPEN_OBJECT) return null;
  const entries = new Map<string, FileValue>();
  i = skipSpace(text, i + 1);
  if (text.charCodeAt(i) === CLOSE_OBJECT) return entries;
  for (;;) {
    const keyEnd = stringEnd(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipSpace(text, skipSpace(text, keyEnd) + 1);
    const end = valueEnd(text, i);
    entries.set(key, fileValue(text.slice(i, end)));
    i = skipSpace(text, end);
    if (text.charCodeAt(i) !== COMMA) return entries;
    i = skipSpace(text, i + 1);
  }
}

/** An element of a JSON array as `jsonArrayTexts` gives it. */
export type JsonArrayText = string | null | JsonArrayText[];

/**
 * A JSON array, in text already known to be JSON, as nested lists of each element's text: a
 * string decoded, a number as written, `true`/`false`, an object as its JSON; null for null. Null
 * when `text` is not an array.
 */
export function jsonArrayTexts(text: string): JsonArrayText[] | null {
  const read = (i: number): { items: JsonArrayText[]; end: number } => {
    const items: JsonArrayText[] = [];
    i = skipSpace(text, i + 1);
    if (text.charCodeAt(i) === CLOSE_ARRAY) return { items, end: i + 1 };
    for (;;) {
      if (text.charCodeAt(i) === OPEN_ARRAY) {
        const inner = read(i);
        items.push(inner.items);
        i = inner.end;
      } else {
        const end = valueEnd(text, i);
        const value = fileValue(text.slice(i, end));
        items.push(value instanceof JsonText ? value.text : typeof value === "boolean" ? String(value) : value);
        i = end;
      }
      i = skipSpace(text, i);
      if (text.charCodeAt(i) !== COMMA) return { items, end: i + 1 };
      i = skipSpace(text, i + 1);
    }
  };
  const start = skipSpace(text, 0);
  return text.charCodeAt(start) === OPEN_ARRAY ? read(start).items : null;
}

/** Key names a warning lists: the first ten, then whether there were more. */
class NameList {
  private readonly names: string[] = [];
  private more = false;

  add(name: string): void {
    if (this.names.includes(name)) return;
    if (this.names.length < LISTED_NAMES) this.names.push(name);
    else this.more = true;
  }

  toString(): string {
    const listed = this.names.map((n) => JSON.stringify(n)).join(", ");
    return this.more ? `${listed} and others` : listed;
  }
}

/**
 * Rows from items: the first 1,000 objects name the columns, in the order their keys first
 * appear; an item that is not an object is left out, and so is a key only a later item has —
 * each said in a warning. In Object style the key an item is under goes into `keyField`.
 */
async function rowsOf(items: AsyncGenerator<Item>, keyField: string | null, unit: "item" | "line", close: () => Promise<unknown>): Promise<FileRows> {
  const Unit = unit === "item" ? "Item" : "Line";
  const notObjects = new PlaceList();
  const latePlaces = new PlaceList();
  const lateNames = new NameList();
  const entriesOf = (item: Item): Map<string, FileValue> | null => {
    try {
      JSON.parse(item.text);
    } catch (e) {
      throw new JsonReadError(`${Unit} ${item.place.toLocaleString("en-US")} is not JSON: ${(e as Error).message}`);
    }
    const entries = objectEntries(item.text);
    if (!entries) notObjects.add(item.place);
    else if (keyField !== null) entries.set(keyField, item.key);
    return entries;
  };

  const sample: Map<string, FileValue>[] = [];
  const keys = new Map<string, number>();
  try {
    while (sample.length < SAMPLED_ITEMS) {
      const next = await items.next();
      if (next.done) break;
      const entries = entriesOf(next.value);
      if (!entries) continue;
      for (const key of entries.keys()) if (!keys.has(key)) keys.set(key, keys.size);
      sample.push(entries);
    }
  } catch (e) {
    await items.return(undefined);
    await close();
    throw e;
  }

  const keyList = [...keys.keys()];
  const rowOf = (entries: Map<string, FileValue>): FileValue[] => keyList.map((key) => entries.get(key) ?? null);

  async function* batches(): AsyncGenerator<FileValue[][]> {
    try {
      let rows = sample.map(rowOf);
      sample.length = 0;
      for (let at = 0; at < rows.length; at += BATCH_ROWS) yield rows.slice(at, at + BATCH_ROWS);
      rows = [];
      for (let next = await items.next(); !next.done; next = await items.next()) {
        const entries = entriesOf(next.value);
        if (!entries) continue;
        let late = false;
        for (const key of entries.keys()) {
          if (keys.has(key)) continue;
          lateNames.add(key);
          late = true;
        }
        if (late) latePlaces.add(next.value.place);
        rows.push(rowOf(entries));
        if (rows.length >= BATCH_ROWS) {
          yield rows;
          rows = [];
        }
      }
      if (rows.length) yield rows;
    } finally {
      await items.return(undefined);
      await close();
    }
  }

  const places = (list: PlaceList): string => `${list.count === 1 ? unit : `${unit}s`} ${list}`;
  return {
    columns: uniqueColumnNames(keyList),
    batches: batches(),
    warnings: () => [
      ...(notObjects.count ? [`Skipped ${notObjects.count.toLocaleString("en-US")} ${notObjects.count === 1 ? unit : `${unit}s`} that are not JSON objects: ${places(notObjects)}`] : []),
      ...(latePlaces.count ? [`Left out keys the first ${SAMPLED_ITEMS.toLocaleString("en-US")} ${unit}s do not have — ${lateNames}: ${places(latePlaces)}`] : []),
    ],
    close: async () => {
      await items.return(undefined);
      await close();
    },
  };
}

/** Opens a JSON file: reads up to its first 1,000 items, which name the columns. */
export function openJson(path: string, options: JsonOptions, signal?: AbortSignal): Promise<FileRows> {
  return jsonRows(fileText(path, signal), options);
}

/** `openJson` over text given a piece at a time. */
export function jsonRows(chunks: AsyncGenerator<string>, options: JsonOptions): Promise<FileRows> {
  const scanner = new JsonScanner(chunks);
  const keyField = options.style === "object" ? options.keyField || DEFAULT_KEY_FIELD : null;
  return rowsOf(jsonItems(scanner, options), keyField, "item", () => scanner.close());
}

/** Opens a JSON Lines file: reads up to its first 1,000 objects, which name the columns. */
export function openJsonLines(path: string, signal?: AbortSignal): Promise<FileRows> {
  return jsonLinesRows(fileText(path, signal));
}

/** `openJsonLines` over text given a piece at a time. */
export function jsonLinesRows(chunks: AsyncGenerator<string>): Promise<FileRows> {
  return rowsOf(lineItems(chunks), null, "line", () => chunks.return(undefined));
}
