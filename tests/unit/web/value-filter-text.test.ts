/**
 * ⋮ and ⋯ write the values picked as filter text each column reads back as exactly those values,
 * and ask the server for the right rows: the values under every other filter, the lookup's rows
 * by key, searched in the key and the description.
 */
import { describe, expect, it } from "bun:test";
import {
  canChooseValues, descriptionColumn, lookupRowsRequest, lookupSearch, pickedValuesFilter, valueKey, valuesRequest,
} from "../../../src/web/components/database/grid/value-filter-text.ts";
import { parseFilter } from "../../../src/shared/db-filter-parser.ts";
import type { ColumnKind } from "../../../src/shared/db-column-kind.ts";

const read = (text: string, kind: ColumnKind) => {
  const r = parseFilter(text, kind);
  if (!r.ok) throw new Error(`${text}: ${r.error.message}`);
  return r.anyOf;
};

describe("the text a pick writes", () => {
  it("gives every value its own =, joined with commas, and reads back as those values", () => {
    const text = pickedValuesFilter("text", ["active", "pending"]);
    expect(text).toBe('="active",="pending"');
    expect(read(text, "text")).toEqual([[{ op: "in", values: ["active", "pending"] }]]);
  });

  it("keeps a quote, a comma and a space inside the value", () => {
    const text = pickedValuesFilter("text", ['say "hi", ok']);
    expect(text).toBe('="say ""hi"", ok"');
    expect(read(text, "text")).toEqual([[{ op: "eq", value: 'say "hi", ok' }]]);
  });

  it("writes NULL bare, and numbers as the column reads them", () => {
    expect(pickedValuesFilter("number", [null, 5, 0.125, "12345678901234567890"])).toBe('NULL,="5",="0.125",="12345678901234567890"');
    expect(read(pickedValuesFilter("number", [5, 0.125, "12345678901234567890"]), "number")).toEqual([
      [{ op: "in", values: [5, 0.125, "12345678901234567890"] }],
    ]);
    expect(read(pickedValuesFilter("text", [null, "a"]), "text")).toEqual([[{ op: "isNull" }], [{ op: "eq", value: "a" }]]);
  });

  it("writes TRUE and FALSE for a boolean column, whatever the engine sent", () => {
    expect(pickedValuesFilter("boolean", [true, false, 1, 0, "t", "f"])).toBe("TRUE,FALSE,TRUE,FALSE,TRUE,FALSE");
    // A value no boolean reads is kept, and the box says why.
    expect(pickedValuesFilter("boolean", [2])).toBe('="2"');
    expect(parseFilter('="2"', "boolean").ok).toBe(false);
  });

  it("matches a date to the second it names, and an instant in its own zone", () => {
    expect(read(pickedValuesFilter("datetime", ["2026-09-02 10:01:00"]), "datetime")).toEqual([
      [{ op: "dateRange", from: "2026-09-02 10:01:00", to: "2026-09-02 10:01:01", offset: expect.any(String) }],
    ]);
    expect(read(pickedValuesFilter("datetimetz", ["2026-09-02 10:01:00+07"]), "datetimetz")).toEqual([
      [{ op: "dateRange", from: "2026-09-02 03:01:00", to: "2026-09-02 03:01:01", offset: "+00:00" }],
    ]);
    expect(read(pickedValuesFilter("date", ["2026-09-02"]), "date")).toEqual([
      [{ op: "dateRange", from: "2026-09-02 00:00:00", to: "2026-09-03 00:00:00", offset: expect.any(String) }],
    ]);
  });

  it("writes nothing for nothing picked", () => {
    expect(pickedValuesFilter("text", [])).toBe("");
  });

  it("is not offered where a picked value could only fail", () => {
    expect((["binary", "json"] as ColumnKind[]).map(canChooseValues)).toEqual([false, false]);
    expect((["text", "number", "boolean", "date", "datetime", "datetimetz", "time", "other"] as ColumnKind[]).every(canChooseValues)).toBe(true);
  });

  it("tells values apart as DISTINCT does", () => {
    expect(new Set([null, "null", 1, "1", true, "true"].map(valueKey)).size).toBe(6);
    expect(valueKey({ a: 1 })).toBe(valueKey({ a: 1 }));
  });
});

describe("what ⋮ asks for", () => {
  const columns = [{ name: "status", kind: "text" as const }, { name: "qty", kind: "number" as const }];

  it("lists the column's values under every filter in force but its own", () => {
    const filters = { columns: { status: { text: "=active" }, qty: { text: ">5" } }, multi: { text: "x" } };
    expect(valuesRequest({ table: "orders", schema: "public" }, "status", "  pa ", filters, columns)).toEqual({
      table: "orders", schema: "public", column: "status", search: "pa",
      filters: [{ column: "qty", anyOf: [[{ op: "gt", value: 5 }]] }],
      anyColumn: [{ column: "status", anyOf: [[{ op: "contains", value: "x" }]] }],
    });
  });

  it("leaves out a filter switched off, as the grid does", () => {
    const filters = { columns: { qty: { text: ">5", off: true } } };
    expect(valuesRequest({ table: "orders" }, "status", "", filters, columns)).toMatchObject({ filters: [], anyColumn: [] });
  });
});

describe("what ⋯ asks for", () => {
  const plans = [{ name: "id", kind: "number" as const }, { name: "code", kind: "text" as const }, { name: "name", kind: "text" as const }];

  it("reads the referenced table's first rows by key", () => {
    expect(lookupRowsRequest({ table: "plans", schema: "public" }, "id", [])).toEqual({
      table: "plans", schema: "public", anyColumn: [], sort: [{ column: "id", dir: "ASC" }], offset: 0, limit: 100,
    });
  });

  it("searches the key and the description for the text as typed", () => {
    const searched = [plans[0]!, plans[2]!];
    expect(lookupSearch("  ", searched)).toEqual([]);
    expect(lookupSearch("pro", searched)).toEqual([{ column: "name", anyOf: [[{ op: "contains", value: "pro" }]] }]);
    expect(lookupSearch("2", searched)).toEqual([
      { column: "id", anyOf: [[{ op: "eq", value: 2 }]] },
      { column: "name", anyOf: [[{ op: "contains", value: "2" }]] },
    ]);
    // A comma or a quote is part of what is searched for, not filter syntax.
    expect(lookupSearch('a, "b', searched)).toEqual([{ column: "name", anyOf: [[{ op: "contains", value: 'a, "b' }]] }]);
    expect(lookupSearch("abc", [plans[0]!])).toBeNull();
  });

  it("describes a row by the first text column besides the key, unless another was chosen", () => {
    expect(descriptionColumn(plans, "id", null)).toBe("code");
    expect(descriptionColumn(plans, "code", null)).toBe("name");
    expect(descriptionColumn(plans, "id", "name")).toBe("name");
    // A choice the table no longer has, or the key itself, falls back.
    expect(descriptionColumn(plans, "id", "gone")).toBe("code");
    expect(descriptionColumn(plans, "id", "id")).toBe("code");
    expect(descriptionColumn([plans[0]!], "id", null)).toBeNull();
  });
});
