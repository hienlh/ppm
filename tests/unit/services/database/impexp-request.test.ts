import { describe, expect, it } from "bun:test";
import { DEFAULT_EXPORT_OPTIONS, DEFAULT_IMPORT_OPTIONS } from "../../../../src/shared/db-impexp.ts";
import {
  ImpExpRequestError, QUERY_SOURCE_NAME, importTableNameProblem, parseExportJobRequest, parseImportJobRequest,
} from "../../../../src/services/database/impexp/impexp-request.ts";

const tables = (...names: string[]) => names.map((name) => ({ name, target: `${name}.csv` }));
const request = (over: Record<string, unknown> = {}) => ({
  format: "csv",
  options: DEFAULT_EXPORT_OPTIONS,
  source: { type: "database", tables: tables("users", "orders") },
  ...over,
});
const parse = (body: unknown, schema: string | null = "public") => parseExportJobRequest(body, schema);
const refuses = (body: unknown, message: string | RegExp) => expect(() => parse(body)).toThrow(message instanceof RegExp ? message : new ImpExpRequestError(message));

describe("parseExportJobRequest — the tables of a schema", () => {
  it("makes a row of each table, read from the schema given or the connection's default", () => {
    const plan = parse(request());
    expect(plan.items).toEqual([
      { source: "users", target: "users.csv", read: { type: "table", table: "users", schema: "public" } },
      { source: "orders", target: "orders.csv", read: { type: "table", table: "orders", schema: "public" } },
    ]);
    expect(parse(request({ source: { type: "database", schema: "sales", tables: tables("a") } })).items[0]!.read)
      .toEqual({ type: "table", table: "a", schema: "sales" });
    expect(parse(request(), null).items[0]!.read).toEqual({ type: "table", table: "users", schema: null });
    expect(parse(request({ source: { type: "database", schema: "", tables: tables("a") } })).items[0]!.read)
      .toEqual({ type: "table", table: "a", schema: "public" });
  });

  it("refuses an empty list, a table with no name, and more tables than one job takes", () => {
    refuses(request({ source: { type: "database", tables: [] } }), "Choose at least one table or view");
    refuses(request({ source: { type: "database", tables: [{ target: "x.csv" }] } }), "Table 1 needs a name");
    const many = Array.from({ length: 1001 }, (_, i) => ({ name: `t${i}`, target: `t${i}.csv` }));
    refuses(request({ source: { type: "database", tables: many } }), "At most 1000 tables can be exported at once");
  });

  it("refuses a target that is a path, a dot name or holds a control character", () => {
    for (const target of ["../../x.csv", "a/b.csv", "a\\b.csv", "..", ".", "a\nb.csv", "", "   "]) {
      expect(() => parse(request({ source: { type: "database", tables: [{ name: "users", target }] } }))).toThrow(ImpExpRequestError);
    }
  });

  it("refuses two rows writing one file, whatever the case of its name", () => {
    refuses(request({ source: { type: "database", tables: [{ name: "a", target: "x.csv" }, { name: "b", target: "X.CSV" }] } }),
      `Two rows write to "X.CSV": give each its own file name`);
  });

  it("with Create single file takes each target as a sheet name: any name, an empty one the table's, repeats allowed", () => {
    const plan = parse(request({
      format: "xlsx",
      options: { ...DEFAULT_EXPORT_OPTIONS, xlsxSingleFile: true },
      source: { type: "database", tables: [{ name: "a", target: "a/b:c" }, { name: "b", target: "  " }, { name: "c", target: "a/b:c" }] },
    }));
    expect(plan.items.map((i) => i.target)).toEqual(["a/b:c", "b", "a/b:c"]);
  });

  it("keeps a row's Configure columns, and leaves out an empty mapping", () => {
    const plan = parse(request({
      source: { type: "database", tables: [
        { name: "a", target: "a.csv", columns: [{ src: "id", dst: "key" }, { src: "x", dst: "x", skip: true }] },
        { name: "b", target: "b.csv", columns: [] },
      ] },
    }));
    expect(plan.items[0]!.columns).toEqual([{ src: "id", dst: "key" }, { src: "x", dst: "x", skip: true }]);
    expect("columns" in plan.items[1]!).toBe(false);
  });

  it("refuses a mapping Configure columns would not let through, naming the table", () => {
    const withColumns = (columns: unknown) => request({ source: { type: "database", tables: [{ name: "a", target: "a.csv", columns }] } });
    refuses(withColumns([{ src: "id", dst: "x" }, { src: "y", dst: "x" }]), `"a": Target columns must be unique, duplicates found: x`);
    refuses(withColumns([{ src: "id", dst: "" }]), `"a": Source and target columns must be defined`);
    refuses(withColumns([{ src: "id", dst: "id", skip: true }]), `"a": no column is used`);
    refuses(withColumns("id"), `"a": columns must be a list`);
    refuses(withColumns([{ src: 1, dst: "x" }]), `"a": every column needs a source and a target name`);
    refuses(withColumns([{ src: "id", dst: "x", skip: "yes" }]), `"a": every column needs a source and a target name`);
    refuses(withColumns([{ src: "x".repeat(1025), dst: "x" }]), `"a": a column name is longer than 1024 characters`);
    refuses(withColumns(Array.from({ length: 4097 }, (_, i) => ({ src: `c${i}`, dst: `c${i}` }))), `"a": at most 4096 columns can be mapped`);
  });
});

describe("parseExportJobRequest — a query", () => {
  it("makes one row named query", () => {
    const plan = parse(request({ source: { type: "query", sql: "SELECT 1", target: "out.csv" } }));
    expect(plan.items).toEqual([{ source: QUERY_SOURCE_NAME, target: "out.csv", read: { type: "query", sql: "SELECT 1" } }]);
  });

  it("refuses an empty query and one past the length a query may have", () => {
    refuses(request({ source: { type: "query", sql: "  ", target: "out.csv" } }), "The query is empty");
    refuses(request({ source: { type: "query", sql: "x".repeat(1_000_001), target: "out.csv" } }), /longer than 1,000,000 characters/);
  });

  it("refuses a target that is a path", () => {
    expect(() => parse(request({ source: { type: "query", sql: "SELECT 1", target: "../x.csv" } }))).toThrow(ImpExpRequestError);
  });
});

describe("parseExportJobRequest — format, options and zip", () => {
  it("refuses a format Export does not write and a source of no known type", () => {
    refuses(request({ format: "csvExcel" }), "format is not one Export writes");
    refuses(request({ source: { type: "file" } }), "source.type must be database or query");
    refuses("csv", "Request body must be an object");
  });

  it("takes the default of each option left out", () => {
    expect(parse(request({ options: undefined })).options).toEqual(DEFAULT_EXPORT_OPTIONS);
    expect(parse(request({ options: { csv: { delimiter: ";" } } })).options.csv).toEqual({ ...DEFAULT_EXPORT_OPTIONS.csv, delimiter: ";" });
  });

  it("refuses an option that is not one of its choices", () => {
    refuses(request({ options: { csv: { delimiter: ":" } } }), "Delimiter is not one of its choices");
    refuses(request({ options: { csv: { recordDelimiter: "\n\n" } } }), "Record Delimiter is not one of its choices");
    refuses(request({ options: { csv: { booleanFormat: "yes_no" } } }), "Boolean Format is not one of its choices");
    refuses(request({ options: { csv: { quoted: "yes" } } }), "Quoted must be true or false");
    refuses(request({ options: { json: { style: "map" } } }), "JSON style is not one of its choices");
    refuses(request({ options: { json: { rootField: 5 } } }), "Root field must be text");
    refuses(request({ options: { xml: { rootElement: "x".repeat(1025) } } }), "Root element name is longer than 1024 characters");
    refuses(request({ options: { xlsxSingleFile: 1 } }), "Create single file must be true or false");
    refuses(request({ options: [] }), "options must be an object");
    refuses(request({ options: { csv: "semicolon" } }), "options.csv must be an object");
  });

  it("names the zip as asked, adding .zip when the name has none", () => {
    expect(parse(request({ zip: { name: "backup.zip" } })).zip).toBe("backup.zip");
    expect(parse(request({ zip: { name: "backup" } })).zip).toBe("backup.zip");
    expect(parse(request({ zip: { name: "B.ZIP" } })).zip).toBe("B.ZIP");
    expect(parse(request({ zip: null })).zip).toBeNull();
    expect(parse(request()).zip).toBeNull();
  });

  it("refuses a zip name that is a path", () => {
    expect(() => parse(request({ zip: { name: "../x" } }))).toThrow(ImpExpRequestError);
    refuses(request({ zip: "x.zip" }), "zip must be an object");
  });
});

describe("parseImportJobRequest", () => {
  const UPLOAD = "AAAAAAAAAAAAAAAAAAAAAA";
  const file = (over: Record<string, unknown> = {}) => ({ upload: UPLOAD, source: "users", target: "users", action: "createTable", ...over });
  const body = (over: Record<string, unknown> = {}) => ({ format: "csv", files: [file()], ...over });
  const parseImport = (raw: unknown, type: "postgres" | "mysql" | "mariadb" | "sqlite" = "postgres", schema: string | null = "public") => parseImportJobRequest(raw, type, schema);
  const refusesImport = (raw: unknown, message: string, type?: "postgres" | "mysql" | "sqlite") => expect(() => parseImport(raw, type)).toThrow(new ImpExpRequestError(message));

  it("makes a row of each file, into the schema given or the connection's default, options defaulted", () => {
    expect(parseImport(body())).toEqual({
      format: "csv",
      options: DEFAULT_IMPORT_OPTIONS,
      schema: "public",
      items: [{ upload: UPLOAD, source: "users", target: "users", action: "createTable" }],
    });
    expect(parseImport(body({ schema: "sales" })).schema).toBe("sales");
    expect(parseImport(body(), "sqlite", null).schema).toBeNull();
  });

  it("takes the reading options and a column mapping", () => {
    const plan = parseImport(body({
      format: "json",
      options: { csv: { delimiter: ";", header: false }, json: { style: "object", keyField: "id", rootField: "rows" } },
      files: [file({ columns: [{ src: "a", dst: "b" }, { src: "c", dst: "c", skip: true }] })],
    }));
    expect(plan.options).toEqual({ csv: { delimiter: ";", header: false }, json: { style: "object", keyField: "id", rootField: "rows" } });
    expect(plan.items[0]!.columns).toEqual([{ src: "a", dst: "b" }, { src: "c", dst: "c", skip: true }]);
    expect(parseImport(body({ options: { csv: { delimiter: "" } } })).options.csv.delimiter).toBe("");
  });

  it("refuses a format Import does not read, and options it does not have", () => {
    refusesImport(body({ format: "xlsx" }), "format is not one Import reads");
    refusesImport(body({ options: { csv: { delimiter: ":" } } }), "Delimiter is not one of its choices");
    refusesImport(body({ options: { csv: { header: "yes" } } }), "Has header row must be true or false");
  });

  it("refuses no files, too many, and a file that names no upload", () => {
    refusesImport(body({ files: [] }), "Add at least one file");
    refusesImport(body({ files: Array.from({ length: 1_001 }, () => file()) }), "At most 1000 files can be imported at once");
    refusesImport(body({ files: [file({ upload: "../../etc/passwd" })] }), "File 1: upload is not the id of an uploaded file");
    refusesImport(body({ files: [file({ upload: undefined })] }), "File 1: upload is not the id of an uploaded file");
  });

  it("refuses an action it does not know and a target no table can be called", () => {
    refusesImport(body({ files: [file({ action: "merge" })] }), '"users": action is not one of its choices');
    refusesImport(body({ files: [file({ target: " " })] }), '"users": The target table needs a name');
    refusesImport(body({ files: [file({ target: "a\nb" })] }), '"users": "a\nb" holds a control character');
  });

  it("refuses a column mapping that cannot be used", () => {
    refusesImport(body({ files: [file({ columns: [{ src: "a", dst: "x" }, { src: "b", dst: "x" }] })] }), '"users": Target columns must be unique, duplicates found: x');
  });

  it("names a row by its file when the source is missing", () => {
    expect(parseImport(body({ files: [file({ source: undefined })] })).items[0]!.source).toBe("file 1");
    expect(parseImport(body({ files: [file({ source: "   " })] })).items[0]!.source).toBe("file 1");
    expect(parseImport(body({ files: [file({ source: " users " })] })).items[0]!.source).toBe("users");
  });

  it("knows how long a table name each engine keeps", () => {
    expect(importTableNameProblem("a".repeat(63), "postgres")).toBeNull();
    expect(importTableNameProblem("a".repeat(64), "postgres")).toBe(`"${"a".repeat(64)}" is longer than the 63 bytes Postgres keeps of a name`);
    expect(importTableNameProblem("é".repeat(32), "postgres")).toMatch(/63 bytes/);
    expect(importTableNameProblem("é".repeat(64), "mysql")).toBeNull();
    expect(importTableNameProblem("é".repeat(65), "mariadb")).toMatch(/64 characters/);
    // Characters, not UTF-16 code units: an emoji is one character of MySQL's 64.
    expect(importTableNameProblem("😀".repeat(64), "mysql")).toBeNull();
    expect(importTableNameProblem("😀".repeat(65), "mysql")).toMatch(/64 characters/);
    expect(importTableNameProblem("é".repeat(500), "sqlite")).toBeNull();
  });
});
