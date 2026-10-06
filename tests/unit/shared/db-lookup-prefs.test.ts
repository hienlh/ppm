/**
 * The Description each table's ⋯ Lookup was customized to: kept within bounds the server checks,
 * the most recent choices winning when there are too many.
 */
import { describe, expect, it } from "bun:test";
import {
  DB_LOOKUP_CAPS, isLookupDescriptions, sanitizeLookupDescriptions, withLookupDescription,
} from "../../../src/shared/db-lookup-prefs";

const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, "name"]));

describe("lookup descriptions", () => {
  it("keeps what is well formed and drops the rest", () => {
    expect(sanitizeLookupDescriptions({
      ok: "name", empty: "", number: 3, long: "x".repeat(DB_LOOKUP_CAPS.column + 1), "": "name", edge: "x".repeat(DB_LOOKUP_CAPS.column),
    })).toEqual({ ok: "name", edge: "x".repeat(DB_LOOKUP_CAPS.column) });
    expect(sanitizeLookupDescriptions({ ["k".repeat(DB_LOOKUP_CAPS.key + 1)]: "name", ["k".repeat(DB_LOOKUP_CAPS.key)]: "name" }))
      .toEqual({ ["k".repeat(DB_LOOKUP_CAPS.key)]: "name" });
    for (const bad of [null, undefined, "name", 3, ["name"]]) expect(sanitizeLookupDescriptions(bad)).toBeNull();
  });

  it("keeps the most recent tables when there are too many", () => {
    const kept = sanitizeLookupDescriptions(many(DB_LOOKUP_CAPS.tables + 2))!;
    expect(Object.keys(kept).length).toBe(DB_LOOKUP_CAPS.tables);
    expect(kept.t0).toBeUndefined();
    expect(kept.t1).toBeUndefined();
    expect(kept[`t${DB_LOOKUP_CAPS.tables + 1}`]).toBe("name");
  });

  it("moves a table chosen again to the end, so a full copy keeps it", () => {
    const full = many(DB_LOOKUP_CAPS.tables);
    const next = withLookupDescription(full, "t0", "code");
    expect(Object.keys(next).at(-1)).toBe("t0");
    expect(next.t0).toBe("code");
    const added = withLookupDescription(next, "new", "title");
    expect(Object.keys(added).length).toBe(DB_LOOKUP_CAPS.tables);
    expect(added.t0).toBe("code");
    expect(added.t1).toBeUndefined();
    expect(added.new).toBe("title");
  });

  it("is checked on the server against the same bounds", () => {
    expect(isLookupDescriptions({ "1:shop:public:plans": "name" })).toBe(true);
    expect(isLookupDescriptions({})).toBe(true);
    expect(isLookupDescriptions(many(DB_LOOKUP_CAPS.tables))).toBe(true);
    expect(isLookupDescriptions(many(DB_LOOKUP_CAPS.tables + 1))).toBe(false);
    for (const bad of [null, [], "name", { t: "" }, { t: 1 }, { t: "x".repeat(DB_LOOKUP_CAPS.column + 1) }, { ["k".repeat(DB_LOOKUP_CAPS.key + 1)]: "name" }]) {
      expect(isLookupDescriptions(bad)).toBe(false);
    }
  });
});
