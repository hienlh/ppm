/**
 * The Structure tab's unsaved changes live in the tab's metadata. What decides the unsaved dot and
 * the close prompt is here: a change starts from the table as the database has it, a change that
 * brings the table back to where it started ends the edit, and a table not created yet stays an
 * edit however close to its start it is — it has nowhere else to live.
 */
import { describe, expect, test } from "bun:test";
import {
  isStructureTabDirty, newTableTabMetadata, nextTableEdit, nextTableNumber, readTableEdit, resetTableEdit, TABLE_EDIT_FIELD, withTableEdit,
  type TableEdit,
} from "../../../src/web/lib/db-table-edit";
import { columnById, modelFromStructure, newTableModel, upsertColumn, type TableModel } from "../../../src/shared/db-table-model";
import type { DbTableStructure } from "../../../src/shared/db-structure";

const live: DbTableStructure = {
  schema: null, name: "notes", kind: "table",
  columns: [
    { name: "id", type: "INTEGER", nullable: false, defaultValue: null, comment: null, autoIncrement: false, generated: false, computedExpression: null },
    { name: "body", type: "TEXT", nullable: true, defaultValue: null, comment: null, autoIncrement: false, generated: false, computedExpression: null },
  ],
  primaryKey: { name: null, columns: ["id"] },
  foreignKeys: [], references: [], indexes: [], uniques: [], checks: [], comment: null,
  rowKey: ["id"], rowKeyIsRowid: false,
};

const liveModel = modelFromStructure(live, "sqlite");
const bodyId = liveModel.columns[1]!.id;
const setBodyNotNull = (notNull: boolean) => (m: TableModel) => upsertColumn(m, { ...columnById(m, bodyId)!, notNull });

describe("nextTableEdit", () => {
  test("the first change starts from the table as the database has it", () => {
    const edit = nextTableEdit(null, live, "sqlite", setBodyNotNull(true));
    expect(edit?.base).toEqual(liveModel);
    expect(columnById(edit!.current, bodyId)?.notNull).toBe(true);
    expect(edit?.isNew).toBeUndefined();
  });

  test("a later change builds on the edit, not on the live table", () => {
    const first = nextTableEdit(null, live, "sqlite", setBodyNotNull(true));
    const second = nextTableEdit(first, live, "sqlite", (m) => ({ ...m, comment: "x" }));
    expect(second?.base).toEqual(liveModel);
    expect(second?.current.comment).toBe("x");
    expect(columnById(second!.current, bodyId)?.notNull).toBe(true);
  });

  test("changing an existing table back to where it started ends the edit", () => {
    const first = nextTableEdit(null, live, "sqlite", setBodyNotNull(true));
    expect(nextTableEdit(first, live, "sqlite", setBodyNotNull(false))).toBeNull();
  });

  test("a new table stays an edit even when it is back where New table started it", () => {
    const start = readTableEdit(newTableTabMetadata(newTableModel(null), 1, "a"))!;
    const renamed = nextTableEdit(start, null, "sqlite", (m) => ({ ...m, name: "t" }));
    const back = nextTableEdit(renamed, null, "sqlite", (m) => ({ ...m, name: "new_table" }));
    expect(back).toEqual(start);
  });

  test("with nothing read yet, there is nothing to change", () => {
    expect(nextTableEdit(null, null, "sqlite", setBodyNotNull(true))).toBeNull();
  });
});

describe("what the tab keeps", () => {
  const edit = nextTableEdit(null, live, "sqlite", setBodyNotNull(true))!;

  test("an edit goes in under its own field, and none takes the field away with everything else kept", () => {
    const meta = withTableEdit({ connectionId: 3, tableName: "notes" }, edit);
    expect(meta).toEqual({ connectionId: 3, tableName: "notes", [TABLE_EDIT_FIELD]: edit });
    expect(withTableEdit(meta, null)).toEqual({ connectionId: 3, tableName: "notes" });
    expect(withTableEdit(undefined, null)).toEqual({});
  });

  test("an edit reads back as it went in", () => {
    expect(readTableEdit(withTableEdit({}, edit))).toEqual(edit);
  });

  test("what an older or damaged tab holds instead is dropped, not drawn", () => {
    expect(readTableEdit(undefined)).toBeNull();
    expect(readTableEdit({ [TABLE_EDIT_FIELD]: "x" })).toBeNull();
    expect(readTableEdit({ [TABLE_EDIT_FIELD]: { base: edit.base } })).toBeNull();
    expect(readTableEdit({ [TABLE_EDIT_FIELD]: { base: null, current: edit.current } })).toBeNull();
    const { indexes: _, ...noIndexes } = edit.current;
    expect(readTableEdit({ [TABLE_EDIT_FIELD]: { base: edit.base, current: noIndexes } })).toBeNull();
    expect(readTableEdit({ [TABLE_EDIT_FIELD]: { base: edit.base, current: { ...edit.current, name: 7 } } })).toBeNull();
  });

  test("only `isNew: true` makes a new table", () => {
    expect(readTableEdit({ [TABLE_EDIT_FIELD]: { ...edit, isNew: "yes" } })?.isNew).toBeUndefined();
    expect(readTableEdit({ [TABLE_EDIT_FIELD]: { ...edit, isNew: true } })?.isNew).toBe(true);
  });

  test("the tab is unsaved while the edit differs from where it started", () => {
    expect(isStructureTabDirty(withTableEdit({}, edit))).toBe(true);
    expect(isStructureTabDirty(withTableEdit({}, { base: edit.base, current: edit.base }))).toBe(false);
    expect(isStructureTabDirty({})).toBe(false);
  });
});

describe("Reset changes", () => {
  test("an existing table goes back to the live one", () => {
    expect(resetTableEdit(nextTableEdit(null, live, "sqlite", setBodyNotNull(true)))).toBeNull();
    expect(resetTableEdit(null)).toBeNull();
  });

  test("a new table goes back to how New table started it", () => {
    const start = readTableEdit(newTableTabMetadata(newTableModel("public"), 2, "b"))!;
    const changed: TableEdit = { ...start, current: { ...start.current, name: "orders" } };
    expect(resetTableEdit(changed)).toEqual(start);
  });
});

describe("New table tabs", () => {
  test("hold the table as DBGate starts one, under an id and number of their own", () => {
    const model = newTableModel("sales");
    expect(newTableTabMetadata(model, 3, "f00")).toEqual({
      newTableId: "f00", tableNumber: 3, schemaName: "sales", [TABLE_EDIT_FIELD]: { base: model, current: model, isNew: true },
    });
    expect(newTableTabMetadata(newTableModel(null), 1, "x").schemaName).toBe("");
  });

  test("are numbered one past the highest New table tab, whatever else is open", () => {
    expect(nextTableNumber([])).toBe(1);
    expect(nextTableNumber([
      { type: "db-structure", metadata: { tableNumber: 5 } },
      { type: "db-structure", metadata: { tableNumber: 2 } },
      { type: "db-structure", metadata: { tableName: "users" } },
      // Only a Structure tab's number counts.
      { type: "db-query", metadata: { tableNumber: 9 } },
      { type: "db-structure", metadata: { tableNumber: "7" } },
      { type: "db-structure" },
    ])).toBe(6);
  });
});
