import { describe, it, expect } from "bun:test";
import {
  applySelection,
  moveCursor,
  typeAheadIndex,
  type SelectionState,
} from "../../../src/web/components/os-explorer/views/use-entry-selection.ts";

const ORDER = ["/a", "/b", "/c", "/d", "/e"];
const state = (paths: string[], anchor: string | null): SelectionState => ({
  selection: new Set(paths),
  anchor,
});
const paths = (s: SelectionState) => [...s.selection].sort();

describe("applySelection — plain click", () => {
  it("selects exactly one row and moves the anchor", () => {
    const next = applySelection(state(["/a", "/b"], "/a"), ORDER, { type: "click", path: "/d" });
    expect(paths(next)).toEqual(["/d"]);
    expect(next.anchor).toBe("/d");
  });
});

describe("applySelection — ctrl click", () => {
  it("adds a row without dropping the rest", () => {
    const next = applySelection(state(["/a"], "/a"), ORDER, { type: "click", path: "/c", ctrl: true });
    expect(paths(next)).toEqual(["/a", "/c"]);
  });

  it("removes an already selected row", () => {
    const next = applySelection(state(["/a", "/c"], "/a"), ORDER, { type: "click", path: "/c", ctrl: true });
    expect(paths(next)).toEqual(["/a"]);
  });

  it("moves the anchor so a following shift click extends from the toggled row", () => {
    const afterCtrl = applySelection(state(["/a"], "/a"), ORDER, { type: "click", path: "/c", ctrl: true });
    expect(afterCtrl.anchor).toBe("/c");
    const afterShift = applySelection(afterCtrl, ORDER, { type: "click", path: "/e", shift: true });
    expect(paths(afterShift)).toEqual(["/c", "/d", "/e"]);
  });
});

describe("applySelection — shift click", () => {
  it("selects the inclusive range from the anchor", () => {
    const next = applySelection(state(["/b"], "/b"), ORDER, { type: "click", path: "/d", shift: true });
    expect(paths(next)).toEqual(["/b", "/c", "/d"]);
  });

  it("works backwards", () => {
    const next = applySelection(state(["/d"], "/d"), ORDER, { type: "click", path: "/b", shift: true });
    expect(paths(next)).toEqual(["/b", "/c", "/d"]);
  });

  it("keeps the anchor so repeated shift clicks resize one range", () => {
    const first = applySelection(state(["/b"], "/b"), ORDER, { type: "click", path: "/e", shift: true });
    expect(first.anchor).toBe("/b");
    const second = applySelection(first, ORDER, { type: "click", path: "/c", shift: true });
    expect(paths(second)).toEqual(["/b", "/c"]);
  });

  it("falls back to a single row when there is no anchor", () => {
    const next = applySelection(state([], null), ORDER, { type: "click", path: "/c", shift: true });
    expect(paths(next)).toEqual(["/c"]);
    expect(next.anchor).toBe("/c");
  });

  it("ignores a row that is no longer visible", () => {
    const next = applySelection(state(["/b"], "/b"), ORDER, { type: "click", path: "/gone", shift: true });
    expect(paths(next)).toEqual([]);
  });
});

describe("applySelection — bulk events", () => {
  it("select-all takes every visible row and keeps the anchor", () => {
    const next = applySelection(state(["/b"], "/b"), ORDER, { type: "select-all" });
    expect(paths(next)).toEqual([...ORDER].sort());
    expect(next.anchor).toBe("/b");
  });

  it("clear empties both selection and anchor", () => {
    const next = applySelection(state(["/b", "/c"], "/b"), ORDER, { type: "clear" });
    expect(paths(next)).toEqual([]);
    expect(next.anchor).toBeNull();
  });

  it("set replaces the selection and anchors on the last path", () => {
    const next = applySelection(state([], null), ORDER, { type: "set", paths: ["/a", "/c"] });
    expect(paths(next)).toEqual(["/a", "/c"]);
    expect(next.anchor).toBe("/c");
  });
});

describe("moveCursor", () => {
  it("steps one row in each direction", () => {
    expect(moveCursor(ORDER, "/b", 1)).toBe("/c");
    expect(moveCursor(ORDER, "/b", -1)).toBe("/a");
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(moveCursor(ORDER, "/a", -1)).toBe("/a");
    expect(moveCursor(ORDER, "/e", 1)).toBe("/e");
  });

  it("enters the list from the matching end when there is no anchor", () => {
    expect(moveCursor(ORDER, null, 1)).toBe("/a");
    expect(moveCursor(ORDER, null, -1)).toBe("/e");
  });

  it("returns null for an empty list", () => {
    expect(moveCursor([], "/a", 1)).toBeNull();
  });
});

describe("typeAheadIndex", () => {
  const names = ["alpha", "Beta", "beacon", "gamma"];

  it("matches a prefix case-insensitively", () => {
    expect(typeAheadIndex(names, "be", -1)).toBe(1);
    expect(typeAheadIndex(names, "BE", -1)).toBe(1);
  });

  it("cycles through matches when searching from the current row", () => {
    expect(typeAheadIndex(names, "b", 1)).toBe(2);
    expect(typeAheadIndex(names, "b", 2)).toBe(1);
  });

  it("returns -1 when nothing matches", () => {
    expect(typeAheadIndex(names, "zz", -1)).toBe(-1);
    expect(typeAheadIndex(names, "", -1)).toBe(-1);
  });
});
