import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, DbCatalogColumn, DbCatalogTable, DbStatement } from "../../../../src/types/database.ts";
import { parseGridRequest } from "../../../../src/services/database/grid-query-builder.ts";
import { GridTableNotFoundError, countGridRows, fetchGridPage, type GridTarget } from "../../../../src/services/database/grid.service.ts";

interface Calls { selectRows: DbStatement[]; countRows: DbStatement[]; estimateRows: number }

/** An adapter that records what the grid asked of it. */
function fakeTarget(opts: {
  columns?: DbCatalogColumn[];
  key?: Pick<DbCatalogTable, "rowKey" | "rowKeyIsRowid" | "rowidAliases">;
  type?: GridTarget["type"];
  rows?: unknown[][];
  count?: number | null;
  estimate?: number | null | Error;
} = {}): { target: GridTarget; calls: Calls } {
  const calls: Calls = { selectRows: [], countRows: [], estimateRows: 0 };
  const columns = opts.columns ?? [{ name: "id", type: "integer" }, { name: "name", type: "text" }];
  const adapter = {
    describeTable: async (): Promise<DbCatalogTable> => ({
      columns,
      ...(opts.key ?? { rowKey: ["id"], rowKeyIsRowid: false, rowidAliases: [] }),
    }),
    selectRows: async (_config: unknown, stmt: DbStatement) => {
      calls.selectRows.push(stmt);
      const limit = stmt.params[stmt.params.length - 2] as number;
      return { columns: [], rows: (opts.rows ?? []).slice(0, limit) };
    },
    countRows: async (_config: unknown, stmt: DbStatement) => { calls.countRows.push(stmt); return opts.count === undefined ? 0 : opts.count; },
    estimateRows: async () => {
      calls.estimateRows++;
      if (opts.estimate instanceof Error) throw opts.estimate;
      return opts.estimate ?? null;
    },
  } as unknown as DatabaseAdapter;
  const type = opts.type ?? "postgres";
  const config = type === "postgres" ? { type, connectionString: "postgres://fake" } : { type, path: "/fake.db" };
  return { target: { type, adapter, config }, calls };
}

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => [i + 1, `row ${i + 1}`]);

describe("fetchGridPage", () => {
  it("reads one row past the page to learn whether more exist, and never counts", async () => {
    const { target, calls } = fakeTarget({ rows: rowsOf(5) });
    const page = await fetchGridPage(target, parseGridRequest({ table: "t", limit: 3 }, "public"));
    expect(calls.selectRows).toHaveLength(1);
    expect(calls.selectRows[0]!.params.slice(-2)).toEqual([4, 0]);
    expect(calls.countRows).toHaveLength(0);
    expect(calls.estimateRows).toBe(0);
    expect(page.response.rows).toEqual(rowsOf(3));
    expect(page.response.hasMore).toBe(true);
  });

  it("says there is no more on the last page", async () => {
    const { target } = fakeTarget({ rows: rowsOf(3) });
    const page = await fetchGridPage(target, parseGridRequest({ table: "t", limit: 3 }, "public"));
    expect(page.response.rows).toHaveLength(3);
    expect(page.response.hasMore).toBe(false);
  });

  it("describes columns from the catalog, declared types included", async () => {
    const { target } = fakeTarget({ columns: [{ name: "id", type: "bigint" }, { name: "note", type: "character varying(20)" }] });
    const page = await fetchGridPage(target, parseGridRequest({ table: "t" }, "public"));
    expect(page.response.columns).toEqual([{ name: "id", type: "bigint" }, { name: "note", type: "character varying(20)" }]);
    expect(page.response.sql).toBe(`SELECT "id", "note"\nFROM "public"."t"`);
  });

  it("names the row key, so the grid can address rows with a primary key of several columns", async () => {
    const { target } = fakeTarget({ key: { rowKey: ["tenant", "id"], rowKeyIsRowid: false, rowidAliases: [] } });
    const page = await fetchGridPage(target, parseGridRequest({ table: "t" }, "public"));
    expect(page.response.rowKey).toEqual(["tenant", "id"]);
    expect(page.response.columns.map((c) => c.name)).toEqual(["id", "name"]);
  });

  it("selects SQLite's rowid last for a table with no primary key, and keys rows by it", async () => {
    const { target, calls } = fakeTarget({ type: "sqlite", key: { rowKey: ["rowid"], rowKeyIsRowid: true, rowidAliases: ["rowid", "_rowid_", "oid"] } });
    const page = await fetchGridPage(target, parseGridRequest({ table: "t" }, null));
    expect(calls.selectRows[0]!.sql).toStartWith(`SELECT "id", "name", "rowid"\nFROM "t"`);
    expect(page.response.columns.map((c) => c.name)).toEqual(["id", "name", "rowid"]);
    expect(page.response.rowKey).toEqual(["rowid"]);
  });

  it("answers not found for a table with no columns", async () => {
    const { target } = fakeTarget({ columns: [] });
    await expect(fetchGridPage(target, parseGridRequest({ table: "gone", schema: "auth" }, "public"))).rejects.toThrow(GridTableNotFoundError);
  });
});

describe("countGridRows", () => {
  it("counts and adds the engine's estimate when nothing is filtered", async () => {
    const { target, calls } = fakeTarget({ count: 42, estimate: 40 });
    expect(await countGridRows(target, parseGridRequest({ table: "t" }, "public"), 1000)).toEqual({ count: 42, estimate: 40, timedOut: false });
    expect(calls.countRows[0]!.sql).toBe(`SELECT COUNT(*) AS count\nFROM "public"."t"`);
  });

  it("leaves the estimate out under filters, where it would describe the wrong rows", async () => {
    const { target, calls } = fakeTarget({ count: 2, estimate: 40 });
    const req = parseGridRequest({ table: "t", filters: [{ column: "id", anyOf: [[{ op: "gt", value: 1 }]] }] }, "public");
    expect(await countGridRows(target, req, 1000)).toEqual({ count: 2, estimate: null, timedOut: false });
    expect(calls.estimateRows).toBe(0);
  });

  it("leaves the estimate out under the Multi column filter alone", async () => {
    const { target, calls } = fakeTarget({ count: 2, estimate: 40 });
    const req = parseGridRequest({ table: "t", anyColumn: [{ column: "id", anyOf: [[{ op: "gt", value: 1 }]] }] }, "public");
    expect(await countGridRows(target, req, 1000)).toEqual({ count: 2, estimate: null, timedOut: false });
    expect(calls.estimateRows).toBe(0);
  });

  it("reports a timeout and keeps the estimate", async () => {
    const { target } = fakeTarget({ count: null, estimate: 5_000_000 });
    expect(await countGridRows(target, parseGridRequest({ table: "t" }, "public"), 1)).toEqual({ count: null, estimate: 5_000_000, timedOut: true });
  });

  it("still counts when the estimate cannot be read", async () => {
    const { target } = fakeTarget({ count: 7, estimate: new Error("permission denied for pg_class") });
    expect(await countGridRows(target, parseGridRequest({ table: "t" }, "public"), 1000)).toEqual({ count: 7, estimate: null, timedOut: false });
  });
});
