/**
 * Import's JSON and JSON Lines readers: rows found where the options say, values kept as written
 * (a big number is not rounded, an object goes into a JSON column as it was), the first 1,000
 * items naming the columns, clear errors for a file of another shape — and the same rows wherever
 * the text is cut into pieces.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonText, previewValue, type FileRows, type FileValue } from "../../../../src/services/database/impexp/readers/file-rows.ts";
import { jsonLinesRows, jsonRows, objectEntries, openJson, openJsonLines } from "../../../../src/services/database/impexp/readers/json-reader.ts";
import type { JsonOptions } from "../../../../src/shared/db-impexp.ts";

const dir = mkdtempSync(join(tmpdir(), "ppm-json-reader-"));
let files = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(content: string): string {
  const path = join(dir, `f${files++}.json`);
  writeFileSync(path, content);
  return path;
}

async function* pieces(text: string, cuts: readonly number[] = []): AsyncGenerator<string> {
  let from = 0;
  for (const at of cuts) {
    yield text.slice(from, at);
    from = at;
  }
  yield text.slice(from);
}

/** Rows as Preview shows them: a JSON number, object or array as its text. */
async function drain(rows: FileRows) {
  const all: (string | boolean | null)[][] = [];
  for await (const batch of rows.batches) all.push(...batch.map((row: FileValue[]) => row.map(previewValue)));
  return { columns: rows.columns, rows: all, warnings: rows.warnings() };
}

const options = (more: Partial<JsonOptions> = {}): JsonOptions => ({ style: "array", keyField: "", rootField: "", ...more });
const read = async (text: string, more: Partial<JsonOptions> = {}, cuts?: number[]) => drain(await jsonRows(pieces(text, cuts), options(more)));
const readLines = async (text: string, cuts?: number[]) => drain(await jsonLinesRows(pieces(text, cuts)));

describe("JSON values", () => {
  it("names the columns in the order keys first appear, NULL where an item has no such key", async () => {
    expect(await read('[{"a":1,"b":"x"},{"c":true,"a":2}]')).toEqual({
      columns: ["a", "b", "c"],
      rows: [["1", "x", null], ["2", null, true]],
      warnings: [],
    });
  });

  it("keeps a number, an object and an array as written, and decodes a string", async () => {
    const { rows } = await drain(await jsonRows(pieces('[{"n":9007199254740993,"d":1.50,"e":1e3,"o":{"b":1,"2":[3, "]"]},"s":"caf\\u00e9\\n\\"q\\"","f":false,"z":null}]'), options()));
    expect(rows).toEqual([["9007199254740993", "1.50", "1e3", '{"b":1,"2":[3, "]"]}', 'café\n"q"', false, null]]);
  });

  it("hands a number, object or array over as JsonText, and a string as a string", async () => {
    const rows = await jsonRows(pieces('[{"n":1,"o":{},"a":[],"s":"1"}]'), options());
    const [first] = (await rows.batches.next()).value as FileValue[][];
    expect(first!.map((v) => (v instanceof JsonText ? "json" : typeof v))).toEqual(["json", "json", "json", "string"]);
    await rows.close();
  });

  it("reads a key written twice in its first place with its last value, as JSON.parse does", () => {
    expect([...objectEntries('{"a":1,"b":2,"a":3}')!].map(([k, v]) => [k, previewValue(v)])).toEqual([["a", "3"], ["b", "2"]]);
  });

  it("reads __proto__ as a key like any other", async () => {
    expect(await read('[{"__proto__":{"x":1},"constructor":"c"}]')).toEqual({ columns: ["__proto__", "constructor"], rows: [['{"x":1}', "c"]], warnings: [] });
  });

  it("names an empty key col<N>", async () => {
    expect((await read('[{"":1,"b":2}]')).columns).toEqual(["col1", "b"]);
  });

  it("reads an empty array as no columns and no rows", async () => {
    expect(await read(" [ ] ")).toEqual({ columns: [], rows: [], warnings: [] });
  });
});

describe("JSON styles and root field", () => {
  it("in Object style puts each item's key in _key, after the item's own keys", async () => {
    expect(await read('{"k1":{"a":1},"k2":{"a":2,"b":3}}', { style: "object" })).toEqual({
      columns: ["a", "_key", "b"],
      rows: [["1", "k1", null], ["2", "k2", "3"]],
      warnings: [],
    });
  });

  it("puts the key in the key field named, over a value the item has under that name", async () => {
    expect(await read('{"k1":{"id":"old","a":1}}', { style: "object", keyField: "id" })).toEqual({ columns: ["id", "a"], rows: [["k1", "1"]], warnings: [] });
  });

  it("finds the rows under the root field, reading past the keys before it", async () => {
    const text = '{"meta":{"note":"]}[{\\"","list":[1,[2]]},"rows":[{"a":1},{"a":2}],"after":"x"}';
    expect(await read(text, { rootField: "rows" })).toEqual({ columns: ["a"], rows: [["1"], ["2"]], warnings: [] });
    expect(await read('{"data":{"x":{"a":1}}}', { style: "object", rootField: "data" })).toEqual({ columns: ["a", "_key"], rows: [["1", "x"]], warnings: [] });
  });

  it("says which style to choose when the file is the other shape", async () => {
    await expect(read('{"a":{"b":1}}')).rejects.toThrow("The file is a JSON object, not an array: choose Object style, or name the Root field the rows are under");
    await expect(read("[{}]", { style: "object" })).rejects.toThrow("The file is a JSON array, not an object: choose Array style");
    await expect(read('{"rows":{"x":{}}}', { rootField: "rows" })).rejects.toThrow('"rows" is a JSON object, not an array: choose Object style');
    await expect(read('"text"')).rejects.toThrow("The file is not a JSON array");
  });

  it("says when the root field is not there", async () => {
    await expect(read('{"a":[],"b":[]}', { rootField: "rows" })).rejects.toThrow('The file has no "rows" key at its top level');
    await expect(read("{}", { rootField: "rows" })).rejects.toThrow('The file has no "rows" key at its top level');
    await expect(read("[{}]", { rootField: "rows" })).rejects.toThrow('The file is not a JSON object, so it has no "rows" key: leave Root field empty');
  });
});

describe("JSON errors", () => {
  it("says the file is empty", async () => {
    await expect(read("  \n")).rejects.toThrow("The file is empty");
  });

  it("names the item that is not JSON, while opening the file when it is among the first 1,000", async () => {
    await expect(jsonRows(pieces('[{"a":1},{"a":tru}]'), options())).rejects.toThrow("Item 2 is not JSON");
    const late = `[${'{"a":1},'.repeat(1_000)}{"a":tru}]`;
    const rows = await jsonRows(pieces(late), options());
    await expect(drain(rows)).rejects.toThrow("Item 1,001 is not JSON");
  });

  it("names the item a comma is missing after", async () => {
    await expect(read('[{"a":1} {"a":2}]')).rejects.toThrow('Expected "," or "]" after item 1, found "{"');
  });

  it("refuses a value missing between two commas, and a comma after the last item", async () => {
    await expect(read('[{"a":1},,{"a":2}]')).rejects.toThrow('Expected a value, found ","');
    await expect(read('[{"a":1},]')).rejects.toThrow('Expected a value, found "]"');
  });

  it("says a file cut short is cut short", async () => {
    await expect(read('[{"a":1},{"a"')).rejects.toThrow("The file ends in the middle of a value");
    await expect(read('[{"a":1}')).rejects.toThrow('Expected "," or "]" after item 1, found the end of the file');
  });

  it("refuses text after the array, which is most likely JSON Lines", async () => {
    await expect(read('[{"a":1}]\n[{"a":2}]')).rejects.toThrow("The file goes on after its JSON array ends: is it JSON Lines?");
    await expect(read('{"a":1}\n{"a":2}')).rejects.toThrow("The file is a JSON object, not an array");
  });
});

describe("JSON warnings", () => {
  it("skips an item that is not an object, and lists it", async () => {
    expect(await read('[{"a":1},2,"x",[3],{"a":4}]')).toEqual({
      columns: ["a"],
      rows: [["1"], ["4"]],
      warnings: ["Skipped 3 items that are not JSON objects: items 2, 3, 4"],
    });
  });

  it("names the columns from the first 1,000 objects, and leaves out keys only later ones have", async () => {
    const items = Array.from({ length: 1_002 }, (_, i) => (i === 1_000 ? { a: i, late: 1 } : i === 1_001 ? { a: i, later: 2, late: 3 } : { a: i }));
    const { columns, rows, warnings } = await read(JSON.stringify(items));
    expect(columns).toEqual(["a"]);
    expect(rows).toHaveLength(1_002);
    expect(rows.at(-1)).toEqual(["1001"]);
    expect(warnings).toEqual(['Left out keys the first 1,000 items do not have — "late", "later": items 1,001, 1,002']);
  });

  it("counts objects, not items, toward the first 1,000", async () => {
    const items: unknown[] = [1, ...Array.from({ length: 1_000 }, () => ({ a: 1 })), { b: 2 }];
    expect((await read(JSON.stringify(items))).columns).toEqual(["a"]);
    const fewer: unknown[] = [1, ...Array.from({ length: 999 }, () => ({ a: 1 })), { b: 2 }];
    expect((await read(JSON.stringify(fewer))).columns).toEqual(["a", "b"]);
  });

  it("hands rows over in batches of 1,000", async () => {
    const rows = await jsonRows(pieces(JSON.stringify(Array.from({ length: 2_500 }, (_, i) => ({ i })))), options());
    const sizes: number[] = [];
    for await (const batch of rows.batches) sizes.push(batch.length);
    expect(sizes).toEqual([1_000, 1_000, 500]);
  });
});

describe("JSON text cut into pieces", () => {
  it("reads the same rows wherever the text is cut", async () => {
    const text = ' {"skip":{"s":"}\\"]","n":[1,{"x":2}]},"rows": [ {"a":"q\\"}","b":[1,"]"]} , {"a":-1.5e2,"b":null} ] }';
    const whole = await read(text, { rootField: "rows" });
    expect(whole.rows).toEqual([['q"}', '[1,"]"]'], ["-1.5e2", null]]);
    for (let at = 0; at <= text.length; at++) expect(await read(text, { rootField: "rows" }, [at])).toEqual(whole);
    expect(await read(text, { rootField: "rows" }, Array.from({ length: text.length }, (_, i) => i))).toEqual(whole);
  });

  it("reads a number at the very end of a cut file", async () => {
    const text = '{"k":{"a":12}}';
    for (let at = 0; at <= text.length; at++) expect((await read(text, { style: "object" }, [at])).rows).toEqual([["12", "k"]]);
  });
});

describe("JSON Lines", () => {
  it("reads an object on each line, skipping blank lines, with CRLF or without a last line break", async () => {
    expect(await readLines('{"a":1}\r\n\r\n  \n{"b":"x"}')).toEqual({ columns: ["a", "b"], rows: [["1", null], [null, "x"]], warnings: [] });
  });

  it("skips DBGate's header line when it comes first", async () => {
    expect(await readLines('{"__isStreamHeader":true,"columns":[{"columnName":"a"}]}\n{"a":1}\n')).toEqual({ columns: ["a"], rows: [["1"]], warnings: [] });
    expect((await readLines('{"a":1}\n{"__isStreamHeader":true}\n')).columns).toEqual(["a", "__isStreamHeader"]);
  });

  it("names the line that is not JSON, counting blank lines", async () => {
    await expect(readLines('{"a":1}\n\n{"a":2} x\n')).rejects.toThrow("Line 3 is not JSON");
  });

  it("skips a line that is not an object, and lists it", async () => {
    expect((await readLines('{"a":1}\n[1]\n"x"\n{"a":2}\n')).warnings).toEqual(["Skipped 2 lines that are not JSON objects: lines 2, 3"]);
  });

  it("reads the same rows wherever the text is cut", async () => {
    const text = '{"a":"x\\ny"}\r\n\n{"a":[1,\n2]}\n';
    const whole = await readLines('{"a":"x\\ny"}\r\n\n{"a":[1,2]}\n');
    expect(whole.rows).toEqual([["x\ny"], ["[1,2]"]]);
    for (let at = 0; at <= text.length; at++) {
      // A line break inside a value ends the line: that line is not JSON.
      await expect(readLines(text, [at])).rejects.toThrow("Line 3 is not JSON");
    }
    const clean = '{"a":"x\\ny"}\r\n\n{"a":[1,2]}\n{"b":true}';
    const cleanWhole = await readLines(clean);
    for (let at = 0; at <= clean.length; at++) expect(await readLines(clean, [at])).toEqual(cleanWhole);
  });
});

describe("JSON files", () => {
  it("reads a JSON file and a JSON Lines file from disk", async () => {
    expect(await drain(await openJson(file('﻿[{"a":"é"}]'), options()))).toEqual({ columns: ["a"], rows: [["é"]], warnings: [] });
    expect(await drain(await openJsonLines(file('{"a":"é"}\n')))).toEqual({ columns: ["a"], rows: [["é"]], warnings: [] });
  });

  it("may be closed before its end, and twice", async () => {
    const rows = await openJson(file('[{"a":1},{"a":2}]'), options());
    await rows.close();
    await rows.close();
  });
});
