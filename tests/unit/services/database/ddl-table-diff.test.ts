import { describe, expect, it } from "bun:test";
import { diffTableModels, isEmptyDiff, orderRenames, sameType } from "../../../../src/services/database/ddl/table-diff.ts";
import { baseColumnId, blankColumn, columnById, upsertColumn, upsertItem, type TableModel, type TableModelColumn } from "../../../../src/shared/db-table-model.ts";

const col = (name: string, type: string, extra: Partial<TableModelColumn> = {}): TableModelColumn => ({ ...blankColumn(baseColumnId(name), name), type, ...extra });

const users: TableModel = {
  schema: "public", name: "users",
  columns: [col("id", "integer", { notNull: true }), col("name", "text"), col("boss_id", "integer")],
  primaryKey: { id: "pk", name: "users_pkey", columns: ["c:id"] },
  indexes: [{ id: "ix:users_name", name: "users_name", columns: [{ columnId: "c:name", expression: null, descending: false }], unique: false, method: null, where: null }],
  uniques: [],
  foreignKeys: [{ id: "fk:users_boss", name: "users_boss", columns: ["c:boss_id"], refSchema: "public", refTable: "users", refColumns: ["id"], onUpdate: null, onDelete: "CASCADE" }],
  checks: [], comment: null, engine: null, withoutRowid: false, strict: false,
};

const change = (m: TableModel, name: string, patch: Partial<TableModelColumn>) => upsertColumn(m, { ...columnById(m, baseColumnId(name))!, ...patch });

describe("diffing two table models", () => {
  it("finds nothing between a table and itself, whatever the case of its types", () => {
    expect(isEmptyDiff(diffTableModels(users, users))).toBe(true);
    expect(isEmptyDiff(diffTableModels(users, change(users, "name", { type: " TEXT " })))).toBe(true);
    expect(sameType("character varying(20)", "CHARACTER  VARYING(20)")).toBe(true);
    expect(sameType("varchar(20)", "varchar(30)")).toBe(false);
  });

  it("pairs a column by id, so a new name is a rename and never a drop and an add", () => {
    const d = diffTableModels(users, change(users, "name", { name: "full_name", notNull: true }));
    expect(d.renamedColumns.map((p) => [p.before.name, p.after.name])).toEqual([["name", "full_name"]]);
    expect(d.alteredColumns.map((p) => p.after.name)).toEqual(["full_name"]);
    expect(d.addedColumns).toEqual([]);
    expect(d.droppedColumns).toEqual([]);
    // The index on the column names it by id: renaming the column leaves the index as it was.
    expect(d.droppedIndexes).toEqual([]);
    expect(d.addedIndexes).toEqual([]);
  });

  it("drops and adds again a key that changed in any way", () => {
    const d = diffTableModels(users, upsertItem(users, "indexes", { ...users.indexes[0]!, where: "name IS NOT NULL" }));
    expect(d.droppedIndexes.map((x) => x.name)).toEqual(["users_name"]);
    expect(d.addedIndexes.map((x) => x.where)).toEqual(["name IS NOT NULL"]);
    const pk = diffTableModels(users, { ...users, primaryKey: { ...users.primaryKey!, columns: ["c:id", "c:name"] } });
    expect(pk.droppedPrimaryKey?.columns).toEqual(["c:id"]);
    expect(pk.addedPrimaryKey?.columns).toEqual(["c:id", "c:name"]);
  });

  it("takes an unset foreign key action as the NO ACTION it means", () => {
    const explicit = upsertItem(users, "foreignKeys", { ...users.foreignKeys[0]!, onUpdate: "NO ACTION" });
    expect(isEmptyDiff(diffTableModels(users, explicit))).toBe(true);
    const cascade = upsertItem(users, "foreignKeys", { ...users.foreignKeys[0]!, onUpdate: "CASCADE" });
    expect(diffTableModels(users, cascade).addedForeignKeys).toHaveLength(1);
  });

  it("keeps a foreign key onto its own table unchanged when the column it points at is renamed", () => {
    const renamed = change(users, "id", { name: "user_id" });
    expect(renamed.foreignKeys[0]!.refColumns).toEqual(["user_id"]);
    const d = diffTableModels(users, renamed);
    expect(d.droppedForeignKeys).toEqual([]);
    expect(d.addedForeignKeys).toEqual([]);
  });

  it("notices the comment and the engine", () => {
    expect(diffTableModels(users, { ...users, comment: "People" }).commentChanged).toBe(true);
    expect(diffTableModels(users, { ...users, comment: "  " }).commentChanged).toBe(false);
    expect(diffTableModels(users, { ...users, engine: "MyISAM" }).engineChanged).toBe(true);
  });
});

describe("ordering renames", () => {
  it("runs a chain from its free end, and a cycle through a parked name", () => {
    expect(orderRenames([{ from: "a", to: "b" }, { from: "b", to: "c" }])).toEqual([{ from: "b", to: "c" }, { from: "a", to: "b" }]);
    expect(orderRenames([{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }])).toEqual([
      { from: "a", to: "__ppm_rename_1" },
      { from: "c", to: "a" },
      { from: "b", to: "c" },
      { from: "__ppm_rename_1", to: "b" },
    ]);
    expect(orderRenames([{ from: "a", to: "a" }])).toEqual([]);
  });

  it("never parks under a name that is taken, and can treat names without case", () => {
    expect(orderRenames([{ from: "a", to: "b" }, { from: "b", to: "a" }], ["__ppm_rename_1"])[0]).toEqual({ from: "a", to: "__ppm_rename_2" });
    // `B` is taken while `b` exists on SQLite and MySQL.
    expect(orderRenames([{ from: "a", to: "B" }, { from: "b", to: "c" }], [], true)).toEqual([{ from: "b", to: "c" }, { from: "a", to: "B" }]);
    expect(orderRenames([{ from: "a", to: "B" }, { from: "b", to: "c" }])).toEqual([{ from: "a", to: "B" }, { from: "b", to: "c" }]);
  });
});
