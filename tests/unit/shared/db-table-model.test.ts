import { describe, expect, it } from "bun:test";
import type { DbTableStructure } from "../../../src/shared/db-structure.ts";
import {
  autoConstraintName, blankColumn, columnById, columnProblems, declaredType, foreignKeyProblems, keyNameTaken, keyProblems, modelFromStructure,
  newItemId, newTableModel, removeColumns, sameTableModel, setPrimaryKeyMember, splitMysqlType, tableModelProblems, upsertColumn, type TableModel,
} from "../../../src/shared/db-table-model.ts";

const structure: DbTableStructure = {
  schema: "public", name: "users", kind: "table",
  columns: [
    { name: "id", type: "integer", nullable: false, defaultValue: null, comment: null, autoIncrement: true, generated: false, computedExpression: null, identity: "default" },
    { name: "email", type: "text", nullable: true, defaultValue: null, comment: "Login", autoIncrement: false, generated: false, computedExpression: null, collation: "\"C\"" },
    { name: "boss_id", type: "integer", nullable: true, defaultValue: null, comment: null, autoIncrement: false, generated: false, computedExpression: null },
  ],
  primaryKey: { name: "users_pkey", columns: ["id"] },
  foreignKeys: [{ name: "users_boss", schema: "public", table: "users", columns: ["boss_id"], refSchema: "public", refTable: "users", refColumns: ["id"], onDelete: "SET NULL", onUpdate: "NO ACTION" }],
  references: [],
  indexes: [
    { name: "users_pkey", columns: ["id"], keys: [{ column: "id", expression: null, descending: false }], unique: true, primary: true, where: null, method: "btree" },
    { name: "users_email_key", columns: ["email"], keys: [{ column: "email", expression: null, descending: false }], unique: true, primary: false, where: null, method: "btree" },
    { name: "users_lower", columns: ["lower(email)"], keys: [{ column: null, expression: "lower(email)", descending: true, nulls: "last" }], unique: false, primary: false, where: "email IS NOT NULL", method: "btree" },
  ],
  uniques: [{ name: "users_email_key", columns: ["email"] }],
  checks: [{ name: "email_shape", expression: "email LIKE '%@%'" }],
  comment: "People",
  rowKey: ["id"],
  rowKeyIsRowid: false,
};

describe("the table editor's model", () => {
  it("is built from the catalog with ids that pair it with itself read again", () => {
    const m = modelFromStructure(structure, "postgres");
    expect(m.columns.map((c) => c.id)).toEqual(["c:id", "c:email", "c:boss_id"]);
    expect(m.primaryKey).toEqual({ id: "pk", name: "users_pkey", columns: ["c:id"] });
    // The primary key's index and the unique constraint's are not indexes of their own.
    expect(m.indexes).toEqual([{
      id: "ix:users_lower", name: "users_lower", unique: false, method: null, where: "email IS NOT NULL",
      columns: [{ columnId: null, expression: "lower(email)", descending: true, nulls: "last" }],
    }]);
    expect(m.uniques).toEqual([{ id: "uq:users_email_key", name: "users_email_key", columns: ["c:email"] }]);
    expect(m.foreignKeys[0]).toMatchObject({ id: "fk:users_boss", columns: ["c:boss_id"], refColumns: ["id"] });
    expect(columnById(m, "c:email")).toMatchObject({ collation: "\"C\"", comment: "Login", notNull: false });
    expect(columnById(m, "c:id")).toMatchObject({ identity: "default", autoIncrement: true, notNull: true });
    expect(sameTableModel(m, modelFromStructure(structure, "postgres"))).toBe(true);
    // A model that went through a tab's metadata still compares equal.
    expect(sameTableModel(JSON.parse(JSON.stringify(m)) as TableModel, m)).toBe(true);
    expect(sameTableModel({ ...m, comment: "Other" }, m)).toBe(false);
  });

  it("keeps MySQL's unsigned and zerofill as flags of their own, and writes them back into the type", () => {
    expect(splitMysqlType("int(10) unsigned zerofill")).toEqual({ type: "int(10)", unsigned: true, zerofill: true });
    expect(splitMysqlType("decimal(8,2)")).toEqual({ type: "decimal(8,2)", unsigned: false, zerofill: false });
    expect(declaredType({ type: "int(10)", unsigned: true, zerofill: true }, "mysql")).toBe("int(10) unsigned zerofill");
    expect(declaredType({ type: "int", unsigned: true, zerofill: false }, "postgres")).toBe("int");
  });

  it("carries a rename to the foreign key that points back at its own table, and to nothing else", () => {
    const m = modelFromStructure(structure, "postgres");
    const renamed = upsertColumn(m, { ...columnById(m, "c:id")!, name: "user_id" });
    expect(renamed.foreignKeys[0]!.refColumns).toEqual(["user_id"]);
    expect(renamed.primaryKey!.columns).toEqual(["c:id"]);
    const other = { ...m, foreignKeys: [{ ...m.foreignKeys[0]!, refTable: "people" }] };
    expect(upsertColumn(other, { ...columnById(other, "c:id")!, name: "user_id" }).foreignKeys[0]!.refColumns).toEqual(["id"]);
  });

  it("removes a column from every key and drops a key left with none", () => {
    const m = modelFromStructure(structure, "postgres");
    const withPair = { ...m, primaryKey: { ...m.primaryKey!, columns: ["c:id", "c:email"] } };
    const gone = removeColumns(withPair, ["c:email"]);
    expect(gone.primaryKey!.columns).toEqual(["c:id"]);
    expect(gone.uniques).toEqual([]);
    // The expression part names no column id, so the index stays.
    expect(gone.indexes).toHaveLength(1);
    // Removing the column a self-reference points at takes the pair — and so the key — away.
    expect(removeColumns(m, ["c:id"]).foreignKeys).toEqual([]);
    expect(removeColumns(m, ["c:id"]).primaryKey).toBeNull();
  });

  it("creates the primary key with its first column and drops it with its last", () => {
    const m = { ...modelFromStructure(structure, "postgres"), primaryKey: null };
    const one = setPrimaryKeyMember(m, "c:email", true);
    expect(one.primaryKey?.columns).toEqual(["c:email"]);
    expect(setPrimaryKeyMember(one, "c:email", false).primaryKey).toBeNull();
    expect(newItemId(one)).not.toBe(one.primaryKey!.id);
  });

  it("starts a new table as DBGate does", () => {
    const m = newTableModel("public");
    expect(m.name).toBe("new_table");
    expect(m.columns).toEqual([{ ...blankColumn("n:1", "id"), notNull: true, autoIncrement: true }]);
    expect(m.primaryKey).toEqual({ id: "n:2", name: null, columns: ["n:1"] });
  });

  it("refuses what the engine would refuse, before Save", () => {
    const m = newTableModel(null);
    const messages = (x: TableModel, d: "postgres" | "mysql" | "sqlite") => tableModelProblems(x, d).map((p) => p.message);
    expect(messages(m, "postgres")).toEqual([]);
    expect(messages({ ...m, name: " " }, "postgres")).toEqual(["Table name is required"]);
    const twins = upsertColumn(m, { ...blankColumn("n:3", "ID"), type: "text" });
    expect(messages(twins, "mysql")).toEqual(["There is already a column named id", "There is already a column named ID"]);
    // Postgres tells "ID" from "id".
    expect(messages(twins, "postgres")).toEqual([]);
    expect(messages(upsertColumn(m, { ...columnById(m, "n:1")!, type: "text" }), "postgres")).toEqual(["An autoincrement column needs an integer type"]);
    expect(messages({ ...m, primaryKey: null }, "mysql")).toEqual(["id is autoincrement, so MySQL needs it to lead the primary key or an index"]);
    const pair = upsertColumn(m, { ...blankColumn("n:3", "tenant"), notNull: true });
    expect(messages({ ...pair, primaryKey: { ...pair.primaryKey!, columns: ["n:3", "n:1"] } }, "sqlite")).toEqual([
      "In SQLite only a column that is the whole primary key can be autoincrement (id)",
    ]);
    expect(messages({ ...m, withoutRowid: true }, "sqlite")).toEqual(["A WITHOUT ROWID table has no autoincrement"]);
  });

  it("names what the user left unnamed as DBGate does", () => {
    expect(autoConstraintName("PK", "users", ["id"])).toBe("PK_users");
    expect(autoConstraintName("FK", "orders", ["user_id", "org_id"])).toBe("FK_orders_user_id_org_id");
  });
});

describe("what stops a dialog from closing", () => {
  const m = modelFromStructure(structure, "postgres");

  it("finds a key or index name already in use, as the engine compares names", () => {
    expect(keyNameTaken(m, "new", "users_lower", "postgres")).toBe(true);
    expect(keyNameTaken(m, "new", " users_email_key ", "sqlite")).toBe(true);
    expect(keyNameTaken(m, "new", "users_boss", "mysql")).toBe(true);
    // Its own name is not taken from it.
    expect(keyNameTaken(m, "ix:users_lower", "users_lower", "postgres")).toBe(false);
    // Postgres tells case apart; MySQL and SQLite do not.
    expect(keyNameTaken(m, "new", "USERS_LOWER", "postgres")).toBe(false);
    expect(keyNameTaken(m, "new", "USERS_LOWER", "mysql")).toBe(true);
    // Only Postgres gives a primary key a name of its own.
    expect(keyNameTaken(m, "new", "users_pkey", "postgres")).toBe(true);
    expect(keyNameTaken(m, "new", "users_pkey", "mysql")).toBe(false);
    expect(keyNameTaken(m, "new", "  ", "postgres")).toBe(false);
    expect(keyNameTaken({ ...m, indexes: [{ ...m.indexes[0]!, name: " users_lower " }] }, "new", "users_lower", "postgres")).toBe(true);
    // A key Save will name has no name to clash with yet.
    expect(keyNameTaken({ ...m, foreignKeys: [{ ...m.foreignKeys[0]!, name: null }] }, "new", "users_boss", "postgres")).toBe(false);
  });

  it("asks a column for a name no other column has, and a type", () => {
    const col = (name: string, extra: Partial<ReturnType<typeof blankColumn>> = {}) => ({ ...blankColumn("new", name), ...extra });
    expect(columnProblems(m, col(" "), "postgres")).toEqual(["Column name is required"]);
    expect(columnProblems(m, col(" Email ", { type: "text" }), "mysql")).toEqual(["There is already a column named Email"]);
    expect(columnProblems(m, col("Email", { type: "text" }), "postgres")).toEqual([]);
    expect(columnProblems(m, columnById(m, "c:email")!, "postgres")).toEqual([]);
    expect(columnProblems(m, col("note", { type: " " }), "postgres")).toEqual(["Data type is required"]);
  });

  it("allows autoincrement on integer types only, and never on a computed column", () => {
    const auto = (type: string, computedExpression: string | null = null) =>
      columnProblems(m, { ...blankColumn("new", "n"), type, autoIncrement: true, computedExpression }, "postgres");
    for (const type of ["int", "INTEGER", "bigint", "smallint", "tinyint(1)", "mediumint", "int8", "serial", "bigserial", "int(11) ", " bigint"]) expect(auto(type)).toEqual([]);
    for (const type of ["text", "interval", "point", "numeric(10)"]) expect(auto(type)).toEqual(["An autoincrement column needs an integer type"]);
    expect(auto("integer", "a + 1")).toEqual(["A computed column cannot be autoincrement"]);
  });

  it("asks a key for columns, each a column the table has, none twice", () => {
    expect(keyProblems(m, [], "primaryKey")).toEqual(["A primary key needs at least one column"]);
    expect(keyProblems(m, [], "index")).toEqual(["An index needs at least one column"]);
    expect(keyProblems(m, [], "unique")).toEqual(["A unique constraint needs at least one column"]);
    expect(keyProblems(m, ["c:id", "c:gone"], "unique")).toEqual(["Choose a column for every row"]);
    expect(keyProblems(m, ["c:id", "c:email", "c:id"], "index")).toEqual(["A column is listed twice"]);
    // An expression part names no column and is no problem.
    expect(keyProblems(m, [null, "c:email"], "index")).toEqual([]);
    expect(keyProblems(m, [null], "index")).toEqual([]);
  });

  it("asks a foreign key for the table it references and a pair of columns on every row", () => {
    const fk = m.foreignKeys[0]!;
    expect(foreignKeyProblems(m, fk)).toEqual([]);
    expect(foreignKeyProblems(m, { ...fk, refTable: "" })).toEqual(["Choose the referenced table"]);
    expect(foreignKeyProblems(m, { ...fk, columns: [], refColumns: [] })).toEqual(["A foreign key needs at least one column"]);
    const pairs = "Choose a base column and a referenced column for every row";
    expect(foreignKeyProblems(m, { ...fk, refColumns: [""] })).toEqual([pairs]);
    expect(foreignKeyProblems(m, { ...fk, columns: ["c:gone"] })).toEqual([pairs]);
    expect(foreignKeyProblems(m, { ...fk, columns: ["c:boss_id", "c:email"] })).toEqual([pairs]);
  });

  it("refuses at Save what only the whole table shows", () => {
    const problems = (x: TableModel, d: "postgres" | "mysql" | "sqlite") => tableModelProblems(x, d);
    // The read table itself, expression index included, saves as it is.
    expect(problems(m, "postgres")).toEqual([]);
    expect(problems({ ...newTableModel(null), columns: [], primaryKey: null }, "postgres").map((p) => p.message)).toEqual(["A table needs at least one column"]);
    // An index with no part at all is told so once.
    expect(problems({ ...m, indexes: [{ ...m.indexes[0]!, columns: [] }] }, "postgres")).toEqual([
      { section: "indexes", id: "ix:users_lower", message: "An index needs at least one column" },
    ]);
    // The second of two names is the one marked.
    expect(problems({ ...m, indexes: [{ ...m.indexes[0]!, name: "users_email_key" }] }, "postgres")).toEqual([
      { section: "uniques", id: "uq:users_email_key", message: "Two keys or indexes are named users_email_key" },
    ]);
    // As the engine compares names.
    const shouty = { ...m, indexes: [{ ...m.indexes[0]!, name: "USERS_EMAIL_KEY" }] };
    expect(problems(shouty, "postgres")).toEqual([]);
    expect(problems(shouty, "mysql").map((p) => p.id)).toEqual(["uq:users_email_key"]);
    const pkNamed = { ...m, indexes: [{ ...m.indexes[0]!, name: "USERS_PKEY" }] };
    expect(problems({ ...pkNamed, primaryKey: { ...m.primaryKey!, name: "users_pkey" } }, "mysql")).toEqual([]);
    expect(problems({ ...m, indexes: [{ ...m.indexes[0]!, name: "users_pkey" }] }, "postgres")).toEqual([
      { section: "primaryKey", id: "pk", message: "Two keys or indexes are named users_pkey" },
    ]);
    const twoAuto = upsertColumn(m, { ...columnById(m, "c:boss_id")!, autoIncrement: true });
    expect(problems({ ...twoAuto, uniques: [{ id: "uq:b", name: "uq_b", columns: ["c:boss_id"] }] }, "mysql")).toEqual([
      { section: "columns", id: "c:boss_id", message: "MySQL allows one autoincrement column per table" },
    ]);
  });
});
