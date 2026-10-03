/**
 * How a table's rows are read, as DBGate reads them: the first 100, then 100 more each time the
 * grid reaches its last row — one request at a time, from where the previous one stopped — and
 * Fetch all for the rest, a few thousand per request. Then the count beside them, and the timer
 * behind auto refresh. Driven through the hooks against a stub server; what reaches it is what is
 * asserted.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { toast } = await import("sonner");
const { FETCH_ALL_CHUNK, GRID_PAGE_SIZE, rowCountView, useDatabase } = await import("../../../src/web/components/database/use-database");
const { useAutoRefresh } = await import("../../../src/web/components/database/grid/refresh-menu");

type Db = ReturnType<typeof useDatabase>;
type Target = Parameters<typeof useDatabase>[0];

const TARGET: Target = { kind: "connection", connectionId: 5 };
const SCHEMA = [
  { name: "id", type: "integer", nullable: false, pk: true, defaultValue: null, fk: null },
  { name: "qty", type: "integer", nullable: true, pk: false, defaultValue: null, fk: null },
];

type GridBody = { offset: number; limit: number; sort: unknown[]; filters: unknown[]; anyColumn: unknown[] };
type Req = { url: string; body: Record<string, unknown> | undefined };

const realFetch = globalThis.fetch;
let requests: Req[] = [];
/** Rows in the stub's table. */
let total = 250;
/** What the stub's count answers. */
let countAnswer: Record<string, unknown> = {};
/** While set, a read of rows waits for it: the next one handed out is resolved by the test. */
let gates: (() => void)[] | null = null;

beforeEach(() => {
  requests = [];
  total = 250;
  countAnswer = { count: 250, estimate: null };
  gates = null;
  // The plain first page of a table is cached per browser tab.
  sessionStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(status === 200 ? { ok: true, data } : { ok: false, error: data }), { status, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("/api/db/connections/5/schema")) return json(200, SCHEMA);
    if (url.startsWith("/api/db/connections/5/grid/count")) return json(200, countAnswer);
    if (url.startsWith("/api/db/connections/5/grid")) {
      if (gates) await new Promise<void>((resolve) => gates!.push(resolve));
      const { offset, limit } = body as unknown as GridBody;
      const end = Math.min(total, offset + limit);
      const rows = Array.from({ length: Math.max(0, end - offset) }, (_, i) => [offset + i + 1, (offset + i) % 7]);
      return json(200, { columns: SCHEMA.map((c) => ({ name: c.name, type: c.type })), rows, hasMore: end < total, sql: "SELECT * FROM orders", rowKey: ["id"] });
    }
    return json(404, `no stub for ${url}`);
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

const settle = () => act(async () => { await Bun.sleep(5); });

let db: Db;
function Probe() {
  db = useDatabase(TARGET);
  return null;
}

async function open() {
  view = await mount(<Probe />);
  await act(async () => { await db.selectTable("orders", "public"); });
  await settle();
}

const gridReads = () => requests.filter((r) => /\/grid(\?|$)/.test(r.url)).map((r) => {
  const b = r.body as unknown as GridBody;
  return [b.offset, b.limit];
});
const counts = () => requests.filter((r) => r.url.includes("/grid/count")).map((r) => r.body);
const rows = () => db.tableData?.rows.length ?? 0;

/** Lets a read waiting at the stub through: the oldest, or the newest. */
async function release(which: "oldest" | "newest" = "oldest") {
  await act(async () => {
    while (!gates?.length) await Bun.sleep(1);
    (which === "oldest" ? gates.shift() : gates.pop())!();
    await Bun.sleep(5);
  });
}

describe("reading a table's rows", () => {
  it("reads the first 100 rows and counts the table beside them", async () => {
    await open();
    expect(GRID_PAGE_SIZE).toBe(100);
    expect(gridReads()).toEqual([[0, 100]]);
    expect(rows()).toBe(100);
    expect(db.tableData?.hasMore).toBe(true);
    expect(counts()).toEqual([{ table: "orders", schema: "public", filters: [], anyColumn: [] }]);
    expect(db.rowCount?.text).toBe("Rows: 250");
  });

  it("reads 100 more each time the end is reached, once however often it is asked", async () => {
    await open();
    gates = [];
    act(() => { db.loadMore(); db.loadMore(); db.loadMore(); });
    await settle();
    expect(db.loadingMore).toBe(true);
    await release();
    expect(gridReads()).toEqual([[0, 100], [100, 100]]);
    expect(rows()).toBe(200);
    expect(db.loadingMore).toBe(false);
    expect(db.tableData?.rows.slice(99, 101).map((r) => r.id)).toEqual([100, 101]);
  });

  it("stops at the last row, and counts what it holds rather than asking the database", async () => {
    await open();
    await act(async () => { db.loadMore(); await Bun.sleep(5); });
    await act(async () => { db.loadMore(); await Bun.sleep(5); });
    expect(gridReads()).toEqual([[0, 100], [100, 100], [200, 100]]);
    expect(rows()).toBe(250);
    expect(db.tableData?.hasMore).toBe(false);
    await act(async () => { db.loadMore(); await Bun.sleep(5); });
    expect(gridReads()).toHaveLength(3);
    expect(counts()).toHaveLength(1);
    expect(db.rowCount).toMatchObject({ text: "Rows: 250", canCountExactly: false });
  });

  it("knows the count with no request at all when the first rows are every row", async () => {
    total = 40;
    await open();
    expect(rows()).toBe(40);
    expect(counts()).toEqual([]);
    expect(db.rowCount?.text).toBe("Rows: 40");
  });

  it("reads the rest with Fetch all, 5000 at a time, saying how many are loaded as they come", async () => {
    total = 12_345;
    countAnswer = { count: 12_345, estimate: null };
    await open();
    gates = [];
    let done: ReturnType<Db["fetchAll"]> | undefined;
    act(() => { done = db.fetchAll(); });
    await settle();
    expect(db.fetchingAll).toBe(100);
    await release();
    expect(db.fetchingAll).toBe(5_100);
    await release();
    expect(db.fetchingAll).toBe(10_100);
    await release();
    let loaded: Awaited<ReturnType<Db["fetchAll"]>> = null;
    await act(async () => { loaded = await done!; });
    // Answered with every row, before the state holding them has been rendered.
    expect((loaded as { rows: unknown[] } | null)?.rows).toHaveLength(12_345);
    expect(FETCH_ALL_CHUNK).toBe(5_000);
    expect(gridReads()).toEqual([[0, 100], [100, 5_000], [5_100, 5_000], [10_100, 5_000]]);
    expect(rows()).toBe(12_345);
    expect(db.fetchingAll).toBeNull();
    expect(db.tableData?.hasMore).toBe(false);
  });

  it("answers nothing when the view starts over during Fetch all, and stops reading", async () => {
    total = 12_345;
    await open();
    gates = [];
    let done: ReturnType<Db["fetchAll"]> | undefined;
    act(() => { done = db.fetchAll(); });
    await settle();
    // Read again, the table now holds every row in its first page: the view that replaced the
    // fetched one is complete, and still not what Fetch all was asked to read.
    total = 50;
    let refreshed: Promise<unknown> | undefined;
    act(() => { refreshed = db.reload(); });
    // The refresh lands first: a Fetch all looking only at the rows held would then take the new
    // view's 50 for its own.
    await release("newest");
    await release("oldest");
    await act(async () => { await refreshed; });
    let loaded: Awaited<ReturnType<Db["fetchAll"]>> | "pending" = "pending";
    await act(async () => { loaded = await done!; });
    expect(loaded).toBeNull();
    // The first chunk and the refresh; no second chunk for a view that is gone.
    expect(gridReads()).toEqual([[0, 100], [100, 5_000], [0, 100]]);
    expect(rows()).toBe(50);
    expect(db.fetchingAll).toBeNull();
  });

  it("answers nothing when there is nothing more to read", async () => {
    total = 40;
    await open();
    let loaded: Awaited<ReturnType<Db["fetchAll"]>> | "pending" = "pending";
    await act(async () => { loaded = await db.fetchAll(); });
    expect(loaded).toBeNull();
    expect(gridReads()).toHaveLength(1);
  });

  it("drops rows still arriving for a view that has since started over", async () => {
    await open();
    gates = [];
    act(() => { db.loadMore(); });
    await settle();
    const viewKey = db.viewKey;
    let sorted: Promise<unknown> | undefined;
    act(() => { sorted = db.setSort([{ column: "qty", dir: "DESC" }, { column: "id", dir: "ASC" }]); });
    // The sorted read is answered first, the page asked for before it after it.
    await release("newest");
    expect(rows()).toBe(100);
    await release();
    await act(async () => { await sorted; });
    expect(rows()).toBe(100);
    expect(db.viewKey).toBe(viewKey + 1);
    const sortedRead = requests.filter((r) => /\/grid(\?|$)/.test(r.url)).at(-1)!.body!;
    expect(sortedRead.sort).toEqual([{ column: "qty", dir: "DESC" }, { column: "id", dir: "ASC" }]);
    expect(sortedRead.offset).toBe(0);
  });

  it("reads as many rows as are loaded on a quiet refresh, and keeps the grid where it is", async () => {
    await open();
    await act(async () => { db.loadMore(); await Bun.sleep(5); });
    const viewKey = db.viewKey;
    gates = [];
    let quiet: Promise<Error | null> | undefined;
    act(() => { quiet = db.refreshQuietly(); });
    await settle();
    // No "Loading data" box over the grid every few seconds.
    expect(db.loading).toBe(false);
    await release();
    expect(await quiet).toBeNull();
    expect(gridReads().at(-1)).toEqual([0, 200]);
    expect(rows()).toBe(200);
    expect(db.viewKey).toBe(viewKey);
    // The table and filters are the same: no second count.
    expect(counts()).toHaveLength(1);
  });

  it("starts from the first row again on Refresh, and counts again", async () => {
    await open();
    await act(async () => { db.loadMore(); await Bun.sleep(5); });
    const viewKey = db.viewKey;
    await act(async () => { await db.reload(); });
    await settle();
    expect(gridReads().at(-1)).toEqual([0, 100]);
    expect(rows()).toBe(100);
    expect(db.viewKey).toBe(viewKey + 1);
    expect(counts()).toHaveLength(2);
    // Refresh with structure reads the columns again too.
    const schemaReads = () => requests.filter((r) => r.url.includes("/schema")).length;
    const before = schemaReads();
    await act(async () => { await db.reload(); });
    expect(schemaReads()).toBe(before);
    await act(async () => { await db.reload({ structure: true }); });
    expect(schemaReads()).toBe(before + 1);
  });

  it("answers why a quiet refresh failed, and leaves the rows shown", async () => {
    await open();
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "connection lost" }), { status: 500, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    let error: Error | null = null;
    await act(async () => { error = await db.refreshQuietly(); });
    expect((error as Error | null)?.message).toContain("connection lost");
    expect(rows()).toBe(100);
    expect(db.error).toBeNull();
  });

  it("offers to count every row once the count gave up, and counts without the time limit", async () => {
    total = 5_000;
    countAnswer = { count: null, estimate: 4_200, timedOut: true };
    await open();
    expect(db.rowCount).toMatchObject({ text: `Rows: ~${(4_200).toLocaleString()}`, canCountExactly: true });
    countAnswer = { count: 5_000, estimate: null };
    await act(async () => { db.countExactly(); await Bun.sleep(5); });
    expect(counts().at(-1)).toEqual({ table: "orders", schema: "public", filters: [], anyColumn: [], exact: true });
    expect(db.rowCount).toMatchObject({ text: `Rows: ${(5_000).toLocaleString()}`, canCountExactly: false });
  });
});

describe("the row count's label", () => {
  const data = (n: number, hasMore: boolean) => ({ columns: ["id"], rows: Array.from({ length: n }, (_, i) => ({ id: i })), hasMore, countKey: "k" });
  const count = (c: Partial<{ count: number | null; estimate: number | null; pending: boolean; timedOut: boolean; failed: string }>) =>
    ({ key: "k", count: null, estimate: null, pending: false, ...c });

  it("is nothing before rows, and the rows themselves once every one is loaded", () => {
    expect(rowCountView(null, null)).toBeNull();
    expect(rowCountView(data(37, false), count({ count: 999 }))).toEqual({
      text: "Rows: 37", counting: false, canCountExactly: false, total: { kind: "exact", count: 37 },
    });
  });

  it("says the same as a number, which the form view's Row: n / N reads", () => {
    expect(rowCountView(data(100, true), count({ count: 5_231 }))?.total).toEqual({ kind: "exact", count: 5_231 });
    expect(rowCountView(data(300, true), count({ count: 250 }))?.total).toEqual({ kind: "exact", count: 300 });
    expect(rowCountView(data(100, true), count({ estimate: 90_000, pending: true }))?.total).toEqual({ kind: "estimate", count: 90_000 });
    expect(rowCountView(data(100, true), count({ estimate: 50, pending: true }))?.total).toEqual({ kind: "atLeast", count: 100 });
    expect(rowCountView(data(100, true), count({ timedOut: true }))?.total).toEqual({ kind: "many" });
    expect(rowCountView(data(100, true), count({ failed: "x", estimate: 800 }))?.total).toEqual({ kind: "estimate", count: 800 });
  });

  it("shows the count once known, never fewer than are loaded", () => {
    expect(rowCountView(data(100, true), count({ count: 5_231 }))?.text).toBe(`Rows: ${(5_231).toLocaleString()}`);
    // Rows added since the count.
    expect(rowCountView(data(300, true), count({ count: 250 }))?.text).toBe("Rows: 300");
  });

  it("ignores a count of other filters", () => {
    expect(rowCountView(data(100, true), { ...count({ count: 7 }), key: "other" })?.text).toBe("Rows: 100+");
  });

  it("shows the estimate while counting, only when it says more than is loaded", () => {
    expect(rowCountView(data(100, true), count({ estimate: 90_000, pending: true }))).toMatchObject({ text: `Rows: ~${(90_000).toLocaleString()}`, counting: true });
    expect(rowCountView(data(100, true), count({ estimate: 50, pending: true }))).toMatchObject({ text: "Rows: 100+", counting: true });
  });

  it("is a button after the count gave up or failed, saying which", () => {
    const timedOut = rowCountView(data(100, true), count({ timedOut: true }));
    expect(timedOut).toMatchObject({ text: "Rows: Many", canCountExactly: true });
    expect(timedOut?.title).toContain("Click to count every row");
    const failed = rowCountView(data(100, true), count({ failed: "permission denied", estimate: 800 }));
    expect(failed).toMatchObject({ text: "Rows: ~800", canCountExactly: true });
    expect(failed?.title).toContain("permission denied");
  });
});

describe("auto refresh", () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let timers: Map<number, { fn: () => void; ms: number }>;
  beforeEach(() => {
    timers = new Map();
    let next = 1;
    globalThis.setInterval = ((fn: () => void, ms: number) => { timers.set(next, { fn, ms }); return next++; }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as unknown as typeof clearInterval;
  });
  afterEach(() => {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  let auto: ReturnType<typeof useAutoRefresh>;
  let calls = 0;
  let answer: () => Promise<Error | null>;
  let allowed = true;
  function Timer() {
    auto = useAutoRefresh(() => { calls += 1; return answer(); }, () => allowed);
    return null;
  }
  async function start(every?: number) {
    calls = 0;
    allowed = true;
    answer = async () => null;
    view = await mount(<Timer />);
    await act(async () => { auto.start(every); });
  }
  const tick = () => act(async () => {
    for (const t of [...timers.values()]) t.fn();
    await Bun.sleep(1);
  });

  it("refreshes every 10 seconds unless told otherwise, and stops", async () => {
    await start();
    expect([...timers.values()].map((t) => t.ms)).toEqual([10_000]);
    expect(auto).toMatchObject({ running: true, every: 10 });
    await tick();
    await tick();
    expect(calls).toBe(2);
    await act(async () => { auto.stop(); });
    expect(timers.size).toBe(0);
    expect(auto.running).toBe(false);
  });

  it("moves to the interval picked, keeping one timer", async () => {
    await start(5);
    await act(async () => { auto.start(1); });
    expect([...timers.values()].map((t) => t.ms)).toEqual([1_000]);
    expect(auto.every).toBe(1);
  });

  it("skips a tick while the last refresh is out, the tab is not on screen, or the page is hidden", async () => {
    await start();
    let finish!: () => void;
    answer = () => new Promise((resolve) => { finish = () => resolve(null); });
    await tick();
    await tick();
    expect(calls).toBe(1);
    await act(async () => { finish(); await Bun.sleep(1); });
    answer = async () => null;
    await tick();
    expect(calls).toBe(2);
    allowed = false;
    await tick();
    expect(calls).toBe(2);
    allowed = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await tick();
    expect(calls).toBe(2);
  });

  it("stops at the first failure, saying why, rather than failing every second", async () => {
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      await start(1);
      answer = async () => new Error("relation \"orders\" does not exist");
      await tick();
      expect(auto.running).toBe(false);
      expect(timers.size).toBe(0);
      expect(shown.mock.calls).toEqual([["Auto refresh stopped", { description: "relation \"orders\" does not exist" }]]);
    } finally {
      shown.mockRestore();
    }
  });

  it("says nothing of a refresh that fails after it was stopped", async () => {
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      await start();
      let fail!: () => void;
      answer = () => new Promise((resolve) => { fail = () => resolve(new Error("late")); });
      await tick();
      await act(async () => { auto.stop(); });
      await act(async () => { fail(); await Bun.sleep(1); });
      expect(shown).not.toHaveBeenCalled();
    } finally {
      shown.mockRestore();
    }
  });
});
