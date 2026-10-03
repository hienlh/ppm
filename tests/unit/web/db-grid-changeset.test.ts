/**
 * The grid's change set, as DBGate keeps it: edits, new rows, clones and rows marked for deletion
 * wait for Save, which sends them as one changeset — and every step can be undone and redone.
 */
import { describe, expect, it } from "bun:test";
import {
  EMPTY_CHANGESET, EMPTY_HISTORY, HISTORY_LIMIT, addRows, cellId, changedRowCount, cloneValues, deleteRows, editCells,
  isCellLocked, isEmptyChangeset, recordChange, redoChange, revertRows, toGridChanges, undoChange, type GridChangeset,
} from "../../../src/web/components/database/grid/grid-changeset";
import { buildChangeset } from "../../../src/services/database/changeset";
import { dialectFor } from "../../../src/services/database/dialects";

const KEY = ["id"];
const users = [
  { id: 1, name: "Ann", plan: "free", photo: null },
  { id: 2, name: "Bob", plan: "pro", photo: { $binary: "AAEC", size: 9000, truncated: true } },
  { id: 3, name: "Cid", plan: null, photo: null },
];
const edit = (cs: GridChangeset, row: Record<string, unknown>, column: string, value: unknown) =>
  editCells(cs, [{ row, column, value }], "id", KEY);

describe("editing a saved row", () => {
  it("keeps the new value with the row's key and what the cell was read with", () => {
    const cs = edit(EMPTY_CHANGESET, users[0]!, "name", "Anna");
    expect(cs.cells.get(cellId(1, "name"))).toEqual({ pkVal: 1, col: "name", newVal: "Anna", key: { id: 1 }, original: "Ann" });
    expect(toGridChanges(cs)).toEqual({ inserts: [], updates: [{ key: { id: 1 }, set: { name: "Anna" }, original: { name: "Ann" } }], deletes: [] });
  });

  it("keeps the first original through later edits, and drops the change once the value is back", () => {
    let cs = edit(EMPTY_CHANGESET, users[0]!, "name", "Anna");
    cs = edit(cs, users[0]!, "name", "Annie");
    expect(cs.cells.get(cellId(1, "name"))?.original).toBe("Ann");
    cs = edit(cs, users[0]!, "name", "Ann");
    expect(cs.cells.size).toBe(0);
    expect(isEmptyChangeset(cs)).toBe(true);
  });

  it("answers the same change set for a change that changes nothing, so no step is recorded", () => {
    const once = edit(EMPTY_CHANGESET, users[0]!, "name", "Anna");
    expect(edit(once, users[0]!, "name", "Anna")).toBe(once);
    expect(edit(EMPTY_CHANGESET, users[0]!, "name", "Ann")).toBe(EMPTY_CHANGESET);
  });

  it("tells a number from the text of it, and JSON by its content", () => {
    expect(edit(EMPTY_CHANGESET, { id: 9, n: 5 }, "n", "5").cells.size).toBe(1);
    expect(edit(EMPTY_CHANGESET, { id: 9, j: { a: [1] } }, "j", { a: [1] })).toBe(EMPTY_CHANGESET);
  });

  it("writes a cleared value as NULL", () => {
    expect(edit(EMPTY_CHANGESET, users[0]!, "plan", undefined).cells.get(cellId(1, "plan"))?.newVal).toBeNull();
  });

  it("leaves a row marked for deletion alone", () => {
    const marked = deleteRows(EMPTY_CHANGESET, [users[1]!], "id", KEY);
    expect(edit(marked, users[1]!, "name", "Bobby")).toBe(marked);
  });

  it("changes several cells as one step", () => {
    const cs = editCells(EMPTY_CHANGESET, [
      { row: users[0]!, column: "plan", value: "pro" },
      { row: users[2]!, column: "plan", value: "pro" },
    ], "id", KEY);
    expect(recordChange(EMPTY_HISTORY, cs).past).toHaveLength(1);
    expect(toGridChanges(cs).updates.map((u) => u.key)).toEqual([{ id: 1 }, { id: 3 }]);
  });
});

describe("new rows", () => {
  it("go under the rest in the order added, each an INSERT of only what was put in it", () => {
    let cs = addRows(EMPTY_CHANGESET, [{ id: "__new_a" }, { id: "__new_b" }]);
    cs = edit(cs, { id: "__new_b" }, "name", "Dee");
    cs = edit(cs, { id: "__new_b" }, "plan", null);
    expect(cs.inserted).toEqual(["__new_a", "__new_b"]);
    // The first was given nothing, (No Field) everywhere: as in DBGate, that is no INSERT at all.
    expect(toGridChanges(cs).inserts).toEqual([{ name: "Dee", plan: null }]);
    expect(changedRowCount(cs)).toBe(1);
    // Given something later, it is written, in the order the rows were added.
    expect(toGridChanges(edit(cs, { id: "__new_a" }, "name", "Ann")).inserts).toEqual([{ name: "Ann" }, { name: "Dee", plan: null }]);
    expect(cs.cells.get(cellId("__new_b", "name"))).toEqual({ pkVal: "__new_b", col: "name", newVal: "Dee" });
    // Typing the same value again is no step to undo.
    expect(edit(cs, { id: "__new_b" }, "name", "Dee")).toBe(cs);
    // Added later, a row goes under the earlier ones.
    expect(addRows(cs, [{ id: "__new_c" }]).inserted).toEqual(["__new_a", "__new_b", "__new_c"]);
  });

  it("clone what a row shows, changes included, bar the key the database fills in and bytes only partly read", () => {
    const cs = edit(EMPTY_CHANGESET, users[1]!, "plan", "team");
    const columns = [
      { name: "id", skip: true }, { name: "name", skip: false }, { name: "plan", skip: false }, { name: "photo", skip: false },
    ];
    expect(cloneValues(cs, users[1]!, "id", columns)).toEqual({ name: "Bob", plan: "team" });
    expect(cloneValues(cs, users[2]!, "id", columns)).toEqual({ name: "Cid", plan: null, photo: null });
    // A column the row was read without is not put in the clone at all, not even as undefined.
    expect(Object.keys(cloneValues(cs, { id: 4, name: "Eve" }, "id", columns))).toEqual(["name"]);
    const cloned = addRows(cs, [{ id: "__new_c", values: cloneValues(cs, users[1]!, "id", columns) }]);
    expect(toGridChanges(cloned).inserts).toEqual([{ name: "Bob", plan: "team" }]);
  });

  it("clone a new row with only what was put in it, never the grid's name for it", () => {
    // A text key the database does not fill in is copied from a saved row, but a new row has none yet.
    const columns = [{ name: "id", skip: false }, { name: "name", skip: false }];
    let cs = addRows(EMPTY_CHANGESET, [{ id: "__new_a" }]);
    cs = edit(cs, { id: "__new_a" }, "name", "Dee");
    expect(cloneValues(cs, { id: "__new_a" }, "id", columns)).toEqual({ name: "Dee" });
    expect(cloneValues(cs, users[0]!, "id", columns)).toEqual({ id: 1, name: "Ann" });
  });
});

describe("cells that cannot be changed", () => {
  const key = { pk: true, autoIncrement: true };
  const textKey = { pk: true, autoIncrement: false };
  const plain = { pk: false, autoIncrement: false };
  const cs = addRows(deleteRows(EMPTY_CHANGESET, [users[1]!], "id", KEY), [{ id: "__new_a" }]);

  it("are a saved row's key, a new row's auto-increment key and every cell of a row to be deleted", () => {
    expect(isCellLocked(key, "1", cs)).toBe(true);
    expect(isCellLocked(textKey, "1", cs)).toBe(true);
    expect(isCellLocked(plain, "1", cs)).toBe(false);
    expect(isCellLocked(key, "__new_a", cs)).toBe(true);
    expect(isCellLocked(textKey, "__new_a", cs)).toBe(false);
    expect(isCellLocked(plain, "__new_a", cs)).toBe(false);
    expect(isCellLocked(plain, "2", cs)).toBe(true);
  });
});

describe("a key of several columns", () => {
  it("addresses an edited row by every column of it, through the hidden field naming the row", () => {
    const row = Object.defineProperty({ region: "eu", code: 7, label: "old" }, "__ppm_row_id", { value: '["eu",7]' });
    const cs = editCells(EMPTY_CHANGESET, [{ row, column: "label", value: "new" }], "__ppm_row_id", ["region", "code"]);
    expect(toGridChanges(cs).updates).toEqual([{ key: { region: "eu", code: 7 }, set: { label: "new" }, original: { label: "old" } }]);
  });
});

describe("deleting rows", () => {
  it("marks a saved row with its key and sends it as a DELETE, its edits dropped", () => {
    let cs = edit(EMPTY_CHANGESET, users[1]!, "name", "Bobby");
    cs = edit(cs, users[0]!, "name", "Anna");
    cs = deleteRows(cs, [users[1]!], "id", KEY);
    expect(cs.deleted.get("2")).toEqual({ id: 2 });
    // The row shows what the database holds; the other row keeps its edit.
    expect([...cs.cells.keys()]).toEqual([cellId(1, "name")]);
    expect(toGridChanges(cs).deletes).toEqual([{ key: { id: 2 } }]);
    expect(toGridChanges(cs).updates.map((u) => u.key)).toEqual([{ id: 1 }]);
    expect(changedRowCount(cs)).toBe(2);
  });

  it("takes a new row away with what was put in it", () => {
    let cs = addRows(EMPTY_CHANGESET, [{ id: "__new_a" }, { id: "__new_b" }]);
    cs = edit(cs, { id: "__new_a" }, "name", "Dee");
    cs = deleteRows(cs, [{ id: "__new_a" }], "id", KEY);
    expect(cs.inserted).toEqual(["__new_b"]);
    expect(cs.cells.size).toBe(0);
  });

  it("marks a row once", () => {
    const cs = deleteRows(EMPTY_CHANGESET, [users[0]!], "id", KEY);
    expect(deleteRows(cs, [users[0]!], "id", KEY)).toBe(cs);
  });

  it("names a row of a key of several columns by its hidden id and deletes it by every column", () => {
    const row = Object.defineProperty({ org: 7, code: "x" }, "__ppm_row_id", { value: JSON.stringify([7, "x"]) });
    const cs = deleteRows(EMPTY_CHANGESET, [row], "__ppm_row_id", ["org", "code"]);
    expect([...cs.deleted]).toEqual([['[7,"x"]', { org: 7, code: "x" }]]);
  });
});

describe("reverting rows", () => {
  it("drops their changes, their deletion and the new ones among them", () => {
    let cs = edit(EMPTY_CHANGESET, users[0]!, "name", "Anna");
    cs = edit(cs, users[2]!, "name", "Cy");
    cs = deleteRows(cs, [users[1]!], "id", KEY);
    cs = addRows(cs, [{ id: "__new_a" }]);
    cs = revertRows(cs, new Set(["1", "2", "__new_a"]));
    expect([...cs.cells.keys()]).toEqual([cellId(3, "name")]);
    expect(cs.deleted.size).toBe(0);
    expect(cs.inserted).toEqual([]);
  });

  it("answers the same change set for rows that had nothing to revert", () => {
    const cs = edit(EMPTY_CHANGESET, users[0]!, "name", "Anna");
    expect(revertRows(cs, new Set(["3"]))).toBe(cs);
  });
});

it("counts the rows Save would write: changed, to delete and new, each once", () => {
  let cs = edit(EMPTY_CHANGESET, users[0]!, "name", "Anna");
  cs = edit(cs, users[0]!, "plan", "pro");
  cs = edit(cs, users[1]!, "name", "Bobby");
  cs = deleteRows(cs, [users[1]!], "id", KEY);
  cs = addRows(cs, [{ id: "__new_a", values: { name: "Dee" } }]);
  expect(changedRowCount(cs)).toBe(3);
  // A row only marked for deletion counts too.
  expect(changedRowCount(deleteRows(EMPTY_CHANGESET, [users[2]!], "id", KEY))).toBe(1);
});

it("becomes DBGate's script: INSERT, then the UPDATEs, then the DELETE", () => {
  // Two cells of two rows changed, one row added and one deleted: four statements, in that order.
  let cs = edit(EMPTY_CHANGESET, users[0]!, "name", "Anna");
  cs = edit(cs, users[2]!, "plan", "pro");
  cs = addRows(cs, [{ id: "__new_a", values: { name: "Dee" } }]);
  cs = deleteRows(cs, [users[1]!], "id", KEY);
  const table = {
    schema: null, name: "users", rowidAliases: [],
    columns: [
      { name: "id", type: "INTEGER", kind: "number" as const }, { name: "name", type: "TEXT", kind: "text" as const },
      { name: "plan", type: "TEXT", kind: "text" as const }, { name: "photo", type: "BLOB", kind: "binary" as const },
    ],
  };
  const built = buildChangeset(dialectFor("sqlite"), table, { ...toGridChanges(cs), cascade: [] });
  expect(built.statements.map((s) => s.kind)).toEqual(["insert", "update", "update", "delete"]);
  expect(built.statements.map((s) => s.displaySql)).toEqual([
    `INSERT INTO "users" ("name") VALUES ('Dee')`,
    `UPDATE "users" SET "name" = 'Anna' WHERE "id" = 1 AND "name" IS 'Ann'`,
    `UPDATE "users" SET "plan" = 'pro' WHERE "id" = 3 AND "plan" IS NULL`,
    `DELETE FROM "users" WHERE "id" = 2`,
  ]);
});

describe("undo and redo", () => {
  it("bring the old value back and then the new one", () => {
    let h = recordChange(EMPTY_HISTORY, edit(EMPTY_HISTORY.present, users[0]!, "name", "Anna"));
    h = recordChange(h, edit(h.present, users[0]!, "name", "Annie"));
    h = undoChange(h);
    expect(h.present.cells.get(cellId(1, "name"))?.newVal).toBe("Anna");
    h = undoChange(h);
    expect(isEmptyChangeset(h.present)).toBe(true);
    expect(undoChange(h)).toBe(h);
    h = redoChange(h);
    expect(h.present.cells.get(cellId(1, "name"))?.newVal).toBe("Anna");
    h = redoChange(redoChange(h));
    expect(h.present.cells.get(cellId(1, "name"))?.newVal).toBe("Annie");
    expect(redoChange(h)).toBe(h);
    // What was redone can be undone again.
    expect(undoChange(h).present.cells.get(cellId(1, "name"))?.newVal).toBe("Anna");
  });

  it("forget what could be redone once something new is changed", () => {
    let h = recordChange(EMPTY_HISTORY, edit(EMPTY_HISTORY.present, users[0]!, "name", "Anna"));
    h = undoChange(h);
    h = recordChange(h, edit(h.present, users[2]!, "name", "Cy"));
    expect(h.future).toEqual([]);
    expect(redoChange(h)).toBe(h);
  });

  it("record nothing for a change that changed nothing", () => {
    const h = recordChange(EMPTY_HISTORY, edit(EMPTY_HISTORY.present, users[0]!, "name", "Anna"));
    expect(recordChange(h, h.present)).toBe(h);
  });

  it(`keep the last ${HISTORY_LIMIT} steps`, () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = recordChange(h, edit(h.present, users[0]!, "name", `n${i}`));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    // The oldest steps went first: undoing all the way stops short of the empty change set.
    while (h.past.length) h = undoChange(h);
    expect(h.present.cells.get(cellId(1, "name"))?.newVal).toBe("n4");
  });
});
