import { describe, expect, it } from "bun:test";
import {
  NO_FILTERS, TAB_FILTER_CAPS, columnFilterState, filterRequest, filterableColumns, filtersOnColumns, hasFilters, linesFilter,
  multiFilterState, readTabFilters, withColumnFilter, withFilterOff, withMultiFilter, withTabFilters, type GridFilters,
} from "../../../src/web/components/database/grid/grid-filters.ts";
import type { FilterableColumn } from "../../../src/shared/db-filter-parser.ts";

const COLUMNS: FilterableColumn[] = [
  { name: "id", kind: "number" },
  { name: "name", kind: "text" },
  { name: "created", kind: "datetime" },
];
const NOW = new Date(2026, 9, 1, 10, 0, 0);
const NOTHING = { filters: [], anyColumn: [] };

describe("filterableColumns", () => {
  it("classifies each column the way its engine prints the type", () => {
    const schema = [{ name: "n", type: "integer" }, { name: "flag", type: "tinyint(1)" }, { name: "at", type: "timestamp with time zone" }];
    expect(filterableColumns(schema, "postgres").map((c) => c.kind)).toEqual(["number", "other", "datetimetz"]);
    expect(filterableColumns(schema, "mysql").map((c) => c.kind)).toEqual(["number", "boolean", "datetime"]);
  });

  it("reads every column as plain text until the engine is known", () => {
    expect(filterableColumns([{ name: "n", type: "integer" }], undefined)).toEqual([{ name: "n", kind: "other" }]);
  });
});

describe("filter states", () => {
  it("is empty for no filter and for a blank one", () => {
    expect(columnFilterState(undefined, "number")).toEqual({ state: "empty" });
    expect(columnFilterState({ text: "  " }, "number")).toEqual({ state: "empty" });
  });

  it("reads the text in the column's own syntax", () => {
    expect(columnFilterState({ text: ">=5 <=10" }, "number")).toEqual({ state: "ok" });
    expect(columnFilterState({ text: "abc" }, "text")).toEqual({ state: "ok" });
    const bad = columnFilterState({ text: "abc" }, "number");
    expect(bad.state).toBe("bad");
    if (bad.state === "bad") expect(bad.error).toEqual({ message: '"abc" is not a number', start: 0, end: 3 });
  });

  it("is off when switched off, but a text that does not read stays wrong", () => {
    expect(columnFilterState({ text: "5", off: true }, "number")).toEqual({ state: "off" });
    expect(columnFilterState({ text: ">=", off: true }, "number").state).toBe("bad");
  });

  it("reads the Multi column filter in every column, and fails only when none can read it", () => {
    expect(multiFilterState({ text: "abc" }, COLUMNS)).toEqual({ state: "ok" });
    const sql = multiFilterState({ text: "{$$ > 1}" }, COLUMNS);
    expect(sql.state).toBe("bad");
    expect(multiFilterState({ text: "5" }, [{ name: "on", kind: "boolean" }]).state).toBe("bad");
  });
});

describe("filterRequest", () => {
  const filters: GridFilters = {
    columns: {
      // Out of the table's order on purpose: the request follows the table.
      name: { text: "^a, ^b" },
      id: { text: ">=5 <=10" },
      gone: { text: "1" },
    },
  };

  it("sends every filter that reads, in the table's column order", () => {
    expect(filterRequest(filters, COLUMNS, NOW)).toEqual({
      filters: [
        { column: "id", anyOf: [[{ op: "ge", value: 5 }, { op: "le", value: 10 }]] },
        { column: "name", anyOf: [[{ op: "startsWith", value: "a" }], [{ op: "startsWith", value: "b" }]] },
      ],
      anyColumn: [],
    });
  });

  it("leaves out a filter that is switched off, one that does not read and a blank one", () => {
    const req = filterRequest({ columns: { id: { text: "5", off: true }, name: { text: "'open" }, created: { text: " " } } }, COLUMNS, NOW);
    expect(req).toEqual(NOTHING);
  });

  it("reads relative dates against the moment it is asked", () => {
    const req = filterRequest({ columns: { created: { text: "TODAY" } } }, COLUMNS, NOW);
    expect(req.filters[0]!.anyOf[0]![0]).toMatchObject({ op: "dateRange", from: "2026-10-01 00:00:00", to: "2026-10-02 00:00:00" });
  });

  it("sends the Multi column filter to every column that reads it, unless it is switched off", () => {
    const multi = filterRequest({ columns: {}, multi: { text: "5" } }, COLUMNS, NOW);
    expect(multi.anyColumn.map((g) => g.column)).toEqual(["id", "name"]);
    expect(multi.filters).toEqual([]);
    expect(filterRequest({ columns: {}, multi: { text: "5", off: true } }, COLUMNS, NOW).anyColumn).toEqual([]);
    expect(filterRequest({ columns: {}, multi: { text: "{$$ > 1}" } }, COLUMNS, NOW).anyColumn).toEqual([]);
  });

  it("asks for nothing before the columns are known", () => {
    expect(filterRequest(filters, [], NOW)).toEqual(NOTHING);
  });
});

describe("editing the filters", () => {
  it("sets a column's text, switching it back on, and removes it when blank", () => {
    const off: GridFilters = { columns: { id: { text: "5", off: true }, name: { text: "a" } } };
    expect(withColumnFilter(off, "id", "6")).toEqual({ columns: { id: { text: "6" }, name: { text: "a" } } });
    expect(withColumnFilter(off, "id", "  ")).toEqual({ columns: { name: { text: "a" } } });
    // The original is left alone: React compares by identity.
    expect(off.columns.id).toEqual({ text: "5", off: true });
  });

  it("sets and clears the Multi column filter", () => {
    const set = withMultiFilter(NO_FILTERS, "abc");
    expect(set).toEqual({ columns: {}, multi: { text: "abc" } });
    expect(withMultiFilter(set, "")).toEqual({ columns: {} });
    expect(withMultiFilter(set, "  ")).toEqual({ columns: {} });
  });
});

describe("switching a filter on and off", () => {
  const filters: GridFilters = { columns: { id: { text: "5" }, name: { text: "a", off: true } }, multi: { text: "x" } };

  it("switches one column's filter and keeps its text", () => {
    expect(withFilterOff(filters, "id", true)).toEqual({ columns: { id: { text: "5", off: true }, name: { text: "a", off: true } }, multi: { text: "x" } });
    const on = withFilterOff(filters, "name", false).columns.name!;
    expect(on).toEqual({ text: "a" });
    // Switched on, a filter carries no `off` at all, as one never switched off.
    expect("off" in on).toBe(false);
    expect(filters.columns.name).toEqual({ text: "a", off: true });
  });

  it("switches the Multi column filter, which is null", () => {
    const off = withFilterOff(filters, null, true);
    expect(off).toEqual({ columns: filters.columns, multi: { text: "x", off: true } });
    expect(withFilterOff(off, null, false)).toEqual(filters);
  });

  it("answers the same filters when there is no such filter", () => {
    expect(withFilterOff(filters, "missing", true)).toBe(filters);
    expect(withFilterOff(NO_FILTERS, null, true)).toBe(NO_FILTERS);
  });
});

describe("hasFilters", () => {
  it("counts a filter switched off and the Multi column filter, but not a blank one", () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ columns: { id: { text: "5", off: true } } })).toBe(true);
    expect(hasFilters({ columns: {}, multi: { text: "x", off: true } })).toBe(true);
    expect(hasFilters({ columns: {}, multi: { text: "  " } })).toBe(false);
  });
});

describe("filtersOnColumns", () => {
  it("drops the filters on columns the table no longer has", () => {
    const filters: GridFilters = { columns: { id: { text: "5" }, gone: { text: "x", off: true } }, multi: { text: "m" } };
    expect(filtersOnColumns(filters, COLUMNS)).toEqual({ columns: { id: { text: "5" } }, multi: { text: "m" } });
  });

  it("answers the same filters when none is dropped", () => {
    const filters: GridFilters = { columns: { id: { text: "5" }, created: { text: "2026" } } };
    expect(filtersOnColumns(filters, COLUMNS)).toBe(filters);
  });
});

describe("filters kept in the tab", () => {
  it("reads back what it kept, the ones switched off too, beside the tab's other metadata", () => {
    const filters: GridFilters = { columns: { id: { text: ">5" }, name: { text: "a", off: true } }, multi: { text: "x", off: true } };
    const metadata = withTabFilters({ tableName: "t", filters: { columns: {} } }, filters);
    expect(metadata).toEqual({ tableName: "t", filters });
    // Tabs are stored as JSON.
    expect(readTabFilters(JSON.parse(JSON.stringify(metadata)))).toEqual(filters);
  });

  it("keeps no field at all once there is no filter", () => {
    expect(withTabFilters({ tableName: "t", filters: { columns: { id: { text: "5" } } } }, NO_FILTERS)).toEqual({ tableName: "t" });
    expect(withTabFilters({ tableName: "t" }, { columns: {}, multi: { text: " " } })).toEqual({ tableName: "t" });
    expect(withTabFilters(undefined, NO_FILTERS)).toEqual({});
  });

  it("reads no filters from a tab that kept none, or kept something else there", () => {
    for (const filters of [undefined, null, "id=5", 5, [], [{ text: "x" }]]) expect(readTabFilters({ filters })).toEqual(NO_FILTERS);
    expect(readTabFilters(undefined)).toEqual(NO_FILTERS);
    expect(readTabFilters({ filters: { columns: [{ text: "x" }], multi: "x" } })).toEqual(NO_FILTERS);
  });

  it("drops each filter that is not shaped as one", () => {
    const read = readTabFilters({
      filters: {
        columns: { a: { text: "1" }, b: { text: 5 }, c: "1", d: null, e: { text: "  " }, f: { text: "2", off: "yes" }, g: { text: "3", off: false }, h: { text: "4", off: true }, "": { text: "4" } },
        multi: { text: 7 },
      },
    });
    expect(read).toEqual({ columns: { a: { text: "1" }, f: { text: "2" }, g: { text: "3" }, h: { text: "4", off: true } } });
    expect("off" in read.columns.g!).toBe(false);
  });

  it("reads a column named like one of an object's own properties as that column", () => {
    const read = readTabFilters(JSON.parse('{"filters":{"columns":{"__proto__":{"text":"1"},"constructor":{"text":"2"}}}}'));
    expect(Object.getPrototypeOf(read.columns)).toBe(Object.prototype);
    expect(Object.keys(read.columns)).toEqual(["__proto__", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(read.columns, "__proto__")!.value).toEqual({ text: "1" });
  });

  it("reads no more than a tab is meant to keep", () => {
    const many = Object.fromEntries(Array.from({ length: TAB_FILTER_CAPS.columns + 5 }, (_, i) => [`c${i}`, { text: "1" }]));
    expect(Object.keys(readTabFilters({ filters: { columns: many } }).columns)).toHaveLength(TAB_FILTER_CAPS.columns);
    const longest = "x".repeat(TAB_FILTER_CAPS.text);
    const read = readTabFilters({
      filters: {
        columns: { a: { text: `${longest}x` }, ["n".repeat(TAB_FILTER_CAPS.name + 1)]: { text: "1" }, ["n".repeat(TAB_FILTER_CAPS.name)]: { text: longest } },
        multi: { text: `${longest}x` },
      },
    });
    expect(read).toEqual({ columns: { ["n".repeat(TAB_FILTER_CAPS.name)]: { text: longest } } });
  });
});

describe("linesFilter", () => {
  const lines = "active\n\n  pending  \r\nit's\n";

  it("writes one quoted value per line, each with its own operator", () => {
    expect(linesFilter("is", lines)).toBe("='active',='pending',='it''s'");
    expect(linesFilter("contains", lines)).toBe("'active','pending','it''s'");
    expect(linesFilter("begins", lines)).toBe("^'active',^'pending',^'it''s'");
    expect(linesFilter("ends", lines)).toBe("$'active',$'pending',$'it''s'");
  });

  it("joins 'is not one of' with AND, where OR would keep every row", () => {
    expect(linesFilter("isNot", lines)).toBe("<>'active' <>'pending' <>'it''s'");
  });

  it("is empty when there is no line to filter by", () => {
    expect(linesFilter("is", "\n \n")).toBe("");
  });

  it("is read back as the values it lists", () => {
    const req = filterRequest({ columns: { name: { text: linesFilter("is", lines) } } }, COLUMNS, NOW);
    expect(req.filters).toEqual([{ column: "name", anyOf: [[{ op: "in", values: ["active", "pending", "it's"] }]] }]);
    const not = filterRequest({ columns: { name: { text: linesFilter("isNot", lines) } } }, COLUMNS, NOW);
    expect(not.filters[0]!.anyOf).toEqual([[{ op: "ne", value: "active" }, { op: "ne", value: "pending" }, { op: "ne", value: "it's" }]]);
  });
});
