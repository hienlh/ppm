/**
 * The text files DBGate's Export ▸ writes, written here as the rows come off the database: a batch of
 * rows in, the bytes it makes out, so a table of any size is never held whole. Values are the
 * driver's own — bytes in full, 64-bit integers exact — not the grid's, which cut bytes short.
 *
 * Where these differ from DBGate, on purpose:
 * - CSV quotes a value holding a line break of either kind, not only the record delimiter;
 * - CSV writes an empty string as `""` and NULL as an empty field, as Postgres's COPY does, so the
 *   two read back apart — DBGate writes both as an empty field;
 * - NDJSON has no first line describing the columns, which is DBGate's own and trips other readers;
 * - JSON embeds a JSON column's document rather than its text, keeping its numbers exactly as written,
 *   and writes a number a JSON reader would round (past 2^53, or a long decimal) as a string;
 * - XML leaves a NULL out (DBGate writes the word `null`, which reads as text), makes a column name
 *   that is not an XML name into one, and replaces the characters XML 1.0 cannot carry.
 */
import type { ColumnKind } from "../../shared/db-column-kind.ts";
import type { GridExportFormat } from "../../shared/db-grid-export.ts";
import {
  CSV_BOOLEAN_FORMATS, DEFAULT_KEY_FIELD, type CsvWriteOptions, type JsonOptions, type XmlWriteOptions,
} from "../../shared/db-impexp.ts";
import type { SqlDialect } from "./dialect.ts";

export interface ExportColumn {
  name: string;
  kind: ColumnKind;
}

export interface ExportTarget {
  format: GridExportFormat;
  /** How the SQL file quotes and spells its values. */
  dialect: SqlDialect;
  /** The table's own name: SQL INSERTs into it, as DBGate's do, and Excel names its sheet after it. */
  table: string;
  /** Export advanced's options for its format; the quick export's own when absent. */
  csv?: CsvWriteOptions;
  json?: JsonOptions;
  xml?: XmlWriteOptions;
}

/** Text is handed on in pieces of about this many characters, however wide a row is. */
const CHUNK_CHARS = 64 * 1024;

const utf8 = new TextEncoder();

/** A text format's file, a piece at a time, from batches of rows holding the columns' values in order. */
export function textFile(target: ExportTarget, columns: readonly ExportColumn[], batches: AsyncIterable<unknown[][]>): AsyncGenerator<Uint8Array> {
  return writeText(textWriter(target, columns), batches);
}

interface TextWriter {
  /** Written before the first row, even when there is none. */
  start: string;
  row(values: readonly unknown[], index: number): string;
  /** Written after the last row; `rows` is how many there were. */
  end(rows: number): string;
  encode(text: string): Uint8Array;
  /** Bytes before any text: a byte order mark. */
  bom?: Uint8Array;
}

async function* writeText(writer: TextWriter, batches: AsyncIterable<unknown[][]>): AsyncGenerator<Uint8Array> {
  if (writer.bom) yield writer.bom;
  let pending = writer.start;
  let rows = 0;
  for await (const batch of batches) {
    for (const values of batch) {
      pending += writer.row(values, rows++);
      if (pending.length >= CHUNK_CHARS) {
        yield writer.encode(pending);
        pending = "";
      }
    }
  }
  pending += writer.end(rows);
  if (pending) yield writer.encode(pending);
}

function textWriter(target: ExportTarget, columns: readonly ExportColumn[]): TextWriter {
  switch (target.format) {
    case "csv": return csvWriter(columns, target.csv ? csvOptions(target.csv) : { delimiter: ",", recordDelimiter: "\n", booleans: ["true", "false"] });
    case "csvSemicolon": return csvWriter(columns, { delimiter: ";", recordDelimiter: "\n", booleans: ["true", "false"] });
    case "tsv": return csvWriter(columns, { delimiter: "\t", recordDelimiter: "\n", booleans: ["true", "false"] });
    // Excel reads `sep=` as the delimiter to split by, and UTF-16 with its BOM as Unicode, where a
    // UTF-8 file without one comes out as mojibake.
    case "csvExcel": return csvWriter(columns, { delimiter: ";", recordDelimiter: "\r\n", booleans: ["TRUE", "FALSE"], excel: true });
    case "json": return jsonWriter(columns, target.json);
    case "jsonl": return jsonLinesWriter(columns);
    case "sql": return sqlWriter(columns, target);
    case "xml": return xmlWriter(columns, target.xml);
    case "xlsx": throw new Error("MS Excel is not a text format");
  }
}

// ── CSV and TSV ──

interface CsvOptions {
  delimiter: string;
  recordDelimiter: string;
  booleans: readonly [string, string];
  excel?: boolean;
  /** Every value in quotes, the header's names too; NULL is still an empty field. */
  quoted?: boolean;
  /** No line of column names. */
  noHeader?: boolean;
  /** A UTF-8 byte order mark before the text. */
  utf8Bom?: boolean;
}

/** Export advanced's CSV options as the writer takes them. */
function csvOptions(o: CsvWriteOptions): CsvOptions {
  const booleans = CSV_BOOLEAN_FORMATS.find((f) => f.value === o.booleanFormat)?.words ?? ["true", "false"];
  return { delimiter: o.delimiter, recordDelimiter: o.recordDelimiter, booleans, quoted: o.quoted, noHeader: !o.header, utf8Bom: o.bom };
}

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** JSON.stringify for what a driver hands over, which may hold 64-bit integers. */
function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "null";
}

/** A value as text: what a cell of a CSV file, an XML element or an Excel text cell holds. */
export function exportText(value: unknown, booleans: readonly [string, string] = ["true", "false"]): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? booleans[0] : booleans[1];
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return bytesBase64(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  return jsonText(value);
}

function csvWriter(columns: readonly ExportColumn[], options: CsvOptions): TextWriter {
  const { delimiter, recordDelimiter } = options;
  // An empty string in quotes: an empty field is how NULL is written.
  const quote = (text: string): string =>
    options.quoted || text === "" || text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  const field = (value: unknown): string => (value === null || value === undefined ? "" : quote(exportText(value, options.booleans)));
  const header = options.noHeader ? "" : columns.map((c) => quote(c.name)).join(delimiter) + recordDelimiter;
  const bom = options.excel ? new Uint8Array([0xff, 0xfe]) : options.utf8Bom ? new Uint8Array([0xef, 0xbb, 0xbf]) : null;
  return {
    start: (options.excel ? `sep=${delimiter}${recordDelimiter}` : "") + header,
    row: (values) => values.map(field).join(delimiter) + recordDelimiter,
    end: () => "",
    encode: options.excel ? (text) => Buffer.from(text, "utf16le") : (text) => utf8.encode(text),
    ...(bom ? { bom } : {}),
  };
}

// ── JSON and NDJSON ──

/**
 * A JSON column's text, spliced in as the document it is when it is one. Not parsed and written
 * again, which would round a number past 2^53; a line break in valid JSON can only be whitespace
 * between its tokens, so it is safe to make a space, which keeps a JSON lines row on one line.
 */
function jsonDocument(text: string): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return text.replace(/[\r\n]+/g, " ").trim();
}

/** The JSON for one value, as the grid's Copy as JSON writes it — bytes in full. */
export function exportJson(value: unknown, kind: ColumnKind): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? value.toString()
      : JSON.stringify(value.toString());
  }
  // JSON has no NaN or Infinity; null would be a different value, so they are written by name.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (typeof value === "string") {
    // A driver hands 64-bit integers and decimals over as text: a number when it reads back the
    // same, as DBGate writes one; a string when a JSON reader would round it.
    if (kind === "number" && Number.isFinite(Number(value)) && String(Number(value)) === value) return value;
    return (kind === "json" ? jsonDocument(value) : null) ?? JSON.stringify(value);
  }
  if (value instanceof Uint8Array) return `{"$binary":${JSON.stringify(bytesBase64(value))},"size":${value.byteLength}}`;
  if (value instanceof Date) return JSON.stringify(exportText(value));
  if (Array.isArray(value)) return `[${value.map((v) => exportJson(v, "other")).join(",")}]`;
  return jsonText(value);
}

function jsonObject(columns: readonly ExportColumn[], keys: readonly string[], values: readonly unknown[]): string {
  let out = "{";
  for (let i = 0; i < columns.length; i++) {
    out += `${i ? "," : ""}${keys[i]}:${exportJson(values[i], columns[i]!.kind)}`;
  }
  return `${out}}`;
}

/**
 * DBGate's: one row a line inside `[` and `]`, and `[]` when there are none. Its "Object" style
 * writes each row as a key of one object instead — the key the row's Key field holds (the first
 * column's value when it has none), the row without that field its value — and a Root field puts
 * either inside an object under that key.
 */
function jsonWriter(columns: readonly ExportColumn[], options?: JsonOptions): TextWriter {
  const keys = columns.map((c) => JSON.stringify(c.name));
  const object = options?.style === "object";
  const [open, close] = object ? ["{", "}"] : ["[", "]"];
  const root = options?.rootField ? `{${JSON.stringify(options.rootField)}: ` : "";
  const rootEnd = root ? "}" : "";
  const keyField = options?.keyField || DEFAULT_KEY_FIELD;
  const keyIndex = columns.findIndex((c) => c.name === keyField);
  const rest = columns.map((_, i) => i).filter((i) => i !== keyIndex);
  const entry = (values: readonly unknown[]): string => {
    if (!object) return jsonObject(columns, keys, values);
    const own = keyIndex >= 0 ? values[keyIndex] : undefined;
    const key = own ?? values[0];
    const body = jsonObject(rest.map((i) => columns[i]!), rest.map((i) => keys[i]!), rest.map((i) => values[i]));
    return `${JSON.stringify(key === null || key === undefined ? "" : exportText(key))}: ${body}`;
  };
  return {
    start: "",
    row: (values, index) => `${index ? ",\n" : `${root}${open}\n`}${entry(values)}`,
    end: (rows) => (rows ? `\n${close}${rootEnd}\n` : `${root}${open}${close}${rootEnd}\n`),
    encode: (text) => utf8.encode(text),
  };
}

function jsonLinesWriter(columns: readonly ExportColumn[]): TextWriter {
  const keys = columns.map((c) => JSON.stringify(c.name));
  return {
    start: "",
    row: (values) => `${jsonObject(columns, keys, values)}\n`,
    end: () => "",
    encode: (text) => utf8.encode(text),
  };
}

// ── SQL ──

/** Digits as a number column sends them past 2^53, and as MySQL sends a DECIMAL. */
const NUMBER_TEXT = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** DBGate's: `INSERT INTO <table> (…) VALUES (…);` a row, every column named, NULL included. */
function sqlWriter(columns: readonly ExportColumn[], target: ExportTarget): TextWriter {
  const d = target.dialect;
  const head = `INSERT INTO ${d.quoteIdent(target.table)} (${columns.map((c) => d.quoteIdent(c.name)).join(", ")}) VALUES (`;
  const literal = (value: unknown, kind: ColumnKind): string =>
    typeof value === "string" && kind === "number" && NUMBER_TEXT.test(value) ? value : d.literal(value, kind);
  return {
    start: "",
    row: (values) => `${head}${values.map((v, i) => literal(v, columns[i]!.kind)).join(", ")});\n`,
    end: () => "",
    encode: (text) => utf8.encode(text),
  };
}

// ── XML ──

/**
 * What XML 1.0 cannot carry, not even as a character reference: most control characters, a
 * surrogate on its own, U+FFFE and U+FFFF.
 */
// eslint-disable-next-line no-control-regex
const NOT_XML_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const XML_ESCAPES: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;", "\r": "&#13;" };

/** Text as element content. A CR is written as a reference: a reader would turn a bare one into a line feed. */
export function xmlEscape(text: string): string {
  return text.replace(NOT_XML_CHAR, "\ufffd").replace(/[<>&'"\r]/g, (c) => XML_ESCAPES[c]!);
}

const NAME_START = /[\p{L}_]/u;
const NAME_CHAR = /[\p{L}\p{M}\p{N}_.\-\u00b7]/u;

/**
 * Element names for the columns: a name that is one stays as it is; anything else is made into one
 * — `_` for each character a name cannot hold and before one that cannot start it — and a name that
 * then matches another gets a number.
 */
export function xmlElementNames(columns: readonly string[]): string[] {
  const used = new Set<string>();
  return columns.map((column) => {
    let name = Array.from(column, (ch) => (NAME_CHAR.test(ch) ? ch : "_")).join("");
    if (!name || !NAME_START.test(Array.from(name)[0]!)) name = `_${name}`;
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`;
    used.add(unique);
    return unique;
  });
}

function xmlValue(value: unknown): string {
  if (value instanceof Uint8Array) return `0x${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex").toUpperCase()}`;
  return xmlEscape(exportText(value));
}

/**
 * DBGate's: `<root>`, a `<row>` for each row and an element for each of its values — or the root
 * and item elements Export advanced names, made into XML names as a column's is.
 */
function xmlWriter(columns: readonly ExportColumn[], options?: XmlWriteOptions): TextWriter {
  const names = xmlElementNames(columns.map((c) => c.name));
  const root = xmlElementNames([options?.rootElement || "root"])[0]!;
  const item = xmlElementNames([options?.itemElement || "row"])[0]!;
  return {
    start: `<${root}>\n`,
    row: (values) => {
      let out = `<${item}>\n`;
      values.forEach((value, i) => {
        if (value === null || value === undefined) return;
        out += `<${names[i]}>${xmlValue(value)}</${names[i]}>\n`;
      });
      return `${out}</${item}>\n`;
    },
    end: () => `</${root}>\n`,
    encode: (text) => utf8.encode(text),
  };
}
