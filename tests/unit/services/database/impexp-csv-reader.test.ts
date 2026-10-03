/**
 * Import's CSV reader: NULL told from the empty string as Postgres's `COPY … CSV` tells them, the
 * delimiter worked out as Auto-detect promises, rows of the wrong width left out and said so — and
 * the same rows whichever way the text is cut into pieces, since a file arrives a piece at a time.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { csvRows, detectDelimiter, openCsv } from "../../../../src/services/database/impexp/readers/csv-reader.ts";
import type { FileRows, FileValue } from "../../../../src/services/database/impexp/readers/file-rows.ts";
import { fileText } from "../../../../src/services/database/impexp/readers/file-text.ts";
import type { CsvReadOptions } from "../../../../src/shared/db-impexp.ts";

const dir = mkdtempSync(join(tmpdir(), "ppm-csv-reader-"));
let files = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(content: string | Uint8Array): string {
  const path = join(dir, `f${files++}.csv`);
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

async function drain(rows: FileRows) {
  const all: FileValue[][] = [];
  for await (const batch of rows.batches) all.push(...batch);
  return { columns: rows.columns, rows: all, warnings: rows.warnings() };
}

const options = (more: Partial<CsvReadOptions> = {}): CsvReadOptions => ({ delimiter: "", header: true, ...more });
const read = async (text: string, more: Partial<CsvReadOptions> = {}, cuts?: number[]) => drain(await csvRows(pieces(text, cuts), options(more)));

describe("CSV values", () => {
  it("reads an empty field without quotes as NULL and \"\" as the empty string", async () => {
    expect(await read('a,b,c\n1,,""\n,"",x\n')).toEqual({
      columns: ["a", "b", "c"],
      rows: [["1", null, ""], [null, "", "x"]],
      warnings: [],
    });
  });

  it("reads quoted fields holding the delimiter, doubled quotes and line breaks of every kind", async () => {
    const { rows } = await read('a,b\n"x,y","say ""hi"""\n"line1\nline2","cr\r\nlf"\n');
    expect(rows).toEqual([["x,y", 'say "hi"'], ["line1\nline2", "cr\r\nlf"]]);
  });

  it("ends records at LF, CRLF or CR, with or without a line break after the last", async () => {
    expect((await read("a,b\r\n1,2\r\n3,4")).rows).toEqual([["1", "2"], ["3", "4"]]);
    expect((await read("a,b\r1,2\r3,4\r")).rows).toEqual([["1", "2"], ["3", "4"]]);
    expect((await read("a,b\n1,2\n")).rows).toEqual([["1", "2"]]);
    expect((await read("a,b\n1,")).rows).toEqual([["1", null]]);
  });

  it("keeps a quote inside an unquoted field, and text after a closing quote, as Excel does", async () => {
    expect((await read('a,b\n5" pipe,"ab"c\n')).rows).toEqual([['5" pipe', "abc"]]);
  });

  it("keeps the spaces around a value: only header names are trimmed", async () => {
    expect(await read(" id , name\n 1 , x \n")).toEqual({ columns: ["id", "name"], rows: [[" 1 ", " x "]], warnings: [] });
  });

  it("fails on a quoted field that never ends, naming the line it opens on", async () => {
    await expect(read('a,b\n1,2\n3,"open\n\nmore')).rejects.toThrow('Line 3 opens a quoted field that never ends');
  });

  it("fails on a row longer than 32 MiB rather than holding the rest of the file", async () => {
    await expect(read(`a\n"${"x".repeat(32 * 1024 * 1024 + 1)}`)).rejects.toThrow("Line 2 starts a row longer than 32 MiB");
  });
});

describe("CSV header", () => {
  it("names an empty header cell col<N> and numbers a name met twice", async () => {
    expect((await read("id,,id, \n1,2,3,4\n")).columns).toEqual(["id", "col2", "id_1", "col4"]);
  });

  it("without a header row names the columns col1… and reads the first row as data", async () => {
    expect(await read("1,2\n3,4\n", { header: false })).toEqual({ columns: ["col1", "col2"], rows: [["1", "2"], ["3", "4"]], warnings: [] });
  });

  it("skips blank lines before the header", async () => {
    expect(await read("\n\r\n\na,b\n1,2\n")).toEqual({ columns: ["a", "b"], rows: [["1", "2"]], warnings: [] });
  });

  it("reads an empty file as no columns and no rows", async () => {
    expect(await read("")).toEqual({ columns: [], rows: [], warnings: [] });
    expect(await read("\n\n")).toEqual({ columns: [], rows: [], warnings: [] });
  });
});

describe("CSV rows of another width", () => {
  it("leaves out a row whose fields do not match the first row's, and lists the lines in a warning", async () => {
    const { rows, warnings } = await read('a,b\n1,2\n"multi\nline",x\n3\n4,5,6\n7,8\n');
    expect(rows).toEqual([["1", "2"], ["multi\nline", "x"], ["7", "8"]]);
    expect(warnings).toEqual(["Skipped 2 rows without the 2 fields of the first row: lines 5, 6"]);
  });

  it("says line, not lines, for one, and counts past the first ten", async () => {
    expect((await read("a,b\n1\n")).warnings).toEqual(["Skipped 1 row without the 2 fields of the first row: line 2"]);
    const many = `a,b\n${Array.from({ length: 12 }, (_, i) => String(i)).join("\n")}\n`;
    expect((await read(many)).warnings).toEqual(["Skipped 12 rows without the 2 fields of the first row: lines 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 2 more"]);
  });

  it("drops a blank line silently when there are several columns, and reads it as NULL when there is one", async () => {
    expect(await read("a,b\n1,2\n\n3,4\n")).toEqual({ columns: ["a", "b"], rows: [["1", "2"], ["3", "4"]], warnings: [] });
    expect(await read("a\n1\n\n3\n")).toEqual({ columns: ["a"], rows: [["1"], [null], ["3"]], warnings: [] });
  });
});

describe("CSV delimiter", () => {
  it("takes the one of , ; Tab | the first line holds most often outside quotes", () => {
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter("a|b|c")).toBe("|");
    expect(detectDelimiter("a,b;c;d")).toBe(";");
    expect(detectDelimiter('"x;y;z",b')).toBe(",");
    expect(detectDelimiter("single")).toBe(",");
  });

  it("prefers , then ; then Tab then | on a tie", () => {
    expect(detectDelimiter("a;b,c")).toBe(",");
    expect(detectDelimiter("a|b\tc")).toBe("\t");
    expect(detectDelimiter("a|b;c")).toBe(";");
  });

  it("counts as the parser reads: a quote inside a field opens nothing", () => {
    expect(detectDelimiter('Width (5");b;c')).toBe(";");
  });

  it("reads the first line that holds something", async () => {
    expect((await read("\n\na;b\n1;2\n")).rows).toEqual([["1", "2"]]);
  });

  it("finds the first line past a quoted line break, and is not held up by a quote inside a field", async () => {
    expect((await read('"a\nb";c;d\n1;2;3\n')).columns).toEqual(["a\nb", "c", "d"]);
    expect((await read('5" pipe;b;c\n1;2;3\n')).rows).toEqual([["1", "2", "3"]]);
  });

  it("uses the delimiter chosen over the one the file looks like", async () => {
    expect((await read("a;b,c\n1;2,3\n", { delimiter: ";" })).columns).toEqual(["a", "b,c"]);
  });

  it("follows Excel's sep= first line on Auto-detect, and skips it whichever delimiter is chosen", async () => {
    expect(await read("sep=;\na,b;c\n1,2;3\n")).toEqual({ columns: ["a,b", "c"], rows: [["1,2", "3"]], warnings: [] });
    expect(await read("sep=;\r\na,b;c\r\n1,2;3\r\n", { delimiter: "," })).toEqual({ columns: ["a", "b;c"], rows: [["1", "2;3"]], warnings: [] });
  });

  it("counts the sep= line in the line numbers a warning gives", async () => {
    expect((await read("sep=,\na,b\n1\n")).warnings).toEqual(["Skipped 1 row without the 2 fields of the first row: line 3"]);
  });
});

describe("CSV text cut into pieces", () => {
  const tricky = 'sep=;\r\nid;"na""me";note\r\n1;"a;b";"x\r\ny"\r\n2;;""\r\n3;"q""";\r\n\r\n4;z;"end"';

  it("reads the same rows wherever the text is cut", async () => {
    const whole = await read(tricky);
    expect(whole.rows).toEqual([["1", "a;b", "x\r\ny"], ["2", null, ""], ["3", 'q"', null], ["4", "z", "end"]]);
    for (let at = 0; at <= tricky.length; at++) {
      expect(await read(tricky, {}, [at])).toEqual(whole);
    }
    expect(await read(tricky, {}, Array.from({ length: tricky.length }, (_, i) => i))).toEqual(whole);
  });

  it("counts lines the same wherever a CRLF is cut", async () => {
    const text = 'a,b\r\n"x\r\ny",1\r\n2\r\n';
    for (let at = 0; at <= text.length; at++) {
      expect((await read(text, {}, [at])).warnings).toEqual(["Skipped 1 row without the 2 fields of the first row: line 4"]);
    }
  });
});

describe("CSV files", () => {
  it("drops a UTF-8 byte order mark, so it is not part of the first column's name", async () => {
    const rows = await drain(await openCsv(file("﻿id,name\n1,é\n"), options()));
    expect(rows).toEqual({ columns: ["id", "name"], rows: [["1", "é"]], warnings: [] });
  });

  it("reads PPM's CSV for Excel: UTF-16LE with a byte order mark and a sep= line", async () => {
    const text = "sep=\t\r\nid\tname\r\n1\tViệt\r\n";
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(await drain(await openCsv(file(bytes), options()))).toEqual({ columns: ["id", "name"], rows: [["1", "Việt"]], warnings: [] });
  });

  it("refuses a file that is not UTF-8 rather than importing replacement characters", async () => {
    await expect(openCsv(file(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xe9, 0x2c, 0x31, 0x0a])), options())).rejects.toThrow("The file is not UTF-8 text");
  });

  it("decodes a large file whose multi-byte characters straddle the pieces it is read in", async () => {
    const text = `a\n${"é€😀".repeat(200_000)}\n`;
    let read = "";
    for await (const piece of fileText(file(text))) read += piece;
    expect(read).toBe(text);
  });

  it("lets the event loop turn while a large file is read and each piece held up by blocking work", async () => {
    // A file is read without waiting on the disk: with no pause of its own, reading it — and a
    // SQLite write for each piece — would be one turn, and no timer would run until the end.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      for await (const piece of fileText(file("x".repeat(4 * 1024 * 1024)))) {
        expect(piece.length).toBeGreaterThan(0);
        const until = performance.now() + 5;
        while (performance.now() < until) { /* a blocking write */ }
      }
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it("reads a file of fewer bytes than a byte order mark", async () => {
    expect(await drain(await openCsv(file("a"), options({ header: false })))).toEqual({ columns: ["col1"], rows: [["a"]], warnings: [] });
  });

  it("stops between two pieces once Stop is pressed", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(openCsv(file("a,b\n1,2\n"), options(), stop.signal)).rejects.toThrow();
  });

  it("may be closed before its end, and twice", async () => {
    const rows = await openCsv(file("a,b\n1,2\n"), options());
    await rows.close();
    await rows.close();
  });
});
