/**
 * A foreign key followed by its values: the filter that shows exactly the rows they name, as ⊞ in
 * the form and the form button on a key read the referenced row — written as ⋮ writes a picked
 * value and read back in the column's own syntax, so no raw value reaches the server unparsed.
 */
import { describe, expect, it } from "bun:test";
import { keyValues, keyValuesFilter } from "../../../src/web/components/database/grid/reference-filter";

const bytes = { $binary: "AAEC", size: 3 };

describe("the values a key is filtered by", () => {
  it("keeps each value once, in the order met", () => {
    expect(keyValues([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });

  it("leaves out NULL, which refers to nothing, and bytes, which no filter can spell", () => {
    expect(keyValues([null, 5, undefined, bytes, 6])).toEqual([5, 6]);
    expect(keyValues([null, undefined, bytes])).toEqual([]);
  });

  it("tells 1 from \"1\", as SQLite keeps both", () => {
    expect(keyValues([1, "1", 1])).toEqual([1, "1"]);
  });
});

describe("the filter on the referenced table", () => {
  it("compares a number key as a number", () => {
    expect(keyValuesFilter("user_id", "number", [11])).toEqual({
      text: '="11"', group: { column: "user_id", anyOf: [[{ op: "eq", value: 11 }]] },
    });
  });

  it("takes several values as one IN, each once and no NULL", () => {
    expect(keyValuesFilter("user_id", "number", [11, 12, 11, null])).toEqual({
      text: '="11",="12"', group: { column: "user_id", anyOf: [[{ op: "in", values: [11, 12] }]] },
    });
  });

  it("keeps every digit of a key too large for a JavaScript number", () => {
    expect(keyValuesFilter("id", "number", ["9007199254740993"])?.group).toEqual({
      column: "id", anyOf: [[{ op: "eq", value: "9007199254740993" }]],
    });
  });

  it("quotes text the way the filter reads it back, a quote inside doubled", () => {
    expect(keyValuesFilter("code", "text", ['a"b', "x"])).toEqual({
      text: '="a""b",="x"', group: { column: "code", anyOf: [[{ op: "in", values: ['a"b', "x"] }]] },
    });
    expect(keyValuesFilter("id", "other", ["5f0c-uuid"])?.group.anyOf).toEqual([[{ op: "eq", value: "5f0c-uuid" }]]);
  });

  it("is nothing when no value can be filtered by", () => {
    expect(keyValuesFilter("user_id", "number", [null])).toBeNull();
    expect(keyValuesFilter("user_id", "number", [])).toBeNull();
    expect(keyValuesFilter("photo_id", "number", [bytes])).toBeNull();
  });

  it("is nothing when the column's syntax cannot read the value", () => {
    // A number column cannot be compared with text that is not a number.
    expect(keyValuesFilter("user_id", "number", ["abc"])).toBeNull();
  });
});
