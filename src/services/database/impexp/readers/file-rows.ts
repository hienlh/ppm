/**
 * What Import's readers hand over: a file's columns, then its rows in batches, each value as the
 * file holds it. The table writer turns a value into what its column takes; Preview shows it.
 */

/**
 * A JSON number, object or array as the file spells it: `9007199254740993` is not rounded on the
 * way, and an object goes into a JSON column as it was written.
 */
export class JsonText {
  constructor(readonly text: string) {}
}

/**
 * One value as a file holds it: text (a CSV field, a JSON string); NULL (an empty CSV field
 * without quotes, a JSON `null`, a key a JSON item does not have); a JSON `true`/`false`; or a
 * JSON number, object or array as its source text.
 */
export type FileValue = string | null | boolean | JsonText;

export interface FileRows {
  /** The columns, every name its own. */
  columns: string[];
  /** The rows, in batches: a value per column, in `columns` order. */
  batches: AsyncGenerator<FileValue[][]>;
  /** What reading left out so far, in words; complete once `batches` has ended. */
  warnings(): string[];
  /** Lets the file go, read to its end or not. */
  close(): Promise<void>;
}

/** The longest row a reader takes, in characters: past it a quoted field has most likely never ended. */
export const MAX_RECORD_CHARS = 32 * 1024 * 1024;

/** How many line or item numbers a warning lists before it only counts. */
const LISTED = 10;

/** The places a warning is about: the first ten of them, then how many more. */
export class PlaceList {
  private readonly first: number[] = [];
  count = 0;

  add(place: number): void {
    if (this.first.length < LISTED) this.first.push(place);
    this.count++;
  }

  /** `5, 9, 12` or `5, 9, … and 120 more`. */
  toString(): string {
    const more = this.count - this.first.length;
    const listed = this.first.map((n) => n.toLocaleString("en-US")).join(", ");
    return more > 0 ? `${listed} and ${more.toLocaleString("en-US")} more` : listed;
  }
}

/** A value as Preview shows it and as JSON carries it. */
export function previewValue(value: FileValue): string | boolean | null {
  return value instanceof JsonText ? value.text : value;
}
