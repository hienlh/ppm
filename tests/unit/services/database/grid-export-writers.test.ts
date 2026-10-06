import { describe, expect, it } from "bun:test";
import type { ColumnKind } from "../../../../src/shared/db-column-kind.ts";
import type { GridExportFormat } from "../../../../src/shared/db-grid-export.ts";
import { mysqlDialect } from "../../../../src/services/database/dialect-mysql.ts";
import { postgresDialect } from "../../../../src/services/database/dialect-postgres.ts";
import { exportFile, type ExportColumn } from "../../../../src/services/database/grid-export.ts";
import { exportJson, xmlElementNames, xmlEscape } from "../../../../src/services/database/grid-export-text.ts";
import {
  XLSX_CELL_CHARS, XLSX_MAX_COLUMNS, columnLetters, xlsxCell, xlsxFile, xlsxSheetName,
} from "../../../../src/services/database/grid-export-xlsx.ts";
import { readZip } from "../../../helpers/read-zip.ts";

const col = (name: string, kind: ColumnKind = "text"): ExportColumn => ({ name, kind });

async function* batchesOf(...batches: unknown[][][]): AsyncGenerator<unknown[][]> {
  for (const batch of batches) yield batch;
}

async function bytesOf(gen: AsyncGenerator<Uint8Array>): Promise<{ bytes: Uint8Array; chunks: number }> {
  const parts: Uint8Array[] = [];
  for await (const part of gen) parts.push(part);
  return { bytes: Buffer.concat(parts), chunks: parts.length };
}

async function fileText(format: GridExportFormat, columns: ExportColumn[], ...batches: unknown[][][]): Promise<string> {
  const { bytes } = await bytesOf(exportFile({ format, dialect: postgresDialect, table: "items" }, columns, batchesOf(...batches)));
  return new TextDecoder().decode(bytes);
}

describe("CSV and TSV", () => {
  const columns = [col("id", "number"), col("name"), col("ok", "boolean")];

  it("quotes only what needs it — the delimiter, a quote, a line break of either kind", async () => {
    const csv = await fileText("csv", columns, [[1, "plain", true], [2, 'a "b", c', false]], [[3, "cr\rhere", null], [4, "lf\nhere", true]]);
    expect(csv).toBe('id,name,ok\n1,plain,true\n2,"a ""b"", c",false\n3,"cr\rhere",\n4,"lf\nhere",true\n');
  });

  it("writes NULL as an empty field, an empty string as \"\" and a name needing quotes in quotes", async () => {
    // Postgres's COPY tells the two apart this way, and so does Import.
    expect(await fileText("csv", [col("a,b"), col("c")], [[null, ""]])).toBe('"a,b",c\n,""\n');
  });

  it("writes bytes as base64, a date as ISO, a document as JSON, a 64-bit integer whole", async () => {
    const csv = await fileText("csv", [col("b", "binary"), col("d", "datetime"), col("j", "json"), col("n", "number")], [[
      new Uint8Array([0xde, 0xad]), new Date("2024-01-02T03:04:05.006Z"), { k: [1, 2] }, 9007199254740993n,
    ]]);
    expect(csv).toBe('b,d,j,n\n3q0=,2024-01-02T03:04:05.006Z,"{""k"":[1,2]}",9007199254740993\n');
  });

  it("separates with a semicolon or a tab, and quotes that one", async () => {
    expect(await fileText("csvSemicolon", columns, [[1, "a;b", true], [2, "a,b", false]])).toBe('id;name;ok\n1;"a;b";true\n2;a,b;false\n');
    expect(await fileText("tsv", columns, [[1, "a\tb", true], [2, "a,b", false]])).toBe('id\tname\tok\n1\t"a\tb"\ttrue\n2\ta,b\tfalse\n');
  });

  it("writes only the header for no rows", async () => {
    expect(await fileText("csv", columns)).toBe("id,name,ok\n");
  });

  it("gives Excel UTF-16 with its byte order mark, sep=, CRLF and its own booleans", async () => {
    const { bytes } = await bytesOf(exportFile({ format: "csvExcel", dialect: postgresDialect, table: "t" }, columns, batchesOf([[1, "Đơn; hàng", true]])));
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(Buffer.from(bytes.subarray(2)).toString("utf16le")).toBe('sep=;\r\nid;name;ok\r\n1;"Đơn; hàng";TRUE\r\n');
  });
});

describe("JSON and JSON lines", () => {
  it("writes DBGate's array, one object a line, and [] for no rows", async () => {
    const columns = [col("id", "number"), col("name")];
    expect(await fileText("json", columns, [[1, "a"]], [[2, "b"]])).toBe('[\n{"id":1,"name":"a"},\n{"id":2,"name":"b"}\n]\n');
    expect(await fileText("json", columns)).toBe("[]\n");
  });

  it("writes JSON lines with no header line, and nothing for no rows", async () => {
    const columns = [col("id", "number"), col("doc", "json")];
    expect(await fileText("jsonl", columns, [[1, '{\n  "a": 1\n}'], [2, null]])).toBe('{"id":1,"doc":{   "a": 1 }}\n{"id":2,"doc":null}\n');
    expect(await fileText("jsonl", columns)).toBe("");
  });

  it("writes numbers a JSON reader would round as strings, and the rest as numbers", () => {
    expect(exportJson(9007199254740993n, "number")).toBe('"9007199254740993"');
    expect(exportJson(42n, "number")).toBe("42");
    expect(exportJson("42", "number")).toBe("42");
    expect(exportJson("-1.5", "number")).toBe("-1.5");
    expect(exportJson("9007199254740993", "number")).toBe('"9007199254740993"');
    expect(exportJson("1.5000000000", "number")).toBe('"1.5000000000"');
    expect(exportJson("NaN", "number")).toBe('"NaN"');
    expect(exportJson("Infinity", "number")).toBe('"Infinity"');
    expect(exportJson("42", "text")).toBe('"42"');
    expect(exportJson(Number.NaN, "number")).toBe('"NaN"');
    expect(exportJson(-Infinity, "number")).toBe('"-Infinity"');
  });

  it("embeds a JSON column's document as written, and text that is not one as a string", () => {
    expect(exportJson('{"big": 12345678901234567890}', "json")).toBe('{"big": 12345678901234567890}');
    expect(exportJson("{not json", "json")).toBe('"{not json"');
    expect(exportJson('{"a": 1}', "text")).toBe('"{\\"a\\": 1}"');
    expect(exportJson({ n: 1n }, "json")).toBe('{"n":"1"}');
  });

  it("writes bytes whole with their size, a date as ISO, a list item by item", () => {
    expect(exportJson(new Uint8Array([1, 2, 3]), "binary")).toBe('{"$binary":"AQID","size":3}');
    expect(exportJson(new Date("2024-01-02T03:04:05Z"), "datetime")).toBe('"2024-01-02T03:04:05.000Z"');
    expect(exportJson([1, null, "a", 9007199254740993n], "other")).toBe('[1,null,"a","9007199254740993"]');
    expect(exportJson([new Uint8Array([1, 2]), Number.NaN], "other")).toBe('[{"$binary":"AQI=","size":2},"NaN"]');
  });
});

describe("SQL", () => {
  it("writes one INSERT a row in the dialect's quoting, every column named, NULL included", async () => {
    const columns = [col("id", "number"), col("name"), col("ok", "boolean"), col("b", "binary")];
    const pg = await fileText("sql", columns, [[1, "it's", true, new Uint8Array([1, 2])], [2, null, false, null]]);
    expect(pg).toBe(
      `INSERT INTO "items" ("id", "name", "ok", "b") VALUES (1, 'it''s', TRUE, '\\x0102');\n`
      + `INSERT INTO "items" ("id", "name", "ok", "b") VALUES (2, NULL, FALSE, NULL);\n`,
    );
    const { bytes } = await bytesOf(exportFile({ format: "sql", dialect: mysqlDialect, table: "my`t" }, columns, batchesOf([[1, "a", true, new Uint8Array([1, 2])]])));
    expect(new TextDecoder().decode(bytes)).toBe("INSERT INTO `my``t` (`id`, `name`, `ok`, `b`) VALUES (1, 'a', TRUE, X'0102');\n");
  });

  it("writes a number column's digits bare, and anything else in one as a literal", async () => {
    const sql = await fileText("sql", [col("n", "number")], [["12345678901234567890.1234567891"], ["1e5"], ["NaN"], [9007199254740993n]]);
    expect(sql.split("\n").filter(Boolean).map((line) => line.replace(/^.*VALUES /, ""))).toEqual([
      "(12345678901234567890.1234567891);", "(1e5);", "('NaN');", "(9007199254740993);",
    ]);
  });

  it("writes a Postgres array as Postgres reads one, and a json column's array as JSON", async () => {
    const sql = await fileText("sql", [col("tags", "other"), col("doc", "json")], [[[1, null, "a,b"], [1, { k: "v" }]]]);
    expect(sql).toBe(`INSERT INTO "items" ("tags", "doc") VALUES ('{"1",NULL,"a,b"}', '[1,{"k":"v"}]');\n`);
  });

  it("writes nothing for no rows", async () => {
    expect(await fileText("sql", [col("id")])).toBe("");
  });
});

describe("XML", () => {
  it("writes a row element a row, a value element a value, and leaves NULL out", async () => {
    const xml = await fileText("xml", [col("id", "number"), col("name"), col("b", "binary")], [[1, "a < b & c", new Uint8Array([0xab, 0x01])], [2, null, null]]);
    expect(xml).toBe("<root>\n<row>\n<id>1</id>\n<name>a &lt; b &amp; c</name>\n<b>0xAB01</b>\n</row>\n<row>\n<id>2</id>\n</row>\n</root>\n");
  });

  it("makes element names out of any column names, each one once", () => {
    expect(xmlElementNames(["id", "first name", "2nd", "đơn-hàng", "a:b", "", "first_name", "first name"])).toEqual([
      "id", "first_name", "_2nd", "đơn-hàng", "a_b", "_", "first_name_2", "first_name_3",
    ]);
  });

  it("replaces what XML 1.0 cannot carry and keeps a CR as a reference", () => {
    expect(xmlEscape("a\u0000b\u001fc\ud800d\ufffee")).toBe("a\ufffdb\ufffdc\ufffdd\ufffde");
    expect(xmlEscape("tab\tlf\ncr\r'\"")).toBe("tab\tlf\ncr&#13;&apos;&quot;");
    expect(xmlEscape("pair \ud83d\ude00 kept")).toBe("pair \ud83d\ude00 kept");
  });
});

describe("text in pieces", () => {
  it("hands a big file over in pieces that join into the whole", async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => [i, "x".repeat(50)]);
    const { bytes, chunks } = await bytesOf(exportFile({ format: "csv", dialect: postgresDialect, table: "t" }, [col("id", "number"), col("v")], batchesOf(rows)));
    expect(chunks).toBeGreaterThan(1);
    const text = new TextDecoder().decode(bytes);
    expect(text.split("\n")).toHaveLength(3002);
    expect(text.startsWith(`id,v\n0,${"x".repeat(50)}\n`)).toBe(true);
  });

  it("closes the rows when the file is not read to its end", async () => {
    let closed = false;
    async function* rows(): AsyncGenerator<unknown[][]> {
      try {
        for (let i = 0; ; i++) yield Array.from({ length: 1000 }, () => [i, "y".repeat(100)]);
      } finally {
        closed = true;
      }
    }
    const file = exportFile({ format: "csv", dialect: postgresDialect, table: "t" }, [col("id"), col("v")], rows());
    await file.next();
    await file.return(undefined);
    expect(closed).toBe(true);
  });
});

describe("MS Excel", () => {
  async function workbook(columns: ExportColumn[], batches: unknown[][][], table = "items", sheetRows?: number) {
    const { bytes } = await bytesOf(xlsxFile(columns, batchesOf(...batches), table, sheetRows));
    return readZip(bytes);
  }
  const text = (zip: Map<string, Buffer>, name: string) => zip.get(name)!.toString("utf8");

  it("is a workbook with one sheet named after the table, its first row the column names", async () => {
    const zip = await workbook([col("id", "number"), col("name")], [[[1, "a"]]]);
    expect([...zip.keys()]).toEqual([
      "xl/worksheets/sheet1.xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "_rels/.rels", "[Content_Types].xml",
    ]);
    expect(text(zip, "xl/worksheets/sheet1.xml")).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>'
      + '<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>a</t></is></c></row>'
      + "</sheetData></worksheet>",
    );
    expect(text(zip, "xl/workbook.xml")).toContain('<sheets><sheet name="items" sheetId="1" r:id="rId1"/></sheets>');
    expect(text(zip, "xl/_rels/workbook.xml.rels")).toContain('Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"');
    expect(text(zip, "[Content_Types].xml")).toContain('<Override PartName="/xl/worksheets/sheet1.xml"');
  });

  it("goes on in another sheet when one is full, each listed in the workbook", async () => {
    const rows = [[1], [2], [3], [4], [5]];
    const zip = await workbook([col("id", "number")], [rows.slice(0, 3), rows.slice(3)], "items", 2);
    expect(text(zip, "xl/workbook.xml")).toContain(
      '<sheet name="items" sheetId="1" r:id="rId1"/><sheet name="items_1" sheetId="2" r:id="rId2"/><sheet name="items_2" sheetId="3" r:id="rId3"/>',
    );
    for (const [sheet, ids] of [[1, [1, 2]], [2, [3, 4]], [3, [5]]] as const) {
      const xml = text(zip, `xl/worksheets/sheet${sheet}.xml`);
      expect(xml).toContain('<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c></row>');
      expect([...xml.matchAll(/<v>(\d+)<\/v>/g)].map((m) => Number(m[1]))).toEqual([...ids]);
    }
    expect(text(zip, "xl/_rels/workbook.xml.rels")).toContain('Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"');
    expect(text(zip, "[Content_Types].xml")).toContain('PartName="/xl/worksheets/sheet3.xml"');
  });

  it("lists a sheet whose name XML would misread with that name escaped", async () => {
    const zip = await workbook([col("id")], [], 'Q&A "2024"');
    expect(text(zip, "xl/workbook.xml")).toContain('<sheet name="Q&amp;A &quot;2024&quot;" sheetId="1" r:id="rId1"/>');
  });

  it("starts no empty sheet when the rows end exactly where one fills", async () => {
    const zip = await workbook([col("id", "number")], [[[1], [2]]], "items", 2);
    expect(zip.has("xl/worksheets/sheet2.xml")).toBe(false);
  });

  it("writes a sheet with only the header for no rows", async () => {
    const zip = await workbook([col("id")], []);
    expect(text(zip, "xl/worksheets/sheet1.xml")).toContain('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c></row></sheetData>');
  });

  it("writes each kind of value as the cell Excel reads it as", () => {
    expect(xlsxCell("A1", null, "text")).toBe("");
    expect(xlsxCell("A1", true, "boolean")).toBe('<c r="A1" t="b"><v>1</v></c>');
    expect(xlsxCell("A1", 1.25, "number")).toBe('<c r="A1"><v>1.25</v></c>');
    expect(xlsxCell("A1", Number.NaN, "number")).toBe('<c r="A1" t="inlineStr"><is><t>NaN</t></is></c>');
    expect(xlsxCell("A1", 123456789012345n, "number")).toBe('<c r="A1"><v>123456789012345</v></c>');
    expect(xlsxCell("A1", 1234567890123456n, "number")).toBe('<c r="A1" t="inlineStr"><is><t>1234567890123456</t></is></c>');
    expect(xlsxCell("A1", "1.50", "number")).toBe('<c r="A1"><v>1.5</v></c>');
    expect(xlsxCell("A1", "0.1234567890123456", "number")).toBe('<c r="A1" t="inlineStr"><is><t>0.1234567890123456</t></is></c>');
    // Zeros before and after the digits are not digits Excel would lose.
    expect(xlsxCell("A1", "123.450000000000000", "number")).toBe('<c r="A1"><v>123.45</v></c>');
    expect(xlsxCell("A1", "1000000000000000000", "number")).toBe('<c r="A1"><v>1000000000000000000</v></c>');
    expect(xlsxCell("A1", "007", "text")).toBe('<c r="A1" t="inlineStr"><is><t>007</t></is></c>');
    expect(xlsxCell("A1", " padded ", "text")).toBe('<c r="A1" t="inlineStr"><is><t xml:space="preserve"> padded </t></is></c>');
    expect(xlsxCell("A1", new Uint8Array([1, 2]), "binary")).toBe('<c r="A1" t="inlineStr"><is><t>AQI=</t></is></c>');
  });

  it("cuts text at the most a cell holds, never through a character", () => {
    const long = xlsxCell("A1", "a".repeat(XLSX_CELL_CHARS + 10), "text");
    expect(long).toBe(`<c r="A1" t="inlineStr"><is><t>${"a".repeat(XLSX_CELL_CHARS)}</t></is></c>`);
    const split = xlsxCell("A1", `${"a".repeat(XLSX_CELL_CHARS - 1)}\ud83d\ude00`, "text");
    expect(split).toBe(`<c r="A1" t="inlineStr"><is><t>${"a".repeat(XLSX_CELL_CHARS - 1)}</t></is></c>`);
  });

  it("names columns by letters and sheets as Excel allows", () => {
    expect([0, 25, 26, 51, 52, 701, 702, 16383].map(columnLetters)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA", "XFD"]);
    expect(xlsxSheetName("a/b:c*d?e[f]g\\h", 0)).toBe("a_b_c_d_e_f_g_h");
    expect(xlsxSheetName("'quoted'", 0)).toBe("quoted");
    expect(xlsxSheetName("", 0)).toBe("Sheet 1");
    expect(xlsxSheetName("x".repeat(40), 0)).toBe("x".repeat(31));
    expect(xlsxSheetName("x".repeat(40), 12)).toBe(`${"x".repeat(28)}_12`);
    expect(xlsxSheetName(`${"x".repeat(30)}\ud83d\ude00`, 0)).toBe("x".repeat(30));
  });

  it("refuses more columns than a sheet has", async () => {
    const columns = Array.from({ length: XLSX_MAX_COLUMNS + 1 }, (_, i) => col(`c${i}`));
    await expect(bytesOf(xlsxFile(columns, batchesOf(), "t"))).rejects.toThrow("An Excel sheet holds at most 16384 columns");
  });

  it("fails with the read's error, and closes the rows", async () => {
    let closed = false;
    async function* failing(): AsyncGenerator<unknown[][]> {
      try {
        yield [[1]];
        throw new Error("connection lost");
      } finally {
        closed = true;
      }
    }
    await expect(bytesOf(xlsxFile([col("id", "number")], failing(), "t"))).rejects.toThrow("connection lost");
    expect(closed).toBe(true);
  });

  it("closes the rows when the workbook is not read to its end", async () => {
    let closed = false;
    async function* rows(): AsyncGenerator<unknown[][]> {
      try {
        for (let i = 0; ; i++) yield Array.from({ length: 1000 }, (_, j) => [i * 1000 + j, `row ${j}`.repeat(20)]);
      } finally {
        closed = true;
      }
    }
    const file = xlsxFile([col("id", "number"), col("v")], rows(), "t");
    await file.next();
    await file.return(undefined);
    expect(closed).toBe(true);
  });
});
