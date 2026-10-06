import { describe, expect, it } from "bun:test";
import { postgresAlterTable, postgresCreateTable, type PostgresDdlContext } from "../../../../src/services/database/ddl/ddl-postgres.ts";
import { DdlUnsupportedError, ddlScript, type DdlPlan } from "../../../../src/services/database/ddl/ddl-types.ts";
import { diffTableModels } from "../../../../src/services/database/ddl/table-diff.ts";
import type { DbForeignKey } from "../../../../src/shared/db-structure.ts";
import {
  baseColumnId, blankColumn, columnById, removeColumns, upsertColumn, upsertItem, type TableModel, type TableModelColumn,
} from "../../../../src/shared/db-table-model.ts";

const col = (name: string, type: string, extra: Partial<TableModelColumn> = {}): TableModelColumn => ({ ...blankColumn(baseColumnId(name), name), type, ...extra });

function table(name: string, columns: TableModelColumn[], extra: Partial<TableModel> = {}): TableModel {
  return {
    schema: "public", name, columns, primaryKey: null, indexes: [], uniques: [], foreignKeys: [], checks: [], comment: null, engine: null,
    withoutRowid: false, strict: false, ...extra,
  };
}

const PG17: PostgresDdlContext = { version: 170004, references: [] };

function alter(base: TableModel, edit: (m: TableModel) => TableModel, ctx = PG17): DdlPlan {
  const current = edit(base);
  return postgresAlterTable(base, current, diffTableModels(base, current), ctx);
}

const script = (plan: DdlPlan) => ddlScript(plan.statements);
const change = (m: TableModel, name: string, patch: Partial<TableModelColumn>) => upsertColumn(m, { ...columnById(m, baseColumnId(name))!, ...patch });

describe("Postgres DDL", () => {
  it("creates a table with its keys inside, then comments, indexes and — last — foreign keys", () => {
    const plan = postgresCreateTable(table("orders", [
      col("id", "integer", { notNull: true, autoIncrement: true }),
      col("code", "varchar(20)", { notNull: true, collation: "\"C\"" }),
      col("qty", "integer", { defaultValue: "1" }),
      col("total", "numeric", { computedExpression: "qty * 2" }),
      col("note", "text", { comment: "Free text" }),
      col("user_id", "bigint"),
    ], {
      primaryKey: { id: "pk", name: null, columns: ["c:id"] },
      uniques: [{ id: "u", name: null, columns: ["c:code"] }],
      indexes: [{
        id: "i", name: "", unique: false, method: null, where: "qty > 0",
        columns: [
          { columnId: "c:code", expression: null, descending: true, nulls: "last", opclass: "text_pattern_ops" },
          { columnId: null, expression: "lower(note)", descending: false },
        ],
      }, { id: "g", name: "orders_note_trgm", unique: false, method: "gin", where: null, columns: [{ columnId: "c:note", expression: null, descending: false, opclass: "gin_trgm_ops" }] }],
      foreignKeys: [{ id: "f", name: null, columns: ["c:user_id"], refSchema: null, refTable: "users", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "CASCADE" }],
      comment: "It's orders",
    }));
    expect(script(plan)).toBe([
      "CREATE TABLE \"public\".\"orders\" (",
      "  \"id\" serial NOT NULL,",
      "  \"code\" varchar(20) COLLATE \"C\" NOT NULL,",
      "  \"qty\" integer DEFAULT 1,",
      "  \"total\" numeric GENERATED ALWAYS AS (qty * 2) STORED,",
      "  \"note\" text,",
      "  \"user_id\" bigint,",
      "  CONSTRAINT \"PK_orders\" PRIMARY KEY (\"id\"),",
      "  CONSTRAINT \"UQ_orders_code\" UNIQUE (\"code\")",
      ");",
      "COMMENT ON TABLE \"public\".\"orders\" IS 'It''s orders';",
      "COMMENT ON COLUMN \"public\".\"orders\".\"note\" IS 'Free text';",
      "CREATE INDEX \"IX_orders_code_expr\" ON \"public\".\"orders\" (\"code\" text_pattern_ops DESC NULLS LAST, (lower(note))) WHERE qty > 0;",
      "CREATE INDEX \"orders_note_trgm\" ON \"public\".\"orders\" USING gin (\"note\" gin_trgm_ops);",
      "ALTER TABLE \"public\".\"orders\" ADD CONSTRAINT \"FK_orders_user_id\" FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\" (\"id\") ON DELETE CASCADE;",
    ].join("\n"));
    expect(plan.recreate).toBe(false);
  });

  it("swaps two column names through a name of its own", () => {
    const base = table("t", [col("a", "text"), col("b", "text")]);
    expect(script(alter(base, (m) => change(change(m, "a", { name: "b" }), "b", { name: "a" })))).toBe([
      "ALTER TABLE \"public\".\"t\" RENAME COLUMN \"a\" TO \"__ppm_rename_1\";",
      "ALTER TABLE \"public\".\"t\" RENAME COLUMN \"b\" TO \"a\";",
      "ALTER TABLE \"public\".\"t\" RENAME COLUMN \"__ppm_rename_1\" TO \"b\";",
    ].join("\n"));
  });

  it("drops columns before renaming, so a rename can take a dropped column's name", () => {
    const base = table("t", [col("a", "text"), col("b", "text")]);
    expect(script(alter(base, (m) => change(removeColumns(m, ["c:b"]), "a", { name: "b" })))).toBe([
      "ALTER TABLE \"public\".\"t\" DROP COLUMN \"b\";",
      "ALTER TABLE \"public\".\"t\" RENAME COLUMN \"a\" TO \"b\";",
    ].join("\n"));
  });

  it("changes a column one property at a time, keeps its collation, and fills NULLs before NOT NULL", () => {
    const base = table("t", [col("name", "varchar(50)", { collation: "\"C\"" })]);
    expect(script(alter(base, (m) => change(m, "name", { name: "title", type: "text", notNull: true, defaultValue: "'anon'" })))).toBe([
      "ALTER TABLE \"public\".\"t\" RENAME COLUMN \"name\" TO \"title\";",
      "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"title\" TYPE text COLLATE \"C\";",
      "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"title\" SET DEFAULT 'anon';",
      "UPDATE \"public\".\"t\" SET \"title\" = 'anon' WHERE \"title\" IS NULL;",
      "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"title\" SET NOT NULL;",
    ].join("\n"));
    expect(script(alter(table("t", [col("n", "integer", { notNull: true, defaultValue: "0" })]), (m) => change(m, "n", { notNull: false, defaultValue: null })))).toBe([
      "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"n\" DROP DEFAULT;",
      "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"n\" DROP NOT NULL;",
    ].join("\n"));
  });

  it("makes an existing column count up as an identity, starting past the values it holds", () => {
    const base = table("t", [col("id", "integer", { notNull: true, defaultValue: "0" })]);
    expect(script(alter(base, (m) => change(m, "id", { autoIncrement: true })))).toBe([
      "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"id\" DROP DEFAULT;",
      "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"id\" ADD GENERATED BY DEFAULT AS IDENTITY;",
      "SELECT setval(pg_get_serial_sequence('\"public\".\"t\"', 'id'), COALESCE((SELECT max(\"id\") FROM \"public\".\"t\"), 0) + 1, false);",
    ].join("\n"));
    expect(() => alter(base, (m) => change(m, "id", { autoIncrement: true }), { version: 90600, references: [] })).toThrow(DdlUnsupportedError);
    // An identity column may hold no NULL.
    expect(script(alter(table("t", [col("n", "integer")]), (m) => change(m, "n", { autoIncrement: true })))).toBe([
      "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"n\" SET NOT NULL;",
      "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"n\" ADD GENERATED BY DEFAULT AS IDENTITY;",
      "SELECT setval(pg_get_serial_sequence('\"public\".\"t\"', 'n'), COALESCE((SELECT max(\"n\") FROM \"public\".\"t\"), 0) + 1, false);",
    ].join("\n"));
  });

  it("stops a serial by dropping its nextval default, and an identity by DROP IDENTITY", () => {
    const serial = table("t", [col("id", "integer", { notNull: true, autoIncrement: true, defaultValue: "nextval('t_id_seq'::regclass)" })]);
    expect(script(alter(serial, (m) => change(m, "id", { autoIncrement: false })))).toBe("ALTER TABLE \"public\".\"t\" ALTER COLUMN \"id\" DROP DEFAULT;");
    expect(script(alter(serial, (m) => change(m, "id", { autoIncrement: false, defaultValue: "0" })))).toBe("ALTER TABLE \"public\".\"t\" ALTER COLUMN \"id\" SET DEFAULT 0;");
    const identity = table("t", [col("id", "bigint", { notNull: true, autoIncrement: true, identity: "always" })]);
    expect(script(alter(identity, (m) => change(m, "id", { autoIncrement: false })))).toBe("ALTER TABLE \"public\".\"t\" ALTER COLUMN \"id\" DROP IDENTITY;");
  });

  it("changes a computed column only where the server can", () => {
    const base = table("t", [col("a", "integer"), col("total", "integer", { computedExpression: "a * 2", computedStored: true })]);
    expect(script(alter(base, (m) => change(m, "total", { computedExpression: null })))).toBe("ALTER TABLE \"public\".\"t\" ALTER COLUMN \"total\" DROP EXPRESSION;");
    expect(() => alter(base, (m) => change(m, "total", { computedExpression: null }), { version: 120010, references: [] })).toThrow("Postgres 12 cannot turn the computed column total into an ordinary one (13 can)");
    expect(script(alter(base, (m) => change(m, "total", { computedExpression: "a * 3" })))).toBe("ALTER TABLE \"public\".\"t\" ALTER COLUMN \"total\" SET EXPRESSION AS (a * 3);");
    expect(() => alter(base, (m) => change(m, "total", { computedExpression: "a * 3" }), { version: 160002, references: [] })).toThrow(/Postgres 16 cannot change what total is computed from/);
    expect(() => alter(base, (m) => change(m, "a", { computedExpression: "1" }))).toThrow(/cannot make the existing column a a computed one/);
  });

  it("drops another table's foreign key on a column it removes, and says so", () => {
    const fk = (name: string, t: string, refColumns: string[]): DbForeignKey => ({
      name, schema: "public", table: t, columns: ["x"], refSchema: "public", refTable: "users", refColumns, onDelete: "NO ACTION", onUpdate: "NO ACTION",
    });
    const base = table("users", [col("id", "integer"), col("legacy_id", "integer")]);
    const plan = alter(base, (m) => removeColumns(m, ["c:legacy_id"]), {
      version: 170004, references: [fk("orders_legacy_fk", "orders", ["legacy_id"]), fk("orders_user_fk", "orders", ["id"]), fk("users_self_fk", "users", ["legacy_id"])],
    });
    expect(script(plan)).toBe([
      "ALTER TABLE \"public\".\"orders\" DROP CONSTRAINT \"orders_legacy_fk\";",
      "ALTER TABLE \"public\".\"users\" DROP COLUMN \"legacy_id\";",
    ].join("\n"));
    expect(plan.warnings).toEqual(["Drops the foreign key orders_legacy_fk of public.orders, which points at a column this removes"]);
  });

  it("adds columns last among column changes, warning about NOT NULL with no default", () => {
    const base = table("t", [col("id", "integer")]);
    const plan = alter(base, (m) => upsertColumn(upsertColumn(m, col("a", "text", { id: "n:1", notNull: true })), col("b", "text", { id: "n:2", notNull: true, defaultValue: "''" })));
    expect(script(plan)).toBe([
      "ALTER TABLE \"public\".\"t\" ADD COLUMN \"a\" text NOT NULL;",
      "ALTER TABLE \"public\".\"t\" ADD COLUMN \"b\" text NOT NULL DEFAULT '';",
    ].join("\n"));
    expect(plan.warnings).toEqual(["a is NOT NULL with no default, so adding it fails if t has rows"]);
  });

  it("recreates a changed key under its own name, and names a new one clear of the names in use", () => {
    const base = table("t", [col("a", "integer"), col("b", "integer")], {
      primaryKey: { id: "pk", name: "t_pkey", columns: ["c:a"] },
      indexes: [{ id: "ix:IX_t_a", name: "IX_t_a", columns: [{ columnId: "c:a", expression: null, descending: false }], unique: false, method: null, where: null }],
    });
    const plan = alter(base, (m) => {
      const pk = { ...m, primaryKey: { ...m.primaryKey!, columns: ["c:a", "c:b"] } };
      const changed = upsertItem(pk, "indexes", { ...m.indexes[0]!, columns: [{ columnId: "c:a", expression: null, descending: true }] });
      return upsertItem(changed, "indexes", { id: "n:9", name: "", columns: [{ columnId: "c:a", expression: null, descending: false }], unique: true, method: null, where: null });
    });
    expect(script(plan)).toBe([
      "DROP INDEX \"public\".\"IX_t_a\";",
      "ALTER TABLE \"public\".\"t\" DROP CONSTRAINT \"t_pkey\";",
      "ALTER TABLE \"public\".\"t\" ADD CONSTRAINT \"t_pkey\" PRIMARY KEY (\"a\", \"b\");",
      "CREATE INDEX \"IX_t_a\" ON \"public\".\"t\" (\"a\" DESC);",
      "CREATE UNIQUE INDEX \"IX_t_a_2\" ON \"public\".\"t\" (\"a\");",
    ].join("\n"));
    // A name an index keeps unchanged is taken too.
    expect(script(alter(base, (m) => upsertItem(m, "indexes", { id: "n:9", name: "", columns: [{ columnId: "c:a", expression: null, descending: true }], unique: false, method: null, where: null }))))
      .toBe("CREATE INDEX \"IX_t_a_2\" ON \"public\".\"t\" (\"a\" DESC);");
  });

  it("says a comment again only when it changed, and clears one with NULL", () => {
    const base = table("t", [col("a", "integer", { comment: "old" })], { comment: "Table" });
    expect(script(alter(base, (m) => ({ ...change(m, "a", { comment: "" }), comment: null })))).toBe([
      "COMMENT ON COLUMN \"public\".\"t\".\"a\" IS NULL;",
      "COMMENT ON TABLE \"public\".\"t\" IS NULL;",
    ].join("\n"));
    expect(script(alter(base, (m) => ({ ...m, comment: " Table " })))).toBe("");
  });
});
