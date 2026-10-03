/**
 * The two grids that save rows — a table's data tab and an editable Query result — both through
 * the one Save changes dialog, against a stub server. Once the changes are in, each shows what the
 * table holds now: the data tab reads again as many rows as it had loaded and counts them again;
 * the Query tab runs that result's statement again. A dialog closed with nothing saved reads nothing and rejects,
 * which is what keeps the grid's changes.
 *
 * Monaco does not run here, so the script box is replaced by one that shows its text — only while
 * this file runs: `mock.module` outlives it, and other suites render the real one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { resolve } from "node:path";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { toast } = await import("sonner");

const SQL_OBJECT_TAB = resolve(import.meta.dir, "../../../src/web/components/database/sql-object/sql-object-tab.tsx");
const realSqlObjectTab = { ...(await import(SQL_OBJECT_TAB)) };
let stubbing = true;
afterAll(() => { stubbing = false; });
const RealReadOnlySql = realSqlObjectTab.ReadOnlySql as (p: { sql: string }) => React.ReactNode;
mock.module(SQL_OBJECT_TAB, () => ({
  ...realSqlObjectTab,
  ReadOnlySql: (p: { sql: string }) => (stubbing ? <pre data-script="">{p.sql}</pre> : <RealReadOnlySql {...p} />),
}));

const { useDatabase } = await import("../../../src/web/components/database/use-database");
const { useQueryRunner } = await import("../../../src/web/components/database/query/use-query-runner");
const { GridSaveHost } = await import("../../../src/web/components/database/grid/grid-save-host.tsx");
const { GridSaveCancelled, useGridSave } = await import("../../../src/web/components/database/grid/grid-save-store.ts");

const TARGET = { kind: "connection", connectionId: 5 } as const;
const SCHEMA = [
  { name: "id", type: "integer", nullable: false, pk: true, defaultValue: null, fk: null },
  { name: "qty", type: "integer", nullable: true, pk: false, defaultValue: null, fk: null },
];
const CHANGES = { inserts: [], updates: [{ key: { id: 1 }, set: { qty: 9 }, original: { qty: 0 } }], deletes: [] };
const APPLIED = { inserted: 0, updated: 1, deleted: 0, cascaded: 0, executionTimeMs: 4 };

type Req = { url: string; body: Record<string, unknown> | undefined };
const realFetch = globalThis.fetch;
let requests: Req[] = [];
/** Rows in the stub's table. */
const TOTAL = 250;
/** The stub's `qty` of row 1: 9 once a change set is applied. */
let qty = 0;

let success: ReturnType<typeof spyOn>;
beforeEach(() => {
  requests = [];
  qty = 0;
  sessionStorage.clear();
  localStorage.clear();
  useGridSave.setState({ pending: null, seq: 0 });
  success = spyOn(toast, "success").mockImplementation(() => 0);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, body });
    const json = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("/api/db/connections/5/schema")) return json(SCHEMA);
    if (url.startsWith("/api/db/connections/5/grid/count")) return json({ count: TOTAL, estimate: null });
    if (url.startsWith("/api/db/connections/5/grid")) {
      const { offset, limit } = body as { offset: number; limit: number };
      const end = Math.min(TOTAL, offset + limit);
      const rows = Array.from({ length: Math.max(0, end - offset) }, (_, i) => [offset + i + 1, 0]);
      return json({ columns: SCHEMA.map((c) => ({ name: c.name, type: c.type })), rows, hasMore: end < TOTAL, sql: "SELECT * FROM orders", rowKey: ["id"] });
    }
    if (url.startsWith("/api/db/connections/5/query/script")) {
      const sql = String(body!.sql).trim();
      const result = {
        index: 0, startLine: 1, endLine: 1, sql, durationMs: 1,
        resultSets: [{ columns: [{ name: "id", type: "integer" }, { name: "qty", type: "integer" }], rows: [[1, qty]] }],
      };
      const events = [
        { type: "start", statements: [{ startLine: 1, endLine: 1 }] },
        { type: "running", index: 0 },
        { type: "statement", result },
        { type: "done", durationMs: 1 },
      ];
      return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (url.startsWith("/api/db/connections/5/changeset/preview")) return json({ script: `UPDATE "orders" SET "qty" = 9 WHERE "id" = 1;`, statementCount: 1, references: [] });
    if (url.startsWith("/api/db/connections/5/changeset/apply")) {
      qty = 9;
      return json(APPLIED);
    }
    return new Response(JSON.stringify({ ok: false, error: `no stub for ${url}` }), { status: 404 });
  }) as typeof fetch;
});

let views: Mounted[] = [];
afterEach(async () => {
  for (const v of views) await v.unmount();
  views = [];
  success.mockRestore();
  globalThis.fetch = realFetch;
});

/**
 * Lets React and the stub's answers run, five milliseconds at a time, until `done` holds — for up
 * to two seconds. One fixed five milliseconds was not always enough on a loaded machine.
 */
async function settle(done: () => boolean) {
  for (let waited = 0; waited < 2000; waited += 5) {
    await act(async () => { await Bun.sleep(5); });
    if (done()) return;
  }
}
const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;
const after = (start: number) => requests.slice(start).map((r) => r.url.replace("/api/db/connections/5", "").replace(/\?.*$/, ""));

/** What the grid would be told of a save: resolved, or rejected with why. */
async function asked(save: () => Promise<unknown>) {
  const outcome: { saved?: boolean; error?: unknown } = {};
  await act(async () => {
    void save().then(() => { outcome.saved = true; }, (error) => { outcome.error = error; });
  });
  // Until the dialog shows the change set's script: OK does nothing before.
  await settle(() => document.body.querySelector("[data-script]") !== null);
  return outcome;
}

describe("a table's data tab", () => {
  let db: ReturnType<typeof useDatabase>;
  function Probe() {
    db = useDatabase(TARGET);
    return null;
  }
  async function open() {
    views.push(await mount(<><Probe /><GridSaveHost /></>));
    await act(async () => { await db.selectTable("orders", "public"); });
    await act(async () => { db.loadMore(); });
    await settle(() => db.tableData?.rows.length === 200);
    expect(db.tableData?.rows.length).toBe(200);
  }

  it("saves through the dialog, then reads again as many rows as it had and counts them again", async () => {
    await open();
    const start = requests.length;
    const outcome = await asked(() => db.saveChanges(CHANGES, null));
    expect(after(start)).toEqual(["/changeset/preview"]);
    expect(requests.at(-1)!.body).toEqual({ table: "orders", schema: "public", ...CHANGES });
    await click(button("OK"));
    await settle(() => outcome.saved !== undefined && after(start).length >= 4);
    expect(outcome.saved).toBe(true);
    expect(after(start)).toEqual(["/changeset/preview", "/changeset/apply", "/grid", "/grid/count"]);
    expect(requests.find((r, i) => i > start && r.url.endsWith("/grid"))!.body).toMatchObject({ offset: 0, limit: 200 });
    expect(db.tableData?.rows.length).toBe(200);
  });

  it("reads nothing again when the dialog is closed, and rejects: the grid keeps its changes", async () => {
    await open();
    const start = requests.length;
    const outcome = await asked(() => db.saveChanges(CHANGES, null));
    await click(button("Close"));
    await settle(() => outcome.error !== undefined);
    expect(outcome.error).toBeInstanceOf(GridSaveCancelled);
    expect(after(start)).toEqual(["/changeset/preview"]);
  });
});

describe("an editable Query result", () => {
  let runner: ReturnType<typeof useQueryRunner>;
  function Probe() {
    runner = useQueryRunner(TARGET, { maxRows: 100, continueOnError: false });
    return null;
  }
  const rows = () => runner.run?.results[0]?.resultSets[0]?.rows;

  it("saves through the dialog to the table named, then runs that result's statement again", async () => {
    views.push(await mount(<><Probe /><GridSaveHost /></>));
    await act(async () => { await runner.start({ sql: "  SELECT * FROM orders  ", kind: "script", lineOffset: 0 }); });
    expect(rows()).toEqual([[1, 0]]);
    const first = runner.run!.runId;
    const start = requests.length;
    const outcome = await asked(() => runner.saveChangesIn("0:0", "orders", "public", CHANGES, null));
    expect(requests.at(-1)!.body).toEqual({ table: "orders", schema: "public", ...CHANGES });
    await click(button("OK"));
    await settle(() => outcome.saved !== undefined && after(start).length >= 3 && runner.rereading === null);
    expect(outcome.saved).toBe(true);
    expect(after(start)).toEqual(["/changeset/preview", "/changeset/apply", "/query/script"]);
    // The statement as the run read it, under a run id of its own, at the run's row limit.
    const reread = requests.at(-1)!.body!;
    expect(reread).toMatchObject({ sql: "SELECT * FROM orders", maxRows: 100 });
    expect(reread.runId).not.toBe(first);
    // What the table holds now, in the same run: its tab and messages stay where they were.
    expect(runner.run!.runId).toBe(first);
    expect(rows()).toEqual([[1, 9]]);
    expect(runner.rereading).toBeNull();
  });

  it("runs nothing again when the dialog is closed, and rejects", async () => {
    views.push(await mount(<><Probe /><GridSaveHost /></>));
    await act(async () => { await runner.start({ sql: "SELECT * FROM orders", kind: "script", lineOffset: 0 }); });
    const start = requests.length;
    const outcome = await asked(() => runner.saveChangesIn("0:0", "orders", "public", CHANGES, null));
    await click(button("Close"));
    await settle(() => outcome.error !== undefined);
    expect(outcome.error).toBeInstanceOf(GridSaveCancelled);
    expect(after(start)).toEqual(["/changeset/preview"]);
    expect(rows()).toEqual([[1, 0]]);
  });
});
