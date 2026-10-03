/**
 * What ⋮ and ⋯ ask the server for: a column's values under the other filters in force, and the
 * table a foreign key references, read in the schema of the table the key is on. The Description
 * chosen for a table is read from and saved to the synced settings.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { useFilterPickers, lookupTableKey } = await import("../../../src/web/components/database/grid/use-filter-pickers.ts");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store.ts");
type Pickers = ReturnType<typeof useFilterPickers>;
type Args = Parameters<typeof useFilterPickers>[0];
type Dialog = NonNullable<ReturnType<Pickers["lookup"]>>;

type Req = { method: string; url: string; body: unknown };
const realFetch = globalThis.fetch;
let requests: Req[] = [];
let answers = new Map<string, unknown>();

beforeEach(() => {
  requests = [];
  answers = new Map();
  useSettingsStore.setState({ dbLookupDescriptions: {} });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(req);
    const data = answers.get(`${req.method} ${req.url}`) ?? {};
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await view?.unmount();
  view = null;
});

const ORDERS: Args = {
  target: { kind: "connection", connectionId: 1, database: "shop" },
  dbType: "postgres",
  table: "orders",
  schema: "sales",
  columns: [{ name: "status", kind: "text" }, { name: "qty", kind: "number" }, { name: "plan_id", kind: "number" }],
  tableSchema: [
    { name: "status", type: "text", nullable: true, pk: false },
    { name: "qty", type: "integer", nullable: true, pk: false },
    { name: "plan_id", type: "integer", nullable: true, pk: false, fk: { table: "plans", column: "id" } },
  ],
  filters: { columns: { status: { text: "active" }, qty: { text: ">5" } }, multi: { text: "acme" } },
};

async function pickers(args: Partial<Args> = {}): Promise<Pickers> {
  let got!: Pickers;
  function Probe() {
    got = useFilterPickers({ ...ORDERS, ...args });
    return null;
  }
  view = await mount(<Probe />);
  return got;
}

const lookupOf = (p: Pickers, column: string) => {
  const d = p.lookup(column);
  if (!d || d.dialog !== "lookup") throw new Error(`no lookup on ${column}`);
  return d as Extract<Dialog, { dialog: "lookup" }>;
};

describe("filter pickers", () => {
  it("asks ⋮ for a column's values under every filter in force but its own", async () => {
    const p = await pickers();
    const d = p.chooseValues("status");
    if (d.dialog !== "values") throw new Error(d.dialog);
    expect(d).toMatchObject({ column: "status", kind: "text" });
    answers.set("POST /api/db/connections/1/grid/values?database=shop", { values: ["active"], hasMore: false, sql: "" });
    expect(await d.load(" ac ")).toEqual({ values: ["active"], hasMore: false, sql: "" });
    expect(requests).toEqual([{
      method: "POST",
      url: "/api/db/connections/1/grid/values?database=shop",
      body: {
        table: "orders", schema: "sales", column: "status", search: "ac",
        filters: [{ column: "qty", anyOf: [[{ op: "gt", value: 5 }]] }],
        anyColumn: [{ column: "status", anyOf: [[{ op: "contains", value: "acme" }]] }],
      },
    }]);
  });

  it("offers ⋯ only on a foreign key, writing in the key column's own kind", async () => {
    const p = await pickers();
    expect(p.lookup("status")).toBeNull();
    expect(p.lookup("missing")).toBeNull();
    const d = lookupOf(p, "plan_id");
    expect(d.kind).toBe("number");
    expect(d.source).toMatchObject({ table: "plans", keyColumn: "id", description: null });
  });

  it("reads the referenced table's columns and first rows by key, in the same schema", async () => {
    const { source } = lookupOf(await pickers(), "plan_id");
    answers.set("GET /api/db/connections/1/schema?table=plans&schema=sales&database=shop", [
      { name: "id", type: "integer", nullable: false, pk: true, defaultValue: null, fk: null },
      { name: "name", type: "varchar(40)", nullable: true, pk: false, defaultValue: null, fk: null },
    ]);
    expect(await source.columns()).toEqual([{ name: "id", kind: "number" }, { name: "name", kind: "text" }]);

    answers.set("POST /api/db/connections/1/grid?database=shop", {
      columns: [{ name: "id", type: "int4" }, { name: "name", type: "varchar" }], rows: [[1, "Basic"], [2, "Pro"]], hasMore: true, sql: "", rowKey: ["id"],
    });
    const search = [{ column: "name", anyOf: [[{ op: "contains" as const, value: "pro" }]] }];
    expect(await source.rows(search)).toEqual({ rows: [{ id: 1, name: "Basic" }, { id: 2, name: "Pro" }], hasMore: true });
    expect(requests.at(-1)).toEqual({
      method: "POST",
      url: "/api/db/connections/1/grid?database=shop",
      body: { table: "plans", schema: "sales", anyColumn: search, sort: [{ column: "id", dir: "ASC" }], offset: 0, limit: 100 },
    });
  });

  it("leaves the schema out for the connection's own", async () => {
    const { source } = lookupOf(await pickers({ schema: "" }), "plan_id");
    answers.set("GET /api/db/connections/1/schema?table=plans&database=shop", []);
    await source.columns();
    expect(requests.at(-1)!.url).toBe("/api/db/connections/1/schema?table=plans&database=shop");
  });

  it("remembers the Description per table of each target, and reads it back", async () => {
    const key = lookupTableKey(ORDERS.target, "sales", "plans");
    expect(key).toBe("1:shop:sales:plans");
    expect(lookupTableKey({ kind: "file", path: "/data/a:b.db" }, "", "my plans")).toBe("file::%2Fdata%2Fa%3Ab.db::my%20plans");
    expect(lookupTableKey(ORDERS.target, "sales", "plans")).not.toBe(lookupTableKey({ kind: "connection", connectionId: 1, database: "reporting" }, "sales", "plans"));

    lookupOf(await pickers(), "plan_id").source.onDescription("name");
    expect(useSettingsStore.getState().dbLookupDescriptions).toEqual({ [key]: "name" });
    // Synced with the other UI prefs, which go to the server a moment after the last change.
    await Bun.sleep(450);
    expect(requests.find((r) => r.method === "PUT" && r.url === "/api/settings/ui-prefs")?.body).toEqual({ dbLookupDescriptions: { [key]: "name" } });
    await view!.unmount();
    view = null;
    expect(lookupOf(await pickers(), "plan_id").source.description).toBe("name");
  });
});
