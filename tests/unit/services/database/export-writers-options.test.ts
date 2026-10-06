/**
 * Export advanced's format options on Export ▸'s writers: CSV's delimiter, quoting, header, BOM,
 * record delimiter and booleans; JSON's Object style, Key field and Root field; XML's element
 * names; and Create single file's workbook of several sheets.
 */
import { describe, expect, it } from "bun:test";
import type { ColumnKind } from "../../../../src/shared/db-column-kind.ts";
import {
  DEFAULT_EXPORT_OPTIONS, type CsvWriteOptions, type JsonOptions, type XmlWriteOptions,
} from "../../../../src/shared/db-impexp.ts";
import { postgresDialect } from "../../../../src/services/database/dialect-postgres.ts";
import { exportFile, type ExportColumn } from "../../../../src/services/database/grid-export.ts";
import { xlsxWorkbook, type XlsxSheetSource } from "../../../../src/services/database/grid-export-xlsx.ts";
import { readZip } from "../../../helpers/read-zip.ts";

const col = (name: string, kind: ColumnKind = "text"): ExportColumn => ({ name, kind });

async function* batchesOf(...batches: unknown[][][]): AsyncGenerator<unknown[][]> {
  for (const batch of batches) yield batch;
}

async function bytesOf(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of gen) parts.push(part);
  return Buffer.concat(parts);
}

const csvOptions = (o: Partial<CsvWriteOptions>): CsvWriteOptions => ({ ...DEFAULT_EXPORT_OPTIONS.csv, ...o });

async function csvBytes(o: Partial<CsvWriteOptions>, columns: ExportColumn[], ...batches: unknown[][][]): Promise<Uint8Array> {
  return bytesOf(exportFile({ format: "csv", dialect: postgresDialect, table: "t", csv: csvOptions(o) }, columns, batchesOf(...batches)));
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("CSV options", () => {
  const columns = [col("id", "number"), col("name"), col("ok", "boolean")];

  it("Semicolon, Write BOM and CRLF give exactly these bytes", async () => {
    const bytes = await csvBytes({ delimiter: ";", bom: true, recordDelimiter: "\r\n" }, columns, [[1, "a;b", true], [2, "c", false]]);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text(bytes.subarray(3))).toBe('id;name;ok\r\n1;"a;b";true\r\n2;c;false\r\n');
  });

  it("Tab and Pipe split fields by themselves, and quote only a field holding them", async () => {
    expect(text(await csvBytes({ delimiter: "\t" }, [col("a"), col("b")], [["x\ty", "z|w"]]))).toBe('a\tb\n"x\ty"\tz|w\n');
    expect(text(await csvBytes({ delimiter: "|" }, [col("a"), col("b")], [["x\ty", "z|w"]]))).toBe('a|b\nx\ty|"z|w"\n');
  });

  it("CR as the record delimiter ends every line with it", async () => {
    expect(text(await csvBytes({ recordDelimiter: "\r" }, [col("a")], [["x"], ["y"]]))).toBe("a\rx\ry\r");
  });

  it("Quoted puts every value and every name in quotes, but not NULL", async () => {
    expect(text(await csvBytes({ quoted: true }, columns, [[1, 'say "hi"', true], [null, "", null]])))
      .toBe('"id","name","ok"\n"1","say ""hi""","true"\n,"",\n');
  });

  it("without Has header row there is no line of names", async () => {
    expect(text(await csvBytes({ header: false }, columns, [[1, "a", true]]))).toBe("1,a,true\n");
    expect(text(await csvBytes({ header: false }, columns))).toBe("");
  });

  it("writes booleans in the Boolean Format chosen", async () => {
    const rows: unknown[][] = [[1, "a", true], [2, "b", false]];
    expect(text(await csvBytes({ booleanFormat: "true_false_upper" }, columns, rows))).toBe("id,name,ok\n1,a,TRUE\n2,b,FALSE\n");
    expect(text(await csvBytes({ booleanFormat: "1_0" }, columns, rows))).toBe("id,name,ok\n1,a,1\n2,b,0\n");
  });

  it("writes no BOM unless asked", async () => {
    const bytes = await csvBytes({}, [col("a")], [["é"]]);
    expect(bytes[0]).toBe("a".charCodeAt(0));
    expect(text(bytes)).toBe("a\né\n");
  });
});

async function jsonText(o: Partial<JsonOptions>, columns: ExportColumn[], ...batches: unknown[][][]): Promise<string> {
  const json = { ...DEFAULT_EXPORT_OPTIONS.json, ...o };
  return text(await bytesOf(exportFile({ format: "json", dialect: postgresDialect, table: "t", json }, columns, batchesOf(...batches))));
}

describe("JSON options", () => {
  const columns = [col("id", "number"), col("name")];

  it("Array style is a list of rows", async () => {
    const out = await jsonText({}, columns, [[1, "a"], [2, "b"]]);
    expect(JSON.parse(out)).toEqual([{ id: 1, name: "a" }, { id: 2, name: "b" }]);
  });

  it("Object style keys each row by its _key column, and leaves that column out of the row", async () => {
    const out = await jsonText({ style: "object" }, [col("_key"), ...columns], [["k1", 1, "a"], ["k2", 2, "b"]]);
    expect(JSON.parse(out)).toEqual({ k1: { id: 1, name: "a" }, k2: { id: 2, name: "b" } });
  });

  it("Object style takes the Key field named, and the first column when no column has that name", async () => {
    expect(JSON.parse(await jsonText({ style: "object", keyField: "name" }, columns, [[1, "a"]]))).toEqual({ a: { id: 1 } });
    expect(JSON.parse(await jsonText({ style: "object" }, columns, [[7, "a"]]))).toEqual({ 7: { id: 7, name: "a" } });
  });

  it("Object style keys a row whose Key field is NULL by its first column, as DBGate does, and by \"\" when that is NULL too", async () => {
    expect(JSON.parse(await jsonText({ style: "object", keyField: "name" }, columns, [[1, null]]))).toEqual({ 1: { id: 1 } });
    expect(JSON.parse(await jsonText({ style: "object", keyField: "name" }, columns, [[null, null]]))).toEqual({ "": { id: null } });
  });

  it("Root field puts the rows under that key, in either style", async () => {
    expect(JSON.parse(await jsonText({ rootField: "data" }, columns, [[1, "a"]]))).toEqual({ data: [{ id: 1, name: "a" }] });
    expect(JSON.parse(await jsonText({ style: "object", rootField: "data" }, columns, [[1, "a"]]))).toEqual({ data: { 1: { id: 1, name: "a" } } });
  });

  it("an export with no rows is still a JSON document of its style", async () => {
    expect(JSON.parse(await jsonText({}, columns))).toEqual([]);
    expect(JSON.parse(await jsonText({ style: "object" }, columns))).toEqual({});
    expect(JSON.parse(await jsonText({ rootField: "data" }, columns))).toEqual({ data: [] });
    expect(JSON.parse(await jsonText({ style: "object", rootField: "data" }, columns))).toEqual({ data: {} });
  });
});

describe("XML options", () => {
  async function xmlText(o: Partial<XmlWriteOptions>, ...batches: unknown[][][]): Promise<string> {
    const xml = { ...DEFAULT_EXPORT_OPTIONS.xml, ...o };
    return text(await bytesOf(exportFile({ format: "xml", dialect: postgresDialect, table: "t", xml }, [col("a")], batchesOf(...batches))));
  }

  it("names the root and each row as asked, and root / row when left empty", async () => {
    expect(await xmlText({ rootElement: "items", itemElement: "item" }, [["x"]])).toBe("<items>\n<item>\n<a>x</a>\n</item>\n</items>\n");
    expect(await xmlText({}, [["x"]])).toBe("<root>\n<row>\n<a>x</a>\n</row>\n</root>\n");
  });

  it("makes a name that is not an XML name into one", async () => {
    expect(await xmlText({ rootElement: "1 list", itemElement: "a b" }, [["x"]])).toBe("<_1_list>\n<a_b>\n<a>x</a>\n</a_b>\n</_1_list>\n");
  });
});

describe("Create single file: one workbook, a sheet for each table", () => {
  async function workbook(...tables: XlsxSheetSource[]): Promise<Map<string, Buffer>> {
    async function* sources(): AsyncGenerator<XlsxSheetSource> {
      yield* tables;
    }
    return readZip(await bytesOf(xlsxWorkbook(sources())));
  }

  const sheetNames = (entries: Map<string, Buffer>): string[] =>
    [...entries.get("xl/workbook.xml")!.toString().matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]!);

  it("writes each table on its own sheet, named after it, in order", async () => {
    const entries = await workbook(
      { name: "users", columns: [col("id", "number")], batches: batchesOf([[1], [2]]) },
      { name: "orders", columns: [col("total", "number")], batches: batchesOf([[9]]) },
    );
    expect(sheetNames(entries)).toEqual(["users", "orders"]);
    expect(entries.get("xl/worksheets/sheet1.xml")!.toString()).toContain('<c r="A3"><v>2</v></c>');
    expect(entries.get("xl/worksheets/sheet2.xml")!.toString()).toContain('<c r="A2"><v>9</v></c>');
    expect(entries.get("[Content_Types].xml")!.toString()).toContain("/xl/worksheets/sheet2.xml");
  });

  it("cuts a long name to Excel's 31 characters, and a name already taken — whatever its case — takes _1", async () => {
    const long = "a_table_name_that_is_forty_chars_long_xx";
    expect(long).toHaveLength(40);
    const entries = await workbook(
      { name: long, columns: [col("a")], batches: batchesOf() },
      { name: "Users", columns: [col("a")], batches: batchesOf() },
      { name: "users", columns: [col("a")], batches: batchesOf() },
      { name: long, columns: [col("a")], batches: batchesOf() },
    );
    expect(sheetNames(entries)).toEqual([long.slice(0, 31), "Users", "users_1", `${long.slice(0, 29)}_1`]);
  });

  it("a workbook given no table still holds the one empty sheet Excel needs", async () => {
    expect(sheetNames(await workbook())).toEqual(["Sheet 1"]);
  });

  it("goes on in name_1 when a table outgrows its sheet, past every name already taken", async () => {
    async function* sources(): AsyncGenerator<XlsxSheetSource> {
      yield { name: "t", columns: [col("a", "number")], batches: batchesOf([[1], [2], [3]]) };
      yield { name: "t_1", columns: [col("a", "number")], batches: batchesOf([[4]]) };
    }
    const entries = readZip(await bytesOf(xlsxWorkbook(sources(), 2)));
    expect(sheetNames(entries)).toEqual(["t", "t_1", "t_1_1"]);
  });

  it("reads the next table only once the one before it is written", async () => {
    const events: string[] = [];
    async function* rows(name: string): AsyncGenerator<unknown[][]> {
      events.push(`${name} start`);
      yield [[1]];
      events.push(`${name} end`);
    }
    async function* sources(): AsyncGenerator<XlsxSheetSource> {
      events.push("ask a");
      yield { name: "a", columns: [col("x", "number")], batches: rows("a") };
      events.push("ask b");
      yield { name: "b", columns: [col("x", "number")], batches: rows("b") };
    }
    await bytesOf(xlsxWorkbook(sources()));
    expect(events).toEqual(["ask a", "a start", "a end", "ask b", "b start", "b end"]);
  });

  it("a table that fails ends the workbook with its error, and the tables are closed", async () => {
    let closed = false;
    async function* failing(): AsyncGenerator<unknown[][]> {
      try {
        yield [[1]];
        throw new Error("read failed");
      } finally {
        closed = true;
      }
    }
    async function* sources(): AsyncGenerator<XlsxSheetSource> {
      yield { name: "a", columns: [col("x", "number")], batches: failing() };
    }
    await expect(bytesOf(xlsxWorkbook(sources()))).rejects.toThrow("read failed");
    expect(closed).toBe(true);
  });
});
