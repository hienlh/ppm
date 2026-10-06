/**
 * DBGate's References as data: which tables a table's keys point at and which point at it, how the
 * list is searched and named, what the table shown under the grid is filtered by for the rows
 * selected above it, the filter the form button on a key cell opens the referenced table on, the
 * unsaved rows of a tab's two grids, and where the form button sits in its cell and how it is drawn.
 */
import { describe, expect, it } from "bun:test";
import type { DbForeignKey } from "../../../src/shared/db-structure";
import type { ColumnKind } from "../../../src/shared/db-column-kind";
import {
  detailKeyFilters, hasReferences, referenceId, referenceJoin, referencesMatching, tableReferences,
} from "../../../src/web/components/database/grid/references";
import { referencedRowFilters } from "../../../src/web/components/database/grid/reference-filter";
import {
  setUnsavedGridRows, slotUnsavedRows, tabUnsavedRows, unsavedGridRows, useUnsavedGridRows,
} from "../../../src/web/stores/unsaved-grid-rows-store";

const fk = (over: Partial<DbForeignKey>): DbForeignKey => ({
  name: "fk", schema: "shop", table: "orders", columns: ["user_id"], refSchema: "shop", refTable: "users", refColumns: ["id"],
  onDelete: "NO ACTION", onUpdate: "NO ACTION", ...over,
});

// users: referenced by orders.user_id and by users.invited_by (a key on itself); holds team_id → teams.
const USERS = {
  foreignKeys: [
    fk({ name: "users_team", table: "users", columns: ["team_id"], refTable: "teams", refColumns: ["id"] }),
    fk({ name: "users_inviter", table: "users", columns: ["invited_by"], refTable: "users", refColumns: ["id"] }),
  ],
  references: [
    fk({ name: "orders_user", table: "orders", columns: ["user_id"] }),
    fk({ name: "users_inviter", table: "users", columns: ["invited_by"] }),
  ],
};

const kinds = (map: Record<string, ColumnKind>) => (column: string) => map[column] ?? "text";

describe("a table's references", () => {
  it("lists the keys it holds as References tables and the keys pointing at it as Dependent tables", () => {
    const refs = tableReferences(USERS);
    expect(refs.out.map((r) => `${r.table} (${r.keyColumns.join(", ")})`)).toEqual(["teams (team_id)", "users (invited_by)"]);
    expect(refs.in.map((r) => `${r.table} (${r.keyColumns.join(", ")})`)).toEqual(["orders (user_id)", "users (invited_by)"]);
  });

  it("pairs each column of the table shown below with the master's column it holds the value of", () => {
    const refs = tableReferences(USERS);
    // A key this table holds: the table below is the one it points at, matched on what it points at.
    expect(refs.out[0]).toEqual({
      direction: "out", schema: "shop", table: "teams", name: "users_team", keyColumns: ["team_id"],
      columns: [{ detail: "id", master: "team_id" }],
    });
    // A key another table holds: the table below is that one, matched on its key.
    expect(refs.in[0]).toEqual({
      direction: "in", schema: "shop", table: "orders", name: "orders_user", keyColumns: ["user_id"],
      columns: [{ detail: "user_id", master: "id" }],
    });
  });

  it("takes the schema of the table it shows: the referenced table's, or the key's own", () => {
    const refs = tableReferences({
      foreignKeys: [fk({ table: "users", schema: "a", columns: ["team_id"], refSchema: "b", refTable: "teams" })],
      references: [fk({ table: "orders", schema: "c", refSchema: "a" })],
    });
    expect([refs.out[0]!.schema, refs.in[0]!.schema]).toEqual(["b", "c"]);
  });

  it("leaves out a key whose columns do not pair up, which could filter nothing", () => {
    const refs = tableReferences({
      foreignKeys: [fk({ columns: ["a", "b"], refColumns: ["x"] }), fk({ columns: [], refColumns: [] })],
      references: [fk({ columns: ["a"], refColumns: ["x", "y"] })],
    });
    expect([refs.out.length, refs.in.length]).toEqual([0, 0]);
    expect(hasReferences(refs)).toBe(false);
  });

  it("has references once either list holds one", () => {
    expect(hasReferences(null)).toBe(false);
    expect(hasReferences({ out: [], in: [] })).toBe(false);
    expect(hasReferences(tableReferences({ foreignKeys: [], references: [fk({})] }))).toBe(true);
    expect(hasReferences(tableReferences({ foreignKeys: [fk({})], references: [] }))).toBe(true);
  });

  it("tells apart a key on itself seen both ways, and two keys between the same tables", () => {
    const refs = tableReferences(USERS);
    const ids = [...refs.out, ...refs.in].map(referenceId);
    expect(new Set(ids).size).toBe(4);
    const twice = tableReferences({
      foreignKeys: [],
      references: [fk({ name: "orders_buyer", columns: ["buyer_id"] }), fk({ name: "orders_seller", columns: ["seller_id"] })],
    });
    expect(referenceId(twice.in[0]!)).not.toBe(referenceId(twice.in[1]!));
    // Two keys on the same columns are told apart by their names alone.
    const again = tableReferences({
      foreignKeys: [],
      references: [fk({ name: "orders_user" }), fk({ name: "orders_user_again" })],
    });
    expect(referenceId(again.in[0]!)).not.toBe(referenceId(again.in[1]!));
    // Unnamed keys (SQLite's) are told apart by their columns.
    const unnamed = tableReferences({
      foreignKeys: [],
      references: [fk({ name: null, columns: ["buyer_id"] }), fk({ name: null, columns: ["seller_id"] })],
    });
    expect(referenceId(unnamed.in[0]!)).not.toBe(referenceId(unnamed.in[1]!));
    // And by what each column joins: one unnamed column referencing two keys of the same table.
    const twoKeys = tableReferences({
      foreignKeys: [],
      references: [fk({ name: null, refColumns: ["id"] }), fk({ name: null, refColumns: ["legacy_id"] })],
    });
    expect(referenceId(twoKeys.in[0]!)).not.toBe(referenceId(twoKeys.in[1]!));
    // And a schema is part of the table it names.
    const schemas = tableReferences({ foreignKeys: [], references: [fk({ schema: "a" }), fk({ schema: "b" })] });
    expect(referenceId(schemas.in[0]!)).not.toBe(referenceId(schemas.in[1]!));
  });

  it("is the same reference however often its structure is read", () => {
    expect(referenceId(tableReferences(USERS).in[0]!)).toBe(referenceId(tableReferences(USERS).in[0]!));
  });
});

describe("searching the references", () => {
  const refs = tableReferences(USERS);
  const names = (r: ReturnType<typeof referencesMatching>) => [r.out.map((x) => x.table), r.in.map((x) => x.table)];

  it("keeps those whose table or key columns contain the text, in either list", () => {
    expect(names(referencesMatching(refs, "ord"))).toEqual([[], ["orders"]]);
    expect(names(referencesMatching(refs, "invited"))).toEqual([["users"], ["users"]]);
    expect(names(referencesMatching(refs, "team_id"))).toEqual([["teams"], []]);
  });

  it("ignores case and the spaces around the text", () => {
    expect(names(referencesMatching(refs, "  TEAMS "))).toEqual([["teams"], []]);
    // The table's name and its key's columns as the catalog spells them, not only lower case.
    const camel = tableReferences({ foreignKeys: [], references: [fk({ table: "OrderItems", columns: ["UserId"] })] });
    expect(referencesMatching(camel, "items").in.length).toBe(1);
    expect(referencesMatching(camel, "userid").in.length).toBe(1);
  });

  it("keeps every one for no text, and none for text nothing contains", () => {
    expect(referencesMatching(refs, "   ")).toBe(refs);
    expect(names(referencesMatching(refs, "zzz"))).toEqual([[], []]);
  });

  it("matches a key's columns as the list shows them, with their comma", () => {
    const pair = tableReferences({ foreignKeys: [], references: [fk({ columns: ["a", "b"], refColumns: ["x", "y"] })] });
    expect(referencesMatching(pair, "a, b").in.length).toBe(1);
    expect(referencesMatching(pair, "b, a").in.length).toBe(0);
  });
});

describe("the header of the table shown under the grid", () => {
  it("reads the join out, the table below first", () => {
    expect(referenceJoin(tableReferences(USERS).in[0]!)).toEqual({ table: "orders", detail: "user_id", master: "id" });
    const pair = tableReferences({ foreignKeys: [fk({ table: "lines", columns: ["a", "b"], refTable: "heads", refColumns: ["x", "y"] })], references: [] });
    expect(referenceJoin(pair.out[0]!)).toEqual({ table: "heads", detail: "x, y", master: "a, b" });
  });
});

describe("what the table under the grid is filtered by", () => {
  const orders = tableReferences(USERS).in[0]!;
  const number = kinds({ user_id: "number" });

  it("holds the selected row's key", () => {
    expect(detailKeyFilters(orders, [{ id: 11, name: "User 11" }], number)).toEqual([
      { column: "user_id", anyOf: [[{ op: "eq", value: 11 }]] },
    ]);
  });

  it("holds every selected row's key, each once", () => {
    expect(detailKeyFilters(orders, [{ id: 5 }, { id: 7 }, { id: 5 }], number)).toEqual([
      { column: "user_id", anyOf: [[{ op: "in", values: [5, 7] }]] },
    ]);
  });

  it("is written in the key column's own syntax: a text key compares text", () => {
    const byCode = tableReferences({ foreignKeys: [], references: [fk({ columns: ["code"], refColumns: ["code"] })] }).in[0]!;
    expect(detailKeyFilters(byCode, [{ code: "A-1" }], kinds({ code: "text" }))).toEqual([
      { column: "code", anyOf: [[{ op: "eq", value: "A-1" }]] },
    ]);
  });

  it("is nothing for no selected row, a NULL key, or bytes: no row below belongs to those", () => {
    expect(detailKeyFilters(orders, [], number)).toBeNull();
    expect(detailKeyFilters(orders, [{ id: null }], number)).toBeNull();
    expect(detailKeyFilters(orders, [{ name: "a row read without its key" }], number)).toBeNull();
    expect(detailKeyFilters(orders, [{ id: { $binary: "AQ==", size: 1 } }], number)).toBeNull();
  });

  it("leaves out a NULL key among others", () => {
    expect(detailKeyFilters(orders, [{ id: 3 }, { id: null }], number)).toEqual([
      { column: "user_id", anyOf: [[{ op: "eq", value: 3 }]] },
    ]);
  });

  it("filters a key of several columns column by column, and is nothing when one of them has no value", () => {
    const heads = tableReferences({ foreignKeys: [fk({ table: "lines", columns: ["a", "b"], refTable: "heads", refColumns: ["x", "y"] })], references: [] }).out[0]!;
    const of = kinds({ x: "number", y: "text" });
    expect(detailKeyFilters(heads, [{ a: 1, b: "q" }], of)).toEqual([
      { column: "x", anyOf: [[{ op: "eq", value: 1 }]] },
      { column: "y", anyOf: [[{ op: "eq", value: "q" }]] },
    ]);
    expect(detailKeyFilters(heads, [{ a: 1, b: null }], of)).toBeNull();
  });
});

describe("the form button on a foreign key cell", () => {
  it("opens the referenced table on its key equal to the value, as ⋮ writes a picked one", () => {
    expect(referencedRowFilters("id", "number", 11)).toEqual({ columns: { id: { text: '="11"' } } });
    expect(referencedRowFilters("code", "text", 'ab"c')).toEqual({ columns: { code: { text: '="ab""c"' } } });
  });

  it("opens nothing for a key that refers to no row", () => {
    expect(referencedRowFilters("id", "number", null)).toBeNull();
    expect(referencedRowFilters("id", "number", undefined)).toBeNull();
    expect(referencedRowFilters("id", "binary", { $binary: "AQ==", size: 1 })).toBeNull();
  });
});

describe("a tab's unsaved rows, from each of its grids", () => {
  it("adds up the table's and the reference's under it, and no other tab's", () => {
    useUnsavedGridRows.setState({}, true);
    setUnsavedGridRows("t1", 2);
    setUnsavedGridRows("t1", 3, "detail");
    // A tab whose id begins with this one's is another tab.
    setUnsavedGridRows("t10", 5);
    setUnsavedGridRows("t10", 7, "detail");
    expect(unsavedGridRows("t1")).toBe(5);
    expect(unsavedGridRows("t10")).toBe(12);
    expect(tabUnsavedRows(useUnsavedGridRows.getState(), "t1")).toBe(5);
    expect([slotUnsavedRows("t1"), slotUnsavedRows("t1", "detail"), slotUnsavedRows("t1", "other")]).toEqual([2, 3, 0]);
  });

  it("forgets a grid that has none left, leaving the other's", () => {
    useUnsavedGridRows.setState({}, true);
    setUnsavedGridRows("t1", 2);
    setUnsavedGridRows("t1", 3, "detail");
    setUnsavedGridRows("t1", 0, "detail");
    expect(Object.keys(useUnsavedGridRows.getState())).toEqual(["t1"]);
    expect(unsavedGridRows("t1")).toBe(2);
    setUnsavedGridRows("t1", 0);
    expect(useUnsavedGridRows.getState()).toEqual({});
  });

  it("changes nothing when the count is the same", () => {
    useUnsavedGridRows.setState({}, true);
    setUnsavedGridRows("t1", 3, "detail");
    const before = useUnsavedGridRows.getState();
    setUnsavedGridRows("t1", 3, "detail");
    expect(useUnsavedGridRows.getState()).toBe(before);
  });
});

// ── Where the button sits, and how it is drawn ──

class FakePath { constructor(readonly d: string) {} }
(globalThis as { Path2D?: unknown }).Path2D ??= FakePath;
const { FK_BUTTON_ROOM, drawBesideFkButton, drawFkButton, isOnFkButton } = await import("../../../src/web/components/database/grid/fk-cell-button");

/** A canvas context that writes down what is done to it. */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: "", globalAlpha: 1,
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    rect: (x: number, y: number, w: number, h: number) => calls.push(`rect ${x},${y},${w},${h}`),
    clip: () => calls.push("clip"),
    translate: (x: number, y: number) => calls.push(`translate ${x},${y}`),
    scale: (x: number, y: number) => calls.push(`scale ${x},${y}`),
    roundRect: (x: number, y: number, w: number, h: number, r: number) => calls.push(`roundRect ${x},${y},${w},${h},${r}`),
    fill: (path?: unknown) => calls.push(`fill${path ? " glyph" : ""} ${ctx.fillStyle} @${ctx.globalAlpha}`),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
const THEME = { textLight: "subtle", accentColor: "primary", accentLight: "wash" };
const CELL = { x: 100, y: 40, width: 120, height: 34 };

describe("where the form button sits in its cell", () => {
  it("is 20px square, 3px in from the right edge, centred top to bottom", () => {
    const cell = { width: 120, height: 34 };
    expect(isOnFkButton(97, 7, cell)).toBe(true);
    expect(isOnFkButton(116.9, 26.9, cell)).toBe(true);
    expect(isOnFkButton(96.9, 15, cell)).toBe(false);
    expect(isOnFkButton(117, 15, cell)).toBe(false);
    expect(isOnFkButton(105, 6.9, cell)).toBe(false);
    expect(isOnFkButton(105, 27, cell)).toBe(false);
  });

  it("keeps its room free of the cell's text", () => {
    expect(FK_BUTTON_ROOM).toBe(27);
  });
});

describe("drawing a foreign key cell", () => {
  it("cuts the cell's own content off where the button's room begins", () => {
    const { ctx, calls } = recorder();
    let drawn = 0;
    drawBesideFkButton(ctx, CELL, { right: false, padding: 8 }, () => { drawn++; calls.push("content"); });
    expect(drawn).toBe(1);
    expect(calls).toEqual(["save", "beginPath", "rect 100,40,93,34", "clip", "content", "restore"]);
  });

  it("ends right-aligned content where the button begins, past the padding the cell keeps anyway", () => {
    const { ctx, calls } = recorder();
    drawBesideFkButton(ctx, CELL, { right: true, padding: 8 }, () => calls.push("content"));
    expect(calls).toEqual(["save", "beginPath", "rect 100,40,93,34", "clip", "translate -19,0", "content", "restore"]);
  });

  it("draws the button faint until its cell is hovered or holds the cursor", () => {
    const faint = recorder();
    drawFkButton(faint.ctx, CELL, "faint", THEME);
    expect(faint.calls.filter((c) => c.startsWith("fill"))).not.toHaveLength(0);
    expect(faint.calls.every((c) => !c.startsWith("roundRect"))).toBe(true);
    expect(new Set(faint.calls.filter((c) => c.startsWith("fill")))).toEqual(new Set(["fill glyph subtle @0.35"]));

    const shown = recorder();
    drawFkButton(shown.ctx, CELL, "shown", THEME);
    expect(new Set(shown.calls.filter((c) => c.startsWith("fill")))).toEqual(new Set(["fill glyph subtle @1"]));
  });

  it("lights it under the pointer: a wash behind it, the glyph in the accent", () => {
    const { ctx, calls } = recorder();
    drawFkButton(ctx, CELL, "hover", THEME);
    expect(calls.slice(0, 4)).toEqual(["save", "beginPath", "roundRect 197,47,20,20,4", "fill wash @1"]);
    expect(new Set(calls.filter((c) => c.startsWith("fill glyph")))).toEqual(new Set(["fill glyph primary @1"]));
  });

  it("draws the 20px form glyph at 14px, centred in the button, and leaves the context as it found it", () => {
    const { ctx, calls } = recorder();
    drawFkButton(ctx, CELL, "faint", THEME);
    expect(calls).toContain("translate 200,50");
    expect(calls).toContain("scale 0.7,0.7");
    expect(calls[0]).toBe("save");
    expect(calls.at(-1)).toBe("restore");
  });
});
