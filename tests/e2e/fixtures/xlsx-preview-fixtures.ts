/**
 * Writes the workbooks `xlsx-preview-e2e.mjs` opens, into the directory given as the first
 * argument: `book.xlsx` (Summary, Data, Big ~20,000 rows, Wide 250 columns), `book-cut.xlsx` (the
 * same, cut off after 4 KB, as a copy caught half written), `book-data-damaged.xlsx` (only the Data
 * sheet unreadable: it declares itself smaller than it inflates to, which unzipit refuses, while
 * every other sheet reads) and `book-full.xlsx` (a spare full copy).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeZip } from "../../helpers/make-zip.ts";

export const LONG_NOTE =
  "This note is far longer than any column is wide: it goes on to say that the quarterly figures were "
  + "revised after the audit, and that the final numbers will only be known in March.";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const str = (ref: string, s: string) => `<c r="${ref}" t="inlineStr"><is><t>${esc(s)}</t></is></c>`;
const num = (ref: string, n: number, style = 0) => `<c r="${ref}" s="${style}"><v>${n}</v></c>`;
function letters(i: number): string {
  let n = i + 1, out = "";
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

const summary = `<row r="1">${str("A1", "Elapsed")}${str("B1", "When")}${str("C1", "Note")}</row>`
  + `<row r="2">${num("A2", 1.5, 1)}${num("B2", 45356.5, 2)}${str("C2", LONG_NOTE)}</row>`;
const data = Array.from({ length: 30 }, (_, i) => `<row r="${i + 1}">${str(`A${i + 1}`, `data row ${i + 1}`)}${num(`B${i + 1}`, i * 10)}</row>`).join("");
const big = Array.from({ length: 20_000 }, (_, i) => `<row r="${i + 1}">${num(`A${i + 1}`, i + 1)}${str(`B${i + 1}`, `item ${i + 1}`)}${num(`C${i + 1}`, (i * 7) % 13)}</row>`).join("");
const wide = `<row r="1">${Array.from({ length: 250 }, (_, c) => num(`${letters(c)}1`, c)).join("")}</row>`;

const sheets: [string, string][] = [["Summary", summary], ["Data", data], ["Big", big], ["Wide", wide]];
const files: Record<string, string> = {
  "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml": `<workbook ${NS}><sheets>${sheets.map(([n], i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}`
    + `<Relationship Id="rS" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
  "xl/styles.xml": `<styleSheet ${NS}><numFmts><numFmt numFmtId="164" formatCode="[h]:mm"/></numFmts>`
    + '<cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="22"/></cellXfs></styleSheet>',
};
sheets.forEach(([, body], i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet ${NS}><sheetData>${body}</sheetData></worksheet>`; });

const out = process.argv[2];
if (!out) throw new Error("usage: bun xlsx-preview-fixtures.ts <dir>");
const bytes = makeZip(files);
writeFileSync(join(out, "book.xlsx"), bytes);
writeFileSync(join(out, "book-full.xlsx"), bytes);
writeFileSync(join(out, "book-cut.xlsx"), bytes.subarray(0, 4096));
writeFileSync(join(out, "book-data-damaged.xlsx"), makeZip(files, { "xl/worksheets/sheet2.xml": 16 }));
console.log(JSON.stringify({ bytes: bytes.length, longNote: LONG_NOTE }));
