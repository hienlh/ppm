import { describe, expect, it } from "bun:test";
import {
  ColumnMapError, isIdentity, mapColumns, pickRow, uniqueColumnNames,
} from "../../../../src/services/database/impexp/column-map.ts";

describe("mapColumns", () => {
  const source = ["id", "name", "email"];

  it("copies every column as it is when nothing is mapped", () => {
    expect(mapColumns(source, undefined, "t")).toEqual({ indexes: [0, 1, 2], names: ["id", "name", "email"] });
    expect(mapColumns(source, [], "t")).toEqual({ indexes: [0, 1, 2], names: ["id", "name", "email"] });
  });

  it("writes the mapped columns in the mapping's order, under their target names, leaving out the unused", () => {
    const mapped = mapColumns(source, [
      { src: "email", dst: "mail" },
      { src: "name", dst: "name", skip: true },
      { src: "id", dst: "user_id" },
    ], "t");
    expect(mapped).toEqual({ indexes: [2, 0], names: ["mail", "user_id"] });
  });

  it("may write one source column twice, under two names", () => {
    expect(mapColumns(source, [{ src: "id", dst: "a" }, { src: "id", dst: "b" }], "t")).toEqual({ indexes: [0, 0], names: ["a", "b"] });
  });

  it("refuses a source column the source does not have, naming the source", () => {
    expect(() => mapColumns(source, [{ src: "phone", dst: "phone" }], `"users"`)).toThrow(new ColumnMapError(`Column "phone" is not in "users"`));
  });

  it("refuses what Configure columns would not let through", () => {
    expect(() => mapColumns(source, [{ src: "id", dst: "" }], "t")).toThrow("Source and target columns must be defined");
    expect(() => mapColumns(source, [{ src: "id", dst: "x" }, { src: "name", dst: "x" }], "t"))
      .toThrow("Target columns must be unique, duplicates found: x");
    expect(() => mapColumns(source, [{ src: "id", dst: "id", skip: true }], "t")).toThrow(ColumnMapError);
  });

  it("does not check a column that is not used", () => {
    expect(mapColumns(source, [{ src: "", dst: "", skip: true }, { src: "id", dst: "id" }], "t")).toEqual({ indexes: [0], names: ["id"] });
  });
});

describe("isIdentity", () => {
  it("is true only for every column, in order", () => {
    expect(isIdentity({ indexes: [0, 1], names: ["a", "b"] }, 2)).toBe(true);
    expect(isIdentity({ indexes: [1, 0], names: ["b", "a"] }, 2)).toBe(false);
    expect(isIdentity({ indexes: [0], names: ["a"] }, 2)).toBe(false);
    expect(isIdentity({ indexes: [0, 1, 1], names: ["a", "b", "c"] }, 2)).toBe(false);
  });

  it("is true for renamed columns: a row's values do not change with their names", () => {
    expect(isIdentity({ indexes: [0, 1], names: ["x", "y"] }, 2)).toBe(true);
  });
});

describe("pickRow", () => {
  it("takes the values the indexes name, in their order", () => {
    expect(pickRow([10, 20, 30], [2, 0, 0])).toEqual([30, 10, 10]);
  });
});

describe("uniqueColumnNames", () => {
  it("leaves names that differ as they are", () => {
    expect(uniqueColumnNames(["id", "Id", "name"])).toEqual(["id", "Id", "name"]);
  });

  it("numbers a repeated name, past any number already taken", () => {
    expect(uniqueColumnNames(["id", "id", "id"])).toEqual(["id", "id_1", "id_2"]);
    expect(uniqueColumnNames(["id", "id_1", "id"])).toEqual(["id", "id_1", "id_2"]);
  });

  it("names an empty column by its place", () => {
    expect(uniqueColumnNames(["a", "", "col2"])).toEqual(["a", "col2", "col2_1"]);
  });
});
