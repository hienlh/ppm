/**
 * The Import/Export tab's form as data: which storage types go together, the rows and what each
 * writes to, the requests Run sends, and the form read back out of a tab's metadata.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SHOWN_LEVELS, MESSAGE_LEVELS, QUERY_SOURCE, SOURCE_TYPE_OPTIONS, TEMPLATE_SOURCE, addTables, addUploads,
  columnsLinkText, confirmedColumnMap, databaseExportForm, defaultRowTarget, droppedUploads, exportRequest, filterMessages,
  formatDuration, gridExportForm, impExpTitle, importIntoForm, importRequest, itemStatusText, itemsByRow, levelCounts, messageClock, messageLines, newImpExpForm,
  readImpExpForm, readJobRef, removeRow, resetColumnMap, rowSourceLabel, rowTarget, runBlocker, setDatabase, setSourceType,
  setTables, setTargetType, startingStatus, targetTypeOptions, updateRow, uploadProblem, type ImpExpForm, type ImpExpUpload,
} from "../../../src/web/components/database/impexp/impexp-state";
import {
  DEFAULT_EXPORT_OPTIONS, DEFAULT_IMPORT_OPTIONS, IMPEXP_MAX_ITEMS, IMPEXP_MAX_MAPPED_COLUMNS, IMPORT_MAX_FILE_BYTES, type ImpExpItemStatus,
  type ImpExpMessage,
} from "../../../src/shared/db-impexp";

const conn = { kind: "connection" as const, connectionId: 7, database: "shop" };
const exportForm = (over: Partial<ImpExpForm> = {}): ImpExpForm => newImpExpForm({ db: { target: conn, schema: null }, ...over });
const importForm = (over: Partial<ImpExpForm> = {}): ImpExpForm => newImpExpForm({ sourceType: "csv", targetType: "database", db: { target: conn, schema: null }, ...over });
const up = (id: string, name: string, size = 10): ImpExpUpload => ({ id, name, size });

describe("storage types", () => {
  it("lists the source types as DBGate does: Database, the readable file formats, Query", () => {
    expect(SOURCE_TYPE_OPTIONS.map((o) => o.label)).toEqual([
      "Database", "JSON lines/NDJSON file(s)", "JSON file(s)", "CSV file(s)", "Query",
    ]);
  });

  it("sends files into a database, and a database or a query into files only", () => {
    expect(targetTypeOptions("csv").map((o) => o.value)).toEqual(["database"]);
    expect(targetTypeOptions("jsonl").map((o) => o.value)).toEqual(["database"]);
    for (const source of ["database", "query"] as const) {
      expect(targetTypeOptions(source).map((o) => o.value)).toEqual(["jsonl", "json", "sql", "csv", "xlsx", "xml"]);
    }
  });

  it("starts as a database exported to CSV", () => {
    const f = newImpExpForm();
    expect([f.sourceType, f.targetType, f.rows, f.zip]).toEqual(["database", "csv", [], false]);
    expect(f.exportOptions).toEqual(DEFAULT_EXPORT_OPTIONS);
    expect(f.importOptions).toEqual(DEFAULT_IMPORT_OPTIONS);
  });

  it("drops the rows of another kind of source, and turns the target with it", () => {
    const tables = setTables(exportForm({ targetType: "json" }), ["a", "b"]);
    const query = setSourceType(tables, "query");
    expect(query.rows).toEqual([{ source: QUERY_SOURCE }]);
    expect(query.targetType).toBe("json");

    const csv = setSourceType(tables, "csv");
    expect(csv.rows).toEqual([]);
    expect(csv.targetType).toBe("database");

    const back = setSourceType(csv, "database");
    expect(back.targetType).toBe("csv");
    expect(back.rows).toEqual([]);
  });

  it("keeps the files when only their format changes, to be read the new way", () => {
    const f = addUploads(importForm(), [up("u1", "a.csv")]);
    const json = setSourceType(f, "json");
    expect(json.rows).toEqual(f.rows);
    expect(json.targetType).toBe("database");
  });

  it("changes nothing for the type already chosen", () => {
    const f = exportForm();
    expect(setSourceType(f, "database")).toBe(f);
    expect(setTargetType(f, "csv")).toBe(f);
  });

  it("refuses a target the source cannot go to", () => {
    expect(setTargetType(exportForm(), "database").targetType).toBe("csv");
    expect(setTargetType(importForm(), "csv").targetType).toBe("database");
    expect(setTargetType(exportForm(), "xlsx").targetType).toBe("xlsx");
  });
});

describe("where it was opened", () => {
  const db = { target: conn, schema: "sales" };

  it("exports a grid's query under its table, with the columns it shows when some are hidden", () => {
    const f = gridExportForm(db, "orders", "SELECT *", ["id", "total"]);
    expect([f.sourceType, f.targetType, f.db, f.sql]).toEqual(["query", "csv", db, "SELECT *"]);
    expect(f.rows).toEqual([{ source: "orders", columns: [{ src: "id", dst: "id" }, { src: "total", dst: "total" }] }]);
    expect(gridExportForm(db, "orders", "SELECT *").rows).toEqual([{ source: "orders" }]);
    expect(gridExportForm(db, "orders", "SELECT *", []).rows).toEqual([{ source: "orders" }]);
    expect(gridExportForm(db, "", "SELECT 1").rows).toEqual([{ source: QUERY_SOURCE }]);
  });

  it("exports the tables picked in the tree, or none yet for a database", () => {
    expect(databaseExportForm(db, ["b", "a"]).rows).toEqual([{ source: "b" }, { source: "a" }]);
    expect(databaseExportForm(db).rows).toEqual([]);
    expect(databaseExportForm(db).sourceType).toBe("database");
  });

  it("imports CSV into a database, or into a table through the template row", () => {
    const f = importIntoForm(db, "people");
    expect([f.sourceType, f.targetType, f.db]).toEqual(["csv", "database", db]);
    expect(f.rows).toEqual([{ source: TEMPLATE_SOURCE, target: "people" }]);
    expect(importIntoForm(db).rows).toEqual([]);
  });
});

describe("rows", () => {
  it("lets go of a Database source's tables with its database, but not of a query or files", () => {
    const db = { target: { ...conn, database: "other" }, schema: null };
    expect(setDatabase(setTables(exportForm(), ["a"]), db).rows).toEqual([]);
    const q = setSourceType(exportForm(), "query");
    expect(setDatabase(q, db).rows).toEqual(q.rows);
    const files = addUploads(importForm(), [up("u1", "a.csv")]);
    expect(setDatabase(files, db).rows).toEqual(files.rows);
    expect(setDatabase(files, db).db).toBe(db);
  });

  it("keeps each table's settings when the selection changes, in the box's order, once each", () => {
    let f = setTables(exportForm(), ["a", "b"]);
    f = updateRow(f, "b", { target: "bee.csv", columns: [{ src: "x", dst: "y" }] });
    f = setTables(f, ["c", "b", "c"]);
    expect(f.rows).toEqual([{ source: "c" }, { source: "b", target: "bee.csv", columns: [{ src: "x", dst: "y" }] }]);
  });

  it("adds All tables after the ones chosen, without doubling one", () => {
    const f = addTables(setTables(exportForm(), ["b"]), ["a", "b", "c"]);
    expect(f.rows.map((r) => r.source)).toEqual(["b", "a", "c"]);
  });

  it("takes at most 1,000 rows", () => {
    const names = Array.from({ length: 1_005 }, (_, i) => `t${i}`);
    expect(setTables(exportForm(), names).rows).toHaveLength(1_000);
  });

  it("removes one row with its trash can", () => {
    expect(removeRow(setTables(exportForm(), ["a", "b"]), "a").rows).toEqual([{ source: "b" }]);
  });
});

describe("uploads", () => {
  it("names a row by its file less the extension, and takes the type from the first file", () => {
    const f = addUploads(importForm(), [up("u1", "orders.json"), up("u2", "lines.csv")]);
    expect(f.sourceType).toBe("json");
    expect(f.rows).toEqual([{ source: "orders", upload: up("u1", "orders.json") }, { source: "lines", upload: up("u2", "lines.csv") }]);
  });

  it("reads later files as the type in use, as DBGate does", () => {
    const f = addUploads(addUploads(importForm(), [up("u1", "a.csv")]), [up("u2", "b.ndjson")]);
    expect(f.sourceType).toBe("csv");
    expect(f.rows.map((r) => r.source)).toEqual(["a", "b"]);
  });

  it("keeps the type for a file whose extension says nothing", () => {
    expect(addUploads(importForm({ sourceType: "jsonl" }), [up("u1", "dump.dat")]).sourceType).toBe("jsonl");
  });

  it("gives a file named like a row that row, with its settings, rather than a second one", () => {
    let f = addUploads(importForm(), [up("u1", "a.csv")]);
    f = updateRow(f, "a", { target: "people", action: "appendData" });
    const again = addUploads(f, [up("u2", "a.csv")]);
    expect(again.rows).toEqual([{ source: "a", target: "people", action: "appendData", upload: up("u2", "a.csv") }]);
    expect(droppedUploads(f, again)).toEqual(["u1"]);
  });

  it("hands the template row's table and action to the first file, and only to it", () => {
    const f = importForm({ rows: [{ source: TEMPLATE_SOURCE, target: "customers", action: "truncate" }] });
    const added = addUploads(f, [up("u1", "data.json"), up("u2", "more.json")]);
    expect(added.sourceType).toBe("json");
    expect(added.rows).toEqual([
      { source: "data", upload: up("u1", "data.json"), target: "customers", action: "truncate" },
      { source: "more", upload: up("u2", "more.json") },
    ]);
  });

  it("takes no file past 1,000 rows, yet still gives a file named like a row that row", () => {
    const full = importForm({ rows: Array.from({ length: IMPEXP_MAX_ITEMS }, (_, i) => ({ source: `f${i}`, upload: up(`u${i}`, `f${i}.csv`) })) });
    expect(addUploads(full, [up("new", "extra.csv")]).rows).toHaveLength(IMPEXP_MAX_ITEMS);
    expect(addUploads(full, [up("new", "f3.csv")]).rows[3]).toEqual({ source: "f3", upload: up("new", "f3.csv") });
  });

  it("adds nothing to a source that is not files", () => {
    const f = exportForm();
    expect(addUploads(f, [up("u1", "a.csv")])).toBe(f);
  });

  it("lists the uploads a change leaves unread", () => {
    const f = addUploads(importForm(), [up("u1", "a.csv"), up("u2", "b.csv")]);
    expect(droppedUploads(f, removeRow(f, "a"))).toEqual(["u1"]);
    expect(droppedUploads(f, setSourceType(f, "database"))).toEqual(["u1", "u2"]);
    expect(droppedUploads(f, f)).toEqual([]);
  });

  it("refuses an empty file and one over 128 MB in the browser", () => {
    expect(uploadProblem({ name: "a.csv", size: 0 })).toBe("a.csv is empty");
    expect(uploadProblem({ name: "a.csv", size: IMPORT_MAX_FILE_BYTES })).toBeNull();
    expect(uploadProblem({ name: "big.csv", size: IMPORT_MAX_FILE_BYTES + 1 })).toBe("big.csv is larger than 128 MB, the most one file can be");
  });
});

describe("targets", () => {
  it("defaults a file to <source>.<extension>, and a sheet of a single workbook to the source", () => {
    const f = exportForm({ targetType: "json" });
    expect(defaultRowTarget(f, { source: "orders" })).toBe("orders.json");
    const sheets = { ...f, targetType: "xlsx" as const, exportOptions: { ...f.exportOptions, xlsxSingleFile: true } };
    expect(defaultRowTarget(sheets, { source: "orders" })).toBe("orders");
    expect(defaultRowTarget({ ...sheets, exportOptions: f.exportOptions }, { source: "orders" })).toBe("orders.xlsx");
  });

  it("defaults an import to the table named like the file, and the template row to none", () => {
    expect(defaultRowTarget(importForm(), { source: "people" })).toBe("people");
    expect(defaultRowTarget(importForm(), { source: TEMPLATE_SOURCE })).toBe("");
    expect(rowSourceLabel({ source: TEMPLATE_SOURCE })).toBe("(not selected)");
    expect(rowSourceLabel({ source: "people" })).toBe("people");
  });

  it("writes to the Target box as typed, or to the default while it is blank", () => {
    const f = exportForm();
    expect(rowTarget(f, { source: "a", target: "x y.csv" })).toBe("x y.csv");
    expect(rowTarget(f, { source: "a", target: "  " })).toBe("a.csv");
    expect(rowTarget(f, { source: "a" })).toBe("a.csv");
  });

  it("links Columns as DBGate words it, counting only the columns used", () => {
    expect(columnsLinkText(undefined)).toBe("(copy from source)");
    expect(columnsLinkText([{ src: "a", dst: "a", skip: true }])).toBe("(copy from source)");
    expect(columnsLinkText([{ src: "a", dst: "a" }, { src: "b", dst: "c" }, { src: "d", dst: "d", skip: true }])).toBe("(2 columns)");
  });
});

describe("title", () => {
  it("is <source>-><target>(<rows>)", () => {
    expect(impExpTitle(setTables(exportForm(), ["a", "b", "c"]), "shop")).toBe("shop->CSV(3)");
    expect(impExpTitle(setTables(exportForm(), ["a"]), null)).toBe("DB->CSV(1)");
    expect(impExpTitle(setTables(exportForm(), ["a"]), "")).toBe("DB->CSV(1)");
    expect(impExpTitle(addUploads(importForm(), [up("u", "a.csv")]), undefined)).toBe("CSV->DB(1)");
    expect(impExpTitle(setTargetType(setSourceType(exportForm(), "query"), "xlsx"), "shop")).toBe("Query->XLSX(1)");
    expect(impExpTitle(importForm({ sourceType: "jsonl" }), "shop")).toBe("JSONL->shop(0)");
  });
});

describe("Run", () => {
  it("waits for a database", () => {
    expect(runBlocker(newImpExpForm(), false)).toBe("Choose the database to export from");
    expect(runBlocker(newImpExpForm({ sourceType: "csv", targetType: "database" }), false)).toBe("Choose the database to import into");
  });

  it("waits for a table, or for a query to run", () => {
    expect(runBlocker(exportForm(), false)).toBe("Choose at least one table or view");
    const q = setSourceType(exportForm(), "query");
    expect(runBlocker(q, false)).toBe("The query is empty");
    expect(runBlocker({ ...q, sql: "select 1" }, false)).toBeNull();
    expect(runBlocker(setTables(exportForm(), ["a"]), false)).toBeNull();
  });

  it("imports only files, and nothing into a readonly connection", () => {
    const template = importForm({ rows: [{ source: TEMPLATE_SOURCE, target: "t" }] });
    expect(runBlocker(template, false)).toBe("Add at least one file");
    const f = addUploads(template, [up("u", "a.csv")]);
    expect(runBlocker(f, false)).toBeNull();
    expect(runBlocker(f, true)).toBe("The connection is read only: nothing can be imported into it");
  });

  it("names no two files alike, whatever their case, and no file with a path", () => {
    const f = setTables(exportForm(), ["Orders", "orders"]);
    expect(runBlocker(f, false)).toBe('Two rows write to "orders.csv": give each its own file name');
    expect(runBlocker(updateRow(f, "orders", { target: "orders-2.csv" }), false)).toBeNull();
    expect(runBlocker(updateRow(f, "orders", { target: "../x.csv" }), false)).toBe('"../x.csv" is a path; give a file name');
    expect(runBlocker(setTables(exportForm(), ["orders", "Orders"]), false)).toBe('Two rows write to "Orders.csv": give each its own file name');
  });

  it("lets two sheets of one workbook share a name", () => {
    const f = setTables(exportForm({ targetType: "xlsx", exportOptions: { ...DEFAULT_EXPORT_OPTIONS, xlsxSingleFile: true } }), ["a", "b"]);
    expect(runBlocker(updateRow(updateRow(f, "a", { target: "S" }), "b", { target: "S" }), false)).toBeNull();
  });

  it("checks a typed zip name as a file name", () => {
    const f = setTables(exportForm({ zip: true, zipName: "a/b.zip" }), ["t"]);
    expect(runBlocker(f, false)).toBe('"a/b.zip" is a path; give a file name');
    expect(runBlocker({ ...f, zipName: "" }, false)).toBeNull();
  });
});

describe("requests", () => {
  const now = new Date(2026, 9, 3, 14, 5, 9);

  it("exports tables of the schema, with columns only where some were configured", () => {
    let f = setTables(exportForm({ targetType: "json" }), ["a", "b"]);
    f = updateRow(f, "b", { target: "bee.json", columns: [{ src: "x", dst: "y" }] });
    expect(exportRequest(f, "sales", now)).toEqual({
      request: {
        source: { type: "database", schema: "sales", tables: [{ name: "a", target: "a.json" }, { name: "b", target: "bee.json", columns: [{ src: "x", dst: "y" }] }] },
        format: "json",
        options: DEFAULT_EXPORT_OPTIONS,
        zip: null,
      },
      rows: ["a", "b"],
    });
    expect(exportRequest(f, null, now).request.source).not.toHaveProperty("schema");
  });

  it("exports a query under its row's target, named as the grid it came from", () => {
    const f = { ...setSourceType(exportForm(), "query"), sql: "select * from orders", rows: [{ source: "orders", columns: [{ src: "id", dst: "id" }] }] };
    expect(exportRequest(f, "public", now)).toEqual({
      request: {
        source: { type: "query", sql: "select * from orders", target: "orders.csv", columns: [{ src: "id", dst: "id" }] },
        format: "csv", options: DEFAULT_EXPORT_OPTIONS, zip: null,
      },
      rows: ["orders"],
    });
  });

  it("sends no columns for a row whose list is empty", () => {
    const e = updateRow(setTables(exportForm(), ["a"]), "a", { columns: [] });
    expect(exportRequest(e, null, now).request.source).toEqual({ type: "database", tables: [{ name: "a", target: "a.csv" }] });
    const q = { ...setSourceType(exportForm(), "query"), sql: "select 1", rows: [{ source: "q", columns: [] }] };
    expect(exportRequest(q, null, now).request.source).toEqual({ type: "query", sql: "select 1", target: "q.csv" });
    const i = updateRow(addUploads(importForm(), [up("u1", "a.csv")]), "a", { columns: [] });
    expect(importRequest(i, null).request.files).toEqual([{ upload: "u1", source: "a", target: "a", action: "createTable" }]);
  });

  it("zips under the typed name, or DBGate's dated one", () => {
    const f = setTables(exportForm({ zip: true }), ["a"]);
    expect(exportRequest(f, null, now).request.zip).toEqual({ name: "zip-archive-2026-10-03-14-05-09.zip" });
    expect(exportRequest({ ...f, zipName: " mine.zip " }, null, now).request.zip).toEqual({ name: "mine.zip" });
  });

  it("imports the rows holding a file, each with its action", () => {
    let f = addUploads(importForm({ sourceType: "jsonl" }), [up("u1", "a.jsonl"), up("u2", "b.jsonl")]);
    f = updateRow(f, "b", { target: "bees", action: "dropCreateTable", columns: [{ src: "k", dst: "key" }] });
    expect(importRequest(f, "public")).toEqual({
      request: {
        format: "jsonl",
        options: DEFAULT_IMPORT_OPTIONS,
        schema: "public",
        files: [
          { upload: "u1", source: "a", target: "a", action: "createTable" },
          { upload: "u2", source: "b", target: "bees", action: "dropCreateTable", columns: [{ src: "k", dst: "key" }] },
        ],
      },
      rows: ["a", "b"],
    });
    expect(importRequest(f, null).request).not.toHaveProperty("schema");
  });
});

describe("progress", () => {
  const item = (over: Partial<ImpExpItemStatus>): ImpExpItemStatus => ({ source: "a", target: "a.csv", state: "queued", rowsRead: 0, rowsWritten: 0, ...over });

  it("words each state as DBGate does", () => {
    expect(itemStatusText(item({}))).toBe("Queued");
    expect(itemStatusText(item({ state: "running" }))).toBe("Running");
    expect(itemStatusText(item({ state: "running", rowsRead: 1500 }))).toBe("1,500 rows read");
    expect(itemStatusText(item({ state: "running", rowsRead: 1500, rowsWritten: 1000 }))).toBe("1,000 rows written");
    expect(itemStatusText(item({ state: "done", rowsRead: 7, rowsWritten: 7 }))).toBe("7 rows written");
    expect(itemStatusText(item({ state: "done", rowsRead: 3 }))).toBe("3 rows written");
    expect(itemStatusText(item({ state: "done" }))).toBe("Done");
    expect(itemStatusText(item({ state: "error", error: "boom" }))).toBe("Error");
    expect(itemStatusText(item({ state: "stopped" }))).toBe("Stopped");
  });

  it("shows every level but Debug at first, and filters by text", () => {
    expect(MESSAGE_LEVELS.map((l) => l.label)).toEqual(["Debug", "Info", "Warning", "Error"]);
    const messages = [
      { level: "debug" as const, text: "sql", time: 1 },
      { level: "info" as const, text: "Reading table a", time: 2 },
      { level: "error" as const, text: "a: boom", time: 3 },
    ];
    expect(filterMessages(messages, DEFAULT_SHOWN_LEVELS, "").map((m) => m.time)).toEqual([2, 3]);
    expect(filterMessages(messages, DEFAULT_SHOWN_LEVELS, " READING ").map((m) => m.time)).toEqual([2]);
    expect(filterMessages(messages, ["debug"], "").map((m) => m.time)).toEqual([1]);
  });

  it("formats durations as DBGate does", () => {
    expect(formatDuration(0)).toBe("0");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1000)).toBe("1 s");
    expect(formatDuration(1250)).toBe("1.3 s");
    expect(formatDuration(9949)).toBe("9.9 s");
    expect(formatDuration(10_000)).toBe("10 s");
    expect(formatDuration(61_499)).toBe("61 s");
  });

  it("shows the local clock", () => {
    expect(messageClock(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe("03:04:05");
    expect(messageClock(new Date(2026, 0, 2, 23, 59, 0).getTime())).toBe("23:59:00");
  });

  const log: ImpExpMessage[] = [
    { level: "info", text: "Reading table a", time: 1000 },
    { level: "debug", text: "SELECT * FROM a", time: 1500 },
    { level: "error", text: "a: boom", time: 3000 },
    { level: "info", text: "Reading table b", time: 3000 },
  ];

  it("numbers the log and times each line from the first and from the one before", () => {
    const all = messageLines(log, ["debug", "info", "warning", "error"], "");
    expect(all.map((m) => [m.number, m.delta, m.duration])).toEqual([
      [1, "0", "n/a"], [2, "500 ms", "500 ms"], [3, "2 s", "1.5 s"], [4, "2 s", "0"],
    ]);
    expect(all[2]).toMatchObject({ level: "error", text: "a: boom", time: 3000 });
  });

  it("keeps a line's number and times when the lines around it are filtered out", () => {
    // The Debug line is hidden, and still the one the error is timed from.
    expect(messageLines(log, DEFAULT_SHOWN_LEVELS, "").map((m) => [m.number, m.duration])).toEqual([[1, "n/a"], [3, "1.5 s"], [4, "0"]]);
    expect(messageLines(log, DEFAULT_SHOWN_LEVELS, "table b").map((m) => [m.number, m.delta])).toEqual([[4, "2 s"]]);
    expect(messageLines([], DEFAULT_SHOWN_LEVELS, "")).toEqual([]);
  });

  it("counts each level for its switch, hidden ones too", () => {
    expect(levelCounts(log)).toEqual({ debug: 1, info: 2, warning: 0, error: 1 });
    expect(levelCounts([])).toEqual({ debug: 0, info: 0, warning: 0, error: 0 });
  });
});

describe("the job a tab follows", () => {
  const id = "Ab-_09".padEnd(22, "x");

  it("reads back the job Run started", () => {
    expect(readJobRef({ id, kind: "import", rows: ["a", "b"] })).toEqual({ id, kind: "import", rows: ["a", "b"] });
    expect(readJobRef({ id: "x".repeat(64), kind: "export", rows: [] })).toEqual({ id: "x".repeat(64), kind: "export", rows: [] });
  });

  it("refuses an id that is not one the server hands out, and an unknown kind", () => {
    for (const bad of ["", "x".repeat(65), "../jobs", "a b", "a/b", "a?b", 42, null]) {
      expect(readJobRef({ id: bad, kind: "export", rows: [] })).toBeNull();
    }
    expect(readJobRef({ id, kind: "copy", rows: [] })).toBeNull();
    expect(readJobRef({ id, rows: [] })).toBeNull();
    for (const notAJob of [null, undefined, "job", [id], 7]) expect(readJobRef(notAJob)).toBeNull();
  });

  it("keeps only the rows that are names, at most a job's worth", () => {
    expect(readJobRef({ id, kind: "export", rows: ["a", 1, null, "x".repeat(1001), "x".repeat(1000)] })?.rows)
      .toEqual(["a", "x".repeat(1000)]);
    expect(readJobRef({ id, kind: "export" })?.rows).toEqual([]);
    expect(readJobRef({ id, kind: "export", rows: "a" })?.rows).toEqual([]);
    const many = Array.from({ length: IMPEXP_MAX_ITEMS + 5 }, (_, i) => `t${i}`);
    expect(readJobRef({ id, kind: "export", rows: many })?.rows).toEqual(many.slice(0, IMPEXP_MAX_ITEMS));
  });

  it("gives each row its line of the job by place, and none to a row the job does not have", () => {
    const items: ImpExpItemStatus[] = [
      { source: "a", target: "a.csv", state: "done", rowsRead: 2, rowsWritten: 2 },
      { source: "b", target: "b.csv", state: "running", rowsRead: 1, rowsWritten: 0 },
    ];
    const byRow = itemsByRow({ id, kind: "export", rows: ["a", "b", "c"] }, items);
    expect([...byRow.keys()]).toEqual(["a", "b"]);
    expect(byRow.get("b")).toBe(items[1]!);
    expect(itemsByRow(null, items).size).toBe(0);
  });

  it("matches by place, not by name: a grid's query row is named after its table, the job's line after the query", () => {
    const line: ImpExpItemStatus = { source: "query", target: "orders.csv", state: "done", rowsRead: 3, rowsWritten: 3 };
    expect(itemsByRow({ id, kind: "export", rows: ["orders"] }, [line]).get("orders")).toBe(line);
  });

  it("shows a job just started as running with every row queued", () => {
    expect(startingStatus(id, "import", ["a", "b"], 1234)).toEqual({
      id, kind: "import", state: "running",
      items: [
        { source: "a", target: "", state: "queued", rowsRead: 0, rowsWritten: 0 },
        { source: "b", target: "", state: "queued", rowsRead: 0, rowsWritten: 0 },
      ],
      messages: [], messageCount: 0, files: [], startedAt: 1234, endedAt: null,
    });
  });
});

describe("Configure columns", () => {
  it("resets as DBGate does", () => {
    expect(resetColumnMap(["a", "b"], null)).toEqual([{ src: "a", dst: "a" }, { src: "b", dst: "b" }]);
    expect(resetColumnMap(null, ["x"])).toEqual([{ src: "x", dst: "x" }]);
    expect(resetColumnMap(["a", "B", "c"], ["c", "b", "a"])).toEqual([{ src: "a", dst: "a" }, { src: "c", dst: "c" }]);
    expect(resetColumnMap(null, null)).toEqual([]);
  });

  it("keeps nothing for an empty list or one Reset would give back", () => {
    const reset = [{ src: "a", dst: "a" }];
    expect(confirmedColumnMap([], reset)).toBeUndefined();
    expect(confirmedColumnMap([{ src: "a", dst: "a", skip: false }], reset)).toBeUndefined();
    expect(confirmedColumnMap([{ src: "a", dst: "a", skip: true }], reset)).toEqual([{ src: "a", dst: "a", skip: true }]);
    expect(confirmedColumnMap([{ src: "a", dst: "b" }], reset)).toEqual([{ src: "a", dst: "b" }]);
  });
});

describe("reading the form back", () => {
  it("gives the defaults for anything that is not a form", () => {
    for (const raw of [undefined, null, 3, "x", []]) expect(readImpExpForm(raw)).toEqual(newImpExpForm());
  });

  it("reads back what it was given", () => {
    let f = addUploads(importForm({ db: { target: conn, schema: "sales" } }), [up("u1", "a.csv")]);
    f = updateRow(f, "a", { target: "people", action: "truncate", columns: [{ src: "x", dst: "y", skip: true }] });
    f = { ...f, importOptions: { csv: { delimiter: ";", header: false }, json: { style: "object", keyField: "k", rootField: "r" } } };
    expect(readImpExpForm(JSON.parse(JSON.stringify(f)))).toEqual(f);
    const e = { ...setTables(exportForm({ targetType: "xml", zip: true, zipName: "z.zip" }), ["t"]), sql: "x" };
    expect(readImpExpForm(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it("drops what is of the wrong shape", () => {
    const f = readImpExpForm({
      sourceType: "excel",
      targetType: "database",
      db: { target: { kind: "connection", connectionId: -1 }, schema: 5 },
      rows: [{ source: "" }, { source: "a", action: "explode", upload: { id: 1 } }, { source: "a" }, "b"],
      exportOptions: { csv: { delimiter: ":", quoted: "yes", recordDelimiter: "\r\n" } },
      importOptions: { csv: { delimiter: "" } },
      zip: "true",
    });
    expect(f.sourceType).toBe("database");
    expect(f.targetType).toBe("csv");
    expect(f.db).toEqual({ target: null, schema: null });
    expect(f.rows).toEqual([{ source: "a" }]);
    expect(f.exportOptions.csv).toEqual({ ...DEFAULT_EXPORT_OPTIONS.csv, recordDelimiter: "\r\n" });
    expect(f.importOptions.csv.delimiter).toBe("");
    expect(f.zip).toBe(false);
  });

  it("reads at most a job's worth of rows, a list's worth of columns, and an upload only with its size", () => {
    const rows = Array.from({ length: IMPEXP_MAX_ITEMS + 5 }, (_, i) => ({ source: `t${i}` }));
    expect(readImpExpForm({ rows }).rows).toHaveLength(IMPEXP_MAX_ITEMS);
    const columns = Array.from({ length: IMPEXP_MAX_MAPPED_COLUMNS + 1 }, (_, i) => ({ src: `c${i}`, dst: `c${i}` }));
    expect(readImpExpForm({ rows: [{ source: "a", columns }] }).rows).toEqual([{ source: "a" }]);
    expect(readImpExpForm({ rows: [{ source: "a", columns: columns.slice(1) }] }).rows[0]!.columns).toHaveLength(IMPEXP_MAX_MAPPED_COLUMNS);
    const f = readImpExpForm({ sourceType: "csv", rows: [{ source: "a", upload: { id: "u1", name: "a.csv" } }, { source: "b", upload: { id: "u2", name: "b.csv", size: 4 } }] });
    expect(f.rows).toEqual([{ source: "a" }, { source: "b", upload: { id: "u2", name: "b.csv", size: 4 } }]);
  });

  it("reads a database file as its path", () => {
    const target = { kind: "file", path: "/data/app.db", projectName: "p" };
    expect(readImpExpForm({ db: { target } }).db.target).toEqual({ kind: "file", path: "/data/app.db", projectName: "p" });
    expect(readImpExpForm({ db: { target: { kind: "file", path: "" } } }).db.target).toBeNull();
  });

  it("keeps a query to one row", () => {
    expect(readImpExpForm({ sourceType: "query" }).rows).toEqual([{ source: QUERY_SOURCE }]);
    expect(readImpExpForm({ sourceType: "query", rows: [{ source: "orders" }, { source: "x" }] }).rows).toEqual([{ source: "orders" }]);
  });
});
