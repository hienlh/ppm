import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  XLSX_MAX_CELLS,
  XLSX_MAX_COLUMNS,
  XlsxReadError,
  columnIndex,
  dateKindOfFormat,
  formatSerialDate,
  readXlsxSheet,
} from "../../../src/services/xlsx/xlsx-reader.ts";
import { xlsxFile } from "../../../src/services/database/grid-export-xlsx.ts";
import { makeZip } from "../../helpers/make-zip.ts";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

interface Book {
  /** Sheet name → [part file under xl/worksheets/, sheetData body]. */
  sheets: [name: string, part: string, data: string][];
  shared?: string[] | string;
  styles?: string;
  workbookPr?: string;
}

/** A minimal workbook; `sharedStrings` and `styles` only when given. */
function book({ sheets, shared, styles, workbookPr = "" }: Book, extra: Record<string, string> = {}): Uint8Array {
  const rels = sheets.map(([, part], i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/${part}"/>`);
  if (shared) rels.push(`<Relationship Id="rS" Type="${REL}/sharedStrings" Target="/xl/sharedStrings.xml"/>`);
  if (styles) rels.push(`<Relationship Id="rT" Type="${REL}/styles" Target="styles.xml"/>`);
  const files: Record<string, string> = {
    "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook ${NS}>${workbookPr}<sheets>${sheets.map(([n], i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships>${rels.join("")}</Relationships>`,
    ...extra,
  };
  for (const [, part, data] of sheets) files[`xl/worksheets/${part}`] = `<worksheet ${NS}><sheetData>${data}</sheetData></worksheet>`;
  if (shared) {
    files["xl/sharedStrings.xml"] = typeof shared === "string"
      ? shared
      : `<sst ${NS}>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  }
  if (styles) files["xl/styles.xml"] = styles;
  return makeZip(files);
}

const styles = (numFmts: string, xfIds: number[]) =>
  `<styleSheet ${NS}><numFmts>${numFmts}</numFmts><cellXfs>${xfIds.map((id) => `<xf numFmtId="${id}"/>`).join("")}</cellXfs></styleSheet>`;

describe("readXlsxSheet: a LibreOffice workbook", () => {
  it("reads shared strings, numbers and a dated cell", async () => {
    const bytes = readFileSync(join(import.meta.dir, "../../fixtures/xlsx/libreoffice.xlsx"));
    const out = await readXlsxSheet(new Uint8Array(bytes));
    expect(out.sheets).toEqual(["lo"]);
    expect(out.rows).toEqual([
      ["Name", "Qty", "Price", "When"],
      ["Alice & Bob", "3", "0.1", "2024-03-05"],
      ["Châu Á", "7", "1234567.891", "2024-12-31 13:45:00"],
    ]);
    expect(out.columns).toBe(4);
    expect(out.truncatedRows).toBe(false);
  });
});

describe("readXlsxSheet: parts and cells", () => {
  it("follows the relationships, not the part names, for the sheet order", async () => {
    const bytes = book({
      sheets: [
        ["First", "sheet2.xml", '<row r="1"><c r="A1" t="inlineStr"><is><t>one</t></is></c></row>'],
        ["Second", "sheet1.xml", '<row r="1"><c r="A1" t="inlineStr"><is><t>two</t></is></c></row>'],
      ],
    });
    expect((await readXlsxSheet(bytes, 0)).rows).toEqual([["one"]]);
    const second = await readXlsxSheet(bytes, 1);
    expect(second.sheets).toEqual(["First", "Second"]);
    expect(second.rows).toEqual([["two"]]);
  });

  it("answers 404 for a sheet that is not there", async () => {
    const bytes = book({ sheets: [["S", "sheet1.xml", ""]] });
    const e = await readXlsxSheet(bytes, 3).catch((x) => x);
    expect(e).toBeInstanceOf(XlsxReadError);
    expect(e.status).toBe(404);
  });

  it("places cells by reference, and after the previous one when it has none", async () => {
    const bytes = book({
      sheets: [["S", "sheet1.xml",
        '<row r="2"><c r="B2"><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row>']],
    });
    expect((await readXlsxSheet(bytes)).rows).toEqual([[], [null, "1", "2"], ["3"]]);
  });

  it("reads every value type and skips cells that only carry a style", async () => {
    const bytes = book({
      shared: ["shared"],
      sheets: [["S", "sheet1.xml",
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="b"><v>1</v></c><c r="C1" t="e"><v>#DIV/0!</v></c>'
        + '<c r="D1" t="str"><f>A1&amp;"x"</f><v>sharedx</v></c><c r="E1" t="d"><v>2024-01-02T03:04:05Z</v></c>'
        + '<c r="F1"><f>1/3</f><v>0.33333333333333331</v></c><c r="G1"><v>0.30000000000000004</v></c>'
        + '<c r="CV1" s="0"/></row>']],
    });
    const out = await readXlsxSheet(bytes);
    expect(out.rows).toEqual([["shared", "TRUE", "#DIV/0!", 'sharedx', "2024-01-02T03:04:05Z", "0.333333333333333", "0.3"]]);
    expect(out.columns).toBe(7);
  });

  it("joins rich-text runs without the phonetic ones, and decodes entities and _xHHHH_", async () => {
    const sst = `<sst ${NS}><si><r><t>東</t></r><r><t xml:space="preserve">京 </t></r><rPh sb="0" eb="1"><t>トウ</t></rPh></si>`
      + "<si><t>a&lt;b&#10;c&#x41;_x000D_d_x005F_x000D_</t></si></sst>";
    const bytes = book({ shared: sst, sheets: [["S", "sheet1.xml", '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>']] });
    expect((await readXlsxSheet(bytes)).rows).toEqual([["東京 ", "a<b\ncA\rd_x000D_"]]);
  });

  it("reads parts written with a namespace prefix", async () => {
    const files = {
      "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="/xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="P" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": '<x:worksheet xmlns:x="m"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>hi</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>',
    };
    const out = await readXlsxSheet(makeZip(files));
    expect(out.sheets).toEqual(["P"]);
    expect(out.rows).toEqual([["hi"]]);
  });

  it("reads back a workbook PPM's own export wrote", async () => {
    async function* batches() { yield [[1, "a & b", true], [null, "  pad  ", false]]; }
    const chunks: Uint8Array[] = [];
    for await (const c of xlsxFile([{ name: "id", kind: "number" }, { name: "name", kind: "text" }, { name: "ok", kind: "boolean" }], batches(), "people")) chunks.push(c);
    const out = await readXlsxSheet(new Uint8Array(Buffer.concat(chunks)));
    expect(out.sheets).toEqual(["people"]);
    expect(out.rows).toEqual([["id", "name", "ok"], ["1", "a & b", "TRUE"], [null, "  pad  ", "FALSE"]]);
  });
});

describe("readXlsxSheet: dates", () => {
  const sheet = '<row r="1"><c r="A1" s="1"><v>45356</v></c><c r="B1" s="2"><v>45356.5</v></c><c r="C1" s="3"><v>0.75</v></c><c r="D1" s="0"><v>45356</v></c></row>';
  const st = styles('<numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/>', [0, 14, 164, 21]);

  it("shows dates by the cell's format, the same in any time zone", async () => {
    const before = process.env.TZ;
    process.env.TZ = "Asia/Ho_Chi_Minh";
    try {
      const out = await readXlsxSheet(book({ styles: st, sheets: [["S", "sheet1.xml", sheet]] }));
      expect(out.rows).toEqual([["2024-03-05", "2024-03-05 12:00:00", "18:00:00", "45356"]]);
    } finally {
      process.env.TZ = before;
    }
  });

  it("counts from 1904 when the workbook says so", async () => {
    const out = await readXlsxSheet(book({ styles: st, workbookPr: '<workbookPr date1904="1"/>', sheets: [["S", "sheet1.xml", sheet]] }));
    expect(out.rows[0]![0]).toBe("2028-03-06");
  });

  it("knows a date format from a number format", () => {
    expect(dateKindOfFormat("yyyy\\-mm\\-dd")).toBe("date");
    expect(dateKindOfFormat("[$-409]h:mm AM/PM")).toBe("time");
    expect(dateKindOfFormat('#,##0 "days"')).toBeNull();
    expect(dateKindOfFormat("[Red]0.00")).toBeNull();
    expect(dateKindOfFormat("General")).toBeNull();
    expect(dateKindOfFormat("0.00E+00")).toBeNull();
  });

  it("shows elapsed time as a total that does not wrap at a day", async () => {
    const st2 = styles('<numFmt numFmtId="164" formatCode="[h]:mm"/><numFmt numFmtId="165" formatCode="[mm]:ss"/>', [164, 46, 165, 20]);
    const data = '<row r="1"><c r="A1" s="0"><v>1.5</v></c><c r="B1" s="0"><v>0.25</v></c><c r="C1" s="1"><v>1.5</v></c>'
      + '<c r="D1" s="2"><v>0.0625</v></c><c r="E1" s="3"><v>1.5</v></c></row>';
    const out = await readXlsxSheet(book({ styles: st2, sheets: [["S", "sheet1.xml", data]] }));
    // A plain h:mm (built-in 20) still wraps, as Excel's does.
    expect(out.rows).toEqual([["36:00", "6:00", "36:00:00", "90:00", "12:00:00"]]);
  });

  it("does not take an elapsed-time format for a date", () => {
    expect(dateKindOfFormat("[h]:mm")).toBe("duration-h");
    expect(dateKindOfFormat("[hh]:mm:ss")).toBe("duration-hs");
    expect(dateKindOfFormat("[ss]")).toBe("duration-s");
    expect(dateKindOfFormat("[Red][h]:mm")).toBe("duration-h");
  });

  it("puts the serials before 1900-03-01 on the right day", () => {
    expect(formatSerialDate(1, "date", false)).toBe("1900-01-01");
    expect(formatSerialDate(59, "date", false)).toBe("1900-02-28");
    expect(formatSerialDate(61, "date", false)).toBe("1900-03-01");
  });
});

describe("readXlsxSheet: limits and refusals", () => {
  it("cuts columns past the limit", async () => {
    const cells = Array.from({ length: XLSX_MAX_COLUMNS + 5 }, (_, i) => `<c><v>${i}</v></c>`).join("");
    const out = await readXlsxSheet(book({ sheets: [["S", "sheet1.xml", `<row r="1">${cells}</row>`]] }));
    expect(out.columns).toBe(XLSX_MAX_COLUMNS);
    expect(out.truncatedColumns).toBe(true);
  });

  it("stops at the row before the cell limit", async () => {
    const perRow = 100;
    const rowCount = XLSX_MAX_CELLS / perRow + 10;
    const cells = Array.from({ length: perRow }, () => "<c><v>1</v></c>").join("");
    const out = await readXlsxSheet(book({ sheets: [["S", "sheet1.xml", `<row>${cells}</row>`.repeat(rowCount)]] }));
    expect(out.rows.length).toBe(XLSX_MAX_CELLS / perRow);
    expect(out.truncatedRows).toBe(true);
  });

  it("refuses an entry that inflates past what it declares", async () => {
    const files = {
      "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${"<row/>".repeat(200_000)}</sheetData></worksheet>`,
    };
    const e = await readXlsxSheet(makeZip(files, { "xl/worksheets/sheet1.xml": 100 })).catch((x) => x);
    expect(e).toBeInstanceOf(XlsxReadError);
    expect(e.message).toBe("This workbook is damaged.");
  });

  it("refuses a workbook whose declared size is past the limit", async () => {
    const files = { "_rels/.rels": "<Relationships/>", "xl/big.bin": "x" };
    const e = await readXlsxSheet(makeZip(files, { "xl/big.bin": 300 * 1024 * 1024 })).catch((x) => x);
    expect(e).toBeInstanceOf(XlsxReadError);
    expect(e.status).toBe(413);
  });

  it("names the legacy / encrypted format", async () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(readXlsxSheet(cfb)).rejects.toThrow("password-protected or in the legacy .xls format");
  });

  it("says a non-zip file is not an xlsx", async () => {
    await expect(readXlsxSheet(new TextEncoder().encode("a,b\n1,2"))).rejects.toThrow("Not a valid .xlsx file.");
    await expect(readXlsxSheet(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).rejects.toThrow("Not a valid .xlsx file.");
  });
});

describe("columnIndex", () => {
  it("turns letters into a 0-based column", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("z9")).toBe(25);
    expect(columnIndex("AA10")).toBe(26);
    expect(columnIndex("XFD1")).toBe(16_383);
    expect(columnIndex("12")).toBe(-1);
  });
});
