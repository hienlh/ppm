/**
 * DBGate's MS Excel export, written without a spreadsheet library: an `.xlsx` is a zip of XML
 * files, so the sheet is written as XML while the rows come in and compressed by `archiver` on the
 * way out — never a workbook held in memory, as DBGate's SheetJS builds one.
 *
 * As DBGate's: the first row names the columns and the sheet is named after the table. Export
 * advanced's Create single file writes one workbook with a sheet for each table, named as its row
 * says. Beyond DBGate, on purpose:
 * - past Excel's 1,048,576 rows a sheet the rows go on in another, `<table>_1`, `<table>_2`;
 * - a sheet name already taken — Excel compares them ignoring case — takes the next free `_1`, `_2`;
 * - a number column's digits are a number when Excel keeps them exactly (15 significant digits),
 *   as DBGate does for a 64-bit integer; longer, they are text, so nothing is rounded;
 * - text is cut at 32,767 characters, the most a cell holds — Excel calls a longer one corrupt.
 */
import { Readable } from "node:stream";
import archiver from "archiver";
import type { ColumnKind } from "../../shared/db-column-kind.ts";
import { exportText, xmlEscape, type ExportColumn } from "./grid-export-text.ts";

/** Rows of data a sheet takes below its header row. */
export const XLSX_SHEET_ROWS = 1_048_575;

/** The most characters a cell holds. */
export const XLSX_CELL_CHARS = 32_767;

/** The most columns a sheet has (XFD). */
export const XLSX_MAX_COLUMNS = 16_384;

const CHUNK_CHARS = 64 * 1024;

const SHEET_START =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
const SHEET_END = "</sheetData></worksheet>";

/** `A`, `B` … `Z`, `AA` …: the letters of the 0-based `index`-th column. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** How many significant digits a number written as decimal text has. */
function significantDigits(text: string): number {
  const mantissa = text.replace(/^[-+]/, "").replace(/e.*$/i, "").replace(".", "");
  return mantissa.replace(/^0+/, "").replace(/0+$/, "").length;
}

const NUMBER_TEXT = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** Text Excel reads back as the same number: at most 15 significant digits. */
function exactNumberText(text: string): string | null {
  if (!NUMBER_TEXT.test(text) || significantDigits(text) > 15) return null;
  const n = Number(text);
  return Number.isFinite(n) ? String(n) : null;
}

function textCell(ref: string, text: string): string {
  const cut = text.length > XLSX_CELL_CHARS ? text.slice(0, XLSX_CELL_CHARS).replace(/[\ud800-\udbff]$/, "") : text;
  const space = /^\s|\s$/.test(cut) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"><is><t${space}>${xmlEscape(cut)}</t></is></c>`;
}

/** One cell; nothing at all for a NULL, which Excel shows as an empty cell. */
export function xlsxCell(ref: string, value: unknown, kind: ColumnKind): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === "bigint" || (typeof value === "string" && kind === "number")) {
    const number = exactNumberText(String(value));
    if (number !== null) return `<c r="${ref}"><v>${number}</v></c>`;
  }
  return textCell(ref, exportText(value));
}

function rowXml(r: number, letters: readonly string[], cells: (i: number) => string): string {
  let out = `<row r="${r}">`;
  for (let i = 0; i < letters.length; i++) out += cells(i);
  return `${out}</row>`;
}

/**
 * Sheet names: the table's, without what Excel refuses in one (`[ ] : * ? / \`, an apostrophe at
 * either end), cut to 31 characters; each sheet after the first takes `_1`, `_2`, as DBGate names a
 * second sheet of one name.
 */
export function xlsxSheetName(table: string, index: number): string {
  const clean = table.replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").trim() || "Sheet 1";
  const suffix = index === 0 ? "" : `_${index}`;
  let base = clean.slice(0, 31 - suffix.length);
  // A surrogate pair cut in half would leave a character no XML can hold.
  if (/[\ud800-\udbff]$/.test(base)) base = base.slice(0, -1);
  return base + suffix;
}

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function contentTypes(sheets: number): string {
  let overrides = '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  for (let i = 1; i <= sheets; i++) {
    overrides += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + `<Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;
}

function workbook(names: readonly string[]): string {
  const sheets = names.map((name, i) => `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  return `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${DOC_RELS}">`
    + `<sheets>${sheets}</sheets></workbook>`;
}

function workbookRels(sheets: number): string {
  let rels = "";
  for (let i = 1; i <= sheets; i++) rels += `<Relationship Id="rId${i}" Type="${DOC_RELS}/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  rels += `<Relationship Id="rId${sheets + 1}" Type="${DOC_RELS}/styles" Target="styles.xml"/>`;
  return `${XML_HEAD}<Relationships xmlns="${RELS_NS}">${rels}</Relationships>`;
}

const ROOT_RELS = `${XML_HEAD}<Relationships xmlns="${RELS_NS}">`
  + `<Relationship Id="rId1" Type="${DOC_RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

/** The one style every cell has: what a new workbook starts with. */
const STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + "</styleSheet>";

/** Settles once archiver has taken in one entry — a streamed one, all of its bytes. */
export function entryDone(archive: archiver.Archiver): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (): void => { archive.off("error", onError); resolve(); };
    const onError = (e: Error): void => { archive.off("entry", onEntry); reject(e); };
    archive.once("entry", onEntry);
    archive.once("error", onError);
  });
}

/** One table of a workbook: its rows go on a sheet named after `name`, and on more past a sheet's last row. */
export interface XlsxSheetSource {
  name: string;
  columns: readonly ExportColumn[];
  batches: AsyncIterable<unknown[][]>;
}

/**
 * The workbook, a piece at a time, from batches of rows holding the columns' values in order.
 * `sheetRows` is how many rows of data a sheet takes before the next begins.
 */
export function xlsxFile(
  columns: readonly ExportColumn[], batches: AsyncIterable<unknown[][]>, table: string, sheetRows = XLSX_SHEET_ROWS,
): AsyncGenerator<Uint8Array> {
  return xlsxWorkbook((async function* () { yield { name: table, columns, batches }; })(), sheetRows);
}

/**
 * A workbook of several tables, each taken from `tables` only once the one before it is written,
 * so one table at a time is read. A table that fails ends the workbook with its error.
 */
export async function* xlsxWorkbook(tables: AsyncIterable<XlsxSheetSource>, sheetRows = XLSX_SHEET_ROWS): AsyncGenerator<Uint8Array> {
  const tableSource = tables[Symbol.asyncIterator]();
  /** The rows of the table being written, which a workbook not read to its end has to close. */
  let reading: AsyncIterator<unknown[][]> | null = null;
  const names: string[] = [];
  const taken = new Set<string>();
  /** The first of `name`, `name_1`, `name_2`… from the `from`-th on that no sheet has yet. */
  const freeName = (name: string, from: number): string => {
    for (let i = from; ; i++) {
      const candidate = xlsxSheetName(name, i);
      if (!taken.has(candidate.toLowerCase())) {
        taken.add(candidate.toLowerCase());
        return candidate;
      }
    }
  };

  async function* tableSheets(table: XlsxSheetSource): AsyncGenerator<{ name: string; xml: AsyncGenerator<Buffer> }> {
    const { columns } = table;
    if (columns.length > XLSX_MAX_COLUMNS) throw new Error(`An Excel sheet holds at most ${XLSX_MAX_COLUMNS} columns`);
    const source = table.batches[Symbol.asyncIterator]();
    reading = source;
    const letters = columns.map((_, i) => columnLetters(i));
    const header = rowXml(1, letters, (i) => textCell(`${letters[i]}1`, columns[i]!.name));

    let batch: unknown[][] = [];
    let offset = 0;
    let ended = false;
    const nextRow = async (): Promise<unknown[] | null> => {
      while (offset >= batch.length) {
        if (ended) return null;
        const next = await source.next();
        if (next.done) {
          ended = true;
          return null;
        }
        batch = next.value;
        offset = 0;
      }
      return batch[offset++]!;
    };
    const moreRows = async (): Promise<boolean> => {
      if (!(await nextRow())) return false;
      offset -= 1;
      return true;
    };

    async function* sheet(): AsyncGenerator<Buffer> {
      let text = SHEET_START + header;
      for (let r = 2; r <= sheetRows + 1; r++) {
        const values = await nextRow();
        if (!values) break;
        text += rowXml(r, letters, (i) => xlsxCell(`${letters[i]}${r}`, values[i], columns[i]!.kind));
        if (text.length >= CHUNK_CHARS) {
          yield Buffer.from(text);
          text = "";
        }
      }
      yield Buffer.from(text + SHEET_END);
    }

    try {
      let index = 0;
      do {
        yield { name: freeName(table.name, index++), xml: sheet() };
      } while (await moreRows());
    } finally {
      reading = null;
      await source.return?.();
    }
  }

  const archive = archiver("zip", { zlib: { level: 5 } });
  const feed = async (): Promise<void> => {
    for (;;) {
      const next = await tableSource.next();
      if (next.done) break;
      for await (const { name, xml: sheetXml } of tableSheets(next.value)) {
        names.push(name);
        const done = entryDone(archive);
        const xml = Readable.from(sheetXml, { objectMode: false, highWaterMark: CHUNK_CHARS });
        // archiver pipes a stream it is given through a PassThrough of its own, which an error does
        // not cross: unheard, a read failing halfway would leave the entry open for good.
        const failed = new Promise<never>((_, reject) => xml.once("error", reject));
        archive.append(xml, { name: `xl/worksheets/sheet${names.length}.xml` });
        await Promise.race([done, failed]);
      }
    }
    // A workbook with no sheet is one Excel will not open.
    if (!names.length) {
      names.push(freeName("Sheet 1", 0));
      const done = entryDone(archive);
      archive.append(SHEET_START + SHEET_END, { name: "xl/worksheets/sheet1.xml" });
      await done;
    }
    for (const [name, text] of [
      ["xl/workbook.xml", workbook(names)],
      ["xl/_rels/workbook.xml.rels", workbookRels(names.length)],
      ["xl/styles.xml", STYLES],
      ["_rels/.rels", ROOT_RELS],
      ["[Content_Types].xml", contentTypes(names.length)],
    ] as const) {
      const done = entryDone(archive);
      archive.append(text, { name });
      await done;
    }
    await archive.finalize();
  };
  const fed = feed().catch((e: unknown) => {
    // Ends the reading below with the error, which then reaches whoever reads the file.
    archive.destroy(e as Error);
    throw e;
  });
  fed.catch(() => {});

  try {
    for await (const chunk of archive as AsyncIterable<Buffer>) yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    await fed;
  } finally {
    archive.abort();
    await (reading as AsyncIterator<unknown[][]> | null)?.return?.();
    await tableSource.return?.();
  }
}
