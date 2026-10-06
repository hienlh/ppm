/**
 * The filters send a request only when what they ask for changes: a text that does not read
 * sends nothing, and neither does committing the same text again. A refusal is shown on the
 * filter the server's reason belongs to.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { useTableFilters, refusedFilters } = await import("../../../src/web/components/database/grid/use-table-filters.ts");
const { withColumnFilter, withMultiFilter } = await import("../../../src/web/components/database/grid/grid-filters.ts");
const { ApiError } = await import("../../../src/web/lib/api-client.ts");
const { toast } = await import("sonner");
type FilterRequest = import("../../../src/web/components/database/grid/grid-filters.ts").FilterRequest;
type FilterableColumn = import("../../../src/shared/db-filter-parser.ts").FilterableColumn;
type GridFilters = import("../../../src/web/components/database/grid/grid-filters.ts").GridFilters;
type Hook = ReturnType<typeof useTableFilters>;

const COLUMNS: FilterableColumn[] = [{ name: "qty", kind: "number" }, { name: "name", kind: "text" }];

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

async function render(
  columns: FilterableColumn[],
  answer: (req: FilterRequest) => Error | null | Promise<Error | null> = () => null,
  initial?: GridFilters,
) {
  const sent: FilterRequest[] = [];
  const ref = {} as { current: Hook; columns: FilterableColumn[] };
  let setColumns!: (c: FilterableColumn[]) => void;
  const { useState } = await import("react");
  function Harness() {
    const [cols, set] = useState(columns);
    setColumns = set;
    ref.current = useTableFilters(cols, async (req) => { sent.push(req); return answer(req); }, initial);
    return null;
  }
  view = await mount(<Harness />);
  return { ref, sent, setColumns: (c: FilterableColumn[]) => act(async () => { setColumns(c); }) };
}

const commit = (ref: { current: Hook }, column: string, text: string) =>
  act(async () => { ref.current.setFilters((f) => withColumnFilter(f, column, text)); });

describe("useTableFilters", () => {
  it("sends nothing at first, and nothing until the columns' types are known", async () => {
    const { ref, sent, setColumns } = await render([]);
    await commit(ref, "qty", "5");
    expect(sent).toEqual([]);
    await setColumns(COLUMNS);
    expect(sent).toEqual([{ filters: [{ column: "qty", anyOf: [[{ op: "eq", value: 5 }]] }], anyColumn: [] }]);
  });

  it("sends a filter once, however often the same text is committed", async () => {
    const { ref, sent } = await render(COLUMNS);
    expect(sent).toEqual([]);
    await commit(ref, "qty", ">=5 <=10");
    await commit(ref, "qty", ">=5 <=10");
    expect(sent).toHaveLength(1);
    await commit(ref, "qty", ">=5");
    expect(sent).toHaveLength(2);
  });

  it("sends nothing for a text that does not read", async () => {
    const { ref, sent } = await render(COLUMNS);
    await commit(ref, "qty", ">=");
    await commit(ref, "qty", "abc");
    expect(sent).toEqual([]);
    // The filter is kept as typed all the same.
    expect(ref.current.filters.columns.qty).toEqual({ text: "abc" });
  });

  it("sends the Multi column filter with the column filters", async () => {
    const { ref, sent } = await render(COLUMNS);
    await act(async () => { ref.current.setFilters((f) => withMultiFilter(f, "abc")); });
    expect(sent).toEqual([{ filters: [], anyColumn: [{ column: "name", anyOf: [[{ op: "contains", value: "abc" }]] }] }]);
  });

  it("sends nothing while the columns are reloaded, when they come back the same", async () => {
    const { ref, sent, setColumns } = await render(COLUMNS);
    await commit(ref, "qty", "5");
    await setColumns([]);
    await setColumns([...COLUMNS]);
    expect(sent).toHaveLength(1);
  });

  it("does not show the refusal of a request the filters have already moved on from", async () => {
    let refuse!: (e: Error) => void;
    const { ref } = await render(COLUMNS, (req) =>
      req.filters[0]?.column === "qty" ? new Promise<Error>((resolve) => { refuse = resolve; }) : null);
    await commit(ref, "qty", "5");
    await commit(ref, "qty", "");
    await commit(ref, "name", "a");
    await act(async () => { refuse(new ApiError("Unknown column \"qty\"", 400, {})); });
    expect(ref.current.errors).toEqual({});
  });

  it("says so when a failure is not one a filter explains", async () => {
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      const { ref } = await render(COLUMNS, () => new ApiError("connection reset", 500, {}));
      await commit(ref, "qty", "5");
      expect(shown).toHaveBeenCalledWith("Could not filter the rows", { description: "connection reset" });
      expect(ref.current.errors).toEqual({});
    } finally {
      shown.mockRestore();
    }
  });

  it("shows a refusal on the filter it belongs to, and forgets it once the filters change", async () => {
    const refusal = new ApiError("Connection is readonly", 403, {});
    const { ref, sent } = await render(COLUMNS, (req) => (req.filters.some((g) => g.column === "name") ? refusal : null));
    await commit(ref, "qty", "5");
    await commit(ref, "name", "{$$ IN (DELETE FROM t)}");
    expect(ref.current.errors).toEqual({ name: "Connection is readonly" });
    await commit(ref, "name", "");
    expect(sent).toHaveLength(3);
    expect(ref.current.errors).toEqual({});
  });
});

describe("filters a tab kept", () => {
  const KEPT: GridFilters = { columns: { qty: { text: "5" }, name: { text: "{$$ ~ 'x'}" }, gone: { text: "1" } } };
  const KEPT_REQUEST: FilterRequest = {
    filters: [{ column: "qty", anyOf: [[{ op: "eq", value: 5 }]] }, { column: "name", anyOf: [[{ op: "rawSql", sql: "$$ ~ 'x'" }]] }],
    anyColumn: [],
  };
  const open = async (kept: GridFilters = KEPT) => {
    const harness = await render([], undefined, kept);
    let asked!: FilterRequest;
    await act(async () => { asked = harness.ref.current.opening(COLUMNS); });
    return { ...harness, asked };
  };

  it("opens on them, and asks for nothing more once the columns are known", async () => {
    const { ref, sent, setColumns, asked } = await open();
    expect(asked).toEqual(KEPT_REQUEST);
    await setColumns(COLUMNS);
    expect(sent).toEqual([]);
    expect(ref.current.filters).toEqual(KEPT);
  });

  it("asks for them as soon as the columns are known, when the first read could not", async () => {
    const { sent, setColumns } = await render([], undefined, KEPT);
    await setColumns(COLUMNS);
    expect(sent).toEqual([KEPT_REQUEST]);
  });

  it("shows a refusal of the first read on the filter to blame, and reads nothing until the filters change", async () => {
    const { ref, sent, setColumns } = await open();
    await setColumns(COLUMNS);
    await act(async () => { ref.current.openFailed(new ApiError("syntax error at or near \"~\"", 500, {})); });
    expect(ref.current.errors).toEqual({ name: "syntax error at or near \"~\"" });
    expect(sent).toEqual([]);
    await commit(ref, "name", "");
    expect(sent).toEqual([{ filters: [KEPT_REQUEST.filters[0]!], anyColumn: [] }]);
    expect(ref.current.errors).toEqual({});
  });

  it("blames no filter for a failure no filter explains, nor when the first read asked for none", async () => {
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      const plain = await open({ columns: { qty: { text: "5" } } });
      await act(async () => { plain.ref.current.openFailed(new ApiError("connection reset", 500, {})); });
      expect(plain.ref.current.errors).toEqual({});
      await view!.unmount();

      const off = await open({ columns: { qty: { text: "5", off: true } } });
      expect(off.asked).toEqual({ filters: [], anyColumn: [] });
      await act(async () => { off.ref.current.openFailed(new ApiError("Unknown column \"qty\"", 400, {})); });
      expect(off.ref.current.errors).toEqual({});
      await view!.unmount();

      // A table opened on no kept filters never asked for any.
      const none = await render(COLUMNS);
      await act(async () => { none.ref.current.openFailed(new ApiError("Unknown column \"qty\"", 400, {})); });
      expect(none.ref.current.errors).toEqual({});
      // The table shows these itself.
      expect(shown).not.toHaveBeenCalled();
    } finally {
      shown.mockRestore();
    }
  });
});

describe("refusedFilters", () => {
  const request: FilterRequest = {
    filters: [
      { column: "qty", anyOf: [[{ op: "gt", value: 1 }]] },
      { column: "name", anyOf: [[{ op: "contains", value: "a" }], [{ op: "rawSql", sql: "$$ ~ 'x'" }]] },
    ],
    anyColumn: [],
  };
  const plain: FilterRequest = { filters: [request.filters[0]!], anyColumn: [] };

  it("puts a database error on the SQL the user wrote", () => {
    expect(refusedFilters(request, new ApiError("syntax error at or near \"~\"", 500, {}))).toEqual({ name: "syntax error at or near \"~\"" });
  });

  it("puts a refusal of the request on every filtered column when no SQL was written", () => {
    expect(refusedFilters(plain, new ApiError("Unknown column \"qty\"", 400, {}))).toEqual({ qty: "Unknown column \"qty\"" });
    expect(refusedFilters(plain, new ApiError("Connection is readonly", 403, {}))).toEqual({ qty: "Connection is readonly" });
  });

  it("blames no filter for a failure no filter explains", () => {
    // A database error with no SQL of the user's in the request is PPM's, not the filter's.
    expect(refusedFilters(plain, new ApiError("connection reset", 500, {}))).toBeNull();
    expect(refusedFilters(request, new ApiError("Table not found", 404, {}))).toBeNull();
    expect(refusedFilters(request, new ApiError("Password required", 428, {}))).toBeNull();
    expect(refusedFilters(request, new Error("Failed to fetch"))).toBeNull();
  });
});
