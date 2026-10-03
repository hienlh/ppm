import { describe, expect, it } from "bun:test";
import { mysqlAlterTable, mysqlCreateTable, mysqlHasRenameColumn, type MysqlDdlContext } from "../../../../src/services/database/ddl/ddl-mysql.ts";
import { DdlUnsupportedError, ddlScript, type DdlPlan } from "../../../../src/services/database/ddl/ddl-types.ts";
import { diffTableModels } from "../../../../src/services/database/ddl/table-diff.ts";
import {
  baseColumnId, blankColumn, columnById, removeColumns, removeItem, upsertColumn, type TableModel, type TableModelColumn,
} from "../../../../src/shared/db-table-model.ts";

const col = (name: string, type: string, extra: Partial<TableModelColumn> = {}): TableModelColumn => ({ ...blankColumn(baseColumnId(name), name), type, ...extra });

function table(name: string, columns: TableModelColumn[], extra: Partial<TableModel> = {}): TableModel {
  return {
    schema: "shop", name, columns, primaryKey: null, indexes: [], uniques: [], foreignKeys: [], checks: [], comment: null, engine: "InnoDB",
    withoutRowid: false, strict: false, ...extra,
  };
}

const MYSQL8: MysqlDdlContext = { mariadb: false, version: [8, 4, 2], references: [] };
const MYSQL57: MysqlDdlContext = { mariadb: false, version: [5, 7, 44], references: [] };

function alter(base: TableModel, edit: (m: TableModel) => TableModel, ctx = MYSQL8): DdlPlan {
  const current = edit(base);
  return mysqlAlterTable(base, current, diffTableModels(base, current), ctx);
}

const script = (plan: DdlPlan) => ddlScript(plan.statements);
const change = (m: TableModel, name: string, patch: Partial<TableModelColumn>) => upsertColumn(m, { ...columnById(m, baseColumnId(name))!, ...patch });
const pk = (...names: string[]) => ({ id: "pk", name: null, columns: names.map(baseColumnId) });

describe("MySQL DDL", () => {
  it("creates a table with every column said in full, then its indexes and foreign keys", () => {
    const plan = mysqlCreateTable(table("orders", [
      col("id", "int", { notNull: true, autoIncrement: true, unsigned: true }),
      col("code", "varchar(20)", { notNull: true, collation: "utf8mb4_bin", comment: "Order's code" }),
      col("qty", "int", { unsigned: true, zerofill: true, defaultValue: "1" }),
      col("updated", "timestamp", { defaultValue: "CURRENT_TIMESTAMP", onUpdate: "CURRENT_TIMESTAMP" }),
      col("total", "decimal(10,2)", { computedExpression: "qty * 2", computedStored: true }),
      col("body", "text"),
      col("user_id", "int"),
    ], {
      primaryKey: pk("id"),
      uniques: [{ id: "u", name: null, columns: ["c:code"] }],
      indexes: [
        { id: "ft", name: "", columns: [{ columnId: "c:body", expression: null, descending: false }], unique: false, method: "fulltext", where: null },
        { id: "px", name: "code_prefix", columns: [{ columnId: "c:code", expression: null, descending: true, length: 4 }], unique: false, method: null, where: null },
        { id: "hx", name: "qty_hash", columns: [{ columnId: "c:qty", expression: null, descending: false }], unique: false, method: "hash", where: null },
      ],
      foreignKeys: [{ id: "f", name: null, columns: ["c:user_id"], refSchema: null, refTable: "users", refColumns: ["id"], onUpdate: null, onDelete: "SET NULL" }],
      comment: "Orders",
    }));
    expect(script(plan)).toBe([
      "CREATE TABLE `shop`.`orders` (",
      "  `id` int unsigned NOT NULL AUTO_INCREMENT,",
      "  `code` varchar(20) COLLATE utf8mb4_bin NOT NULL COMMENT 'Order''s code',",
      "  `qty` int unsigned zerofill NULL DEFAULT 1,",
      "  `updated` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,",
      "  `total` decimal(10,2) GENERATED ALWAYS AS (qty * 2) STORED,",
      "  `body` text NULL,",
      "  `user_id` int NULL,",
      "  PRIMARY KEY (`id`),",
      "  CONSTRAINT `UQ_orders_code` UNIQUE (`code`)",
      ") ENGINE=InnoDB COMMENT='Orders';",
      "CREATE FULLTEXT INDEX `IX_orders_body` ON `shop`.`orders` (`body`);",
      "CREATE INDEX `code_prefix` ON `shop`.`orders` (`code`(4) DESC);",
      "CREATE INDEX `qty_hash` ON `shop`.`orders` (`qty`) USING HASH;",
      "ALTER TABLE `shop`.`orders` ADD CONSTRAINT `FK_orders_user_id` FOREIGN KEY (`user_id`) REFERENCES `shop`.`users` (`id`) ON DELETE SET NULL;",
    ].join("\n"));
  });

  it("restates a changed column whole, keeping what the editor does not show", () => {
    const base = table("t", [
      col("name", "varchar(20)", { collation: "utf8mb4_bin", comment: "Shown name" }),
      col("updated", "timestamp", { defaultValue: "CURRENT_TIMESTAMP", onUpdate: "CURRENT_TIMESTAMP" }),
    ]);
    expect(script(alter(base, (m) => change(change(m, "name", { type: "varchar(40)" }), "updated", { notNull: true })))).toBe([
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `name` `name` varchar(40) COLLATE utf8mb4_bin NULL COMMENT 'Shown name';",
      "UPDATE `shop`.`t` SET `updated` = CURRENT_TIMESTAMP WHERE `updated` IS NULL;",
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `updated` `updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;",
    ].join("\n"));
  });

  it("renames with RENAME COLUMN where the server has it, and with CHANGE COLUMN where it does not", () => {
    expect(mysqlHasRenameColumn({ mariadb: false, version: [8, 0, 0] })).toBe(true);
    expect(mysqlHasRenameColumn({ mariadb: false, version: [5, 7, 44] })).toBe(false);
    expect(mysqlHasRenameColumn({ mariadb: true, version: [10, 5, 2] })).toBe(true);
    expect(mysqlHasRenameColumn({ mariadb: true, version: [10, 5, 1] })).toBe(false);

    const base = table("t", [col("a", "int", { notNull: true }), col("b", "varchar(10)"), col("c", "int")]);
    const swap = (m: TableModel) => change(change(change(m, "a", { name: "b" }), "b", { name: "a" }), "c", { name: "d", type: "bigint" });
    expect(script(alter(base, swap))).toBe([
      "ALTER TABLE `shop`.`t` RENAME COLUMN `c` TO `d`;",
      "ALTER TABLE `shop`.`t` RENAME COLUMN `a` TO `__ppm_rename_1`;",
      "ALTER TABLE `shop`.`t` RENAME COLUMN `b` TO `a`;",
      "ALTER TABLE `shop`.`t` RENAME COLUMN `__ppm_rename_1` TO `b`;",
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `d` `d` bigint NULL;",
    ].join("\n"));
    // Each CHANGE COLUMN carries the definition of the column it moves.
    expect(script(alter(base, swap, MYSQL57))).toBe([
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `c` `d` bigint NULL;",
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `a` `__ppm_rename_1` int NOT NULL;",
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `b` `a` varchar(10) NULL;",
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `__ppm_rename_1` `b` int NOT NULL;",
    ].join("\n"));
  });

  it("takes AUTO_INCREMENT off before dropping its key, and puts it on after the key exists", () => {
    const counted = table("t", [col("id", "int", { notNull: true, autoIncrement: true })], { primaryKey: pk("id") });
    expect(script(alter(counted, (m) => removeItem(change(m, "id", { autoIncrement: false }), "primaryKey", "pk")))).toBe([
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `id` `id` int NOT NULL;",
      "ALTER TABLE `shop`.`t` DROP PRIMARY KEY;",
    ].join("\n"));
    const plain = table("t", [col("id", "int", { notNull: true })]);
    expect(script(alter(plain, (m) => ({ ...change(m, "id", { autoIncrement: true }), primaryKey: pk("id") })))).toBe([
      "ALTER TABLE `shop`.`t` ADD PRIMARY KEY (`id`);",
      "ALTER TABLE `shop`.`t` CHANGE COLUMN `id` `id` int NOT NULL AUTO_INCREMENT;",
    ].join("\n"));
  });

  it("swaps a primary key an AUTO_INCREMENT column needs in one statement, and any other in two", () => {
    const counted = table("t", [col("id", "int", { notNull: true, autoIncrement: true }), col("tenant", "int", { notNull: true })], { primaryKey: pk("id") });
    expect(script(alter(counted, (m) => ({ ...m, primaryKey: pk("id", "tenant") })))).toBe("ALTER TABLE `shop`.`t` DROP PRIMARY KEY, ADD PRIMARY KEY (`id`, `tenant`);");
    const plain = table("t", [col("id", "int", { notNull: true }), col("tenant", "int", { notNull: true })], { primaryKey: pk("id") });
    expect(script(alter(plain, (m) => ({ ...m, primaryKey: pk("id", "tenant") })))).toBe([
      "ALTER TABLE `shop`.`t` DROP PRIMARY KEY;",
      "ALTER TABLE `shop`.`t` ADD PRIMARY KEY (`id`, `tenant`);",
    ].join("\n"));
  });

  it("drops the foreign keys a removed column needs gone, its own and another table's", () => {
    const base = table("users", [col("id", "int"), col("legacy_id", "int"), col("org_id", "int")], {
      foreignKeys: [{ id: "fk:users_org", name: "users_org", columns: ["c:org_id"], refSchema: "shop", refTable: "orgs", refColumns: ["id"], onUpdate: null, onDelete: null }],
      uniques: [{ id: "uq:uq_legacy", name: "uq_legacy", columns: ["c:legacy_id"] }],
    });
    const plan = alter(base, (m) => removeColumns(m, ["c:legacy_id", "c:org_id"]), {
      ...MYSQL8,
      references: [{ name: "orders_legacy", schema: "shop", table: "orders", columns: ["u"], refSchema: "shop", refTable: "users", refColumns: ["legacy_id"], onDelete: "NO ACTION", onUpdate: "NO ACTION" }],
    });
    expect(script(plan)).toBe([
      "ALTER TABLE `shop`.`orders` DROP FOREIGN KEY `orders_legacy`;",
      "ALTER TABLE `shop`.`users` DROP FOREIGN KEY `users_org`;",
      "DROP INDEX `uq_legacy` ON `shop`.`users`;",
      "ALTER TABLE `shop`.`users` DROP COLUMN `legacy_id`;",
      "ALTER TABLE `shop`.`users` DROP COLUMN `org_id`;",
    ].join("\n"));
    expect(plan.warnings).toEqual(["Drops the foreign key orders_legacy of shop.orders, which points at a column this removes"]);
  });

  it("warns that a NOT NULL column with no default fills existing rows with zero values", () => {
    const plan = alter(table("t", [col("id", "int")]), (m) => upsertColumn(m, col("n", "int", { id: "n:1", notNull: true })));
    expect(script(plan)).toBe("ALTER TABLE `shop`.`t` ADD COLUMN `n` int NOT NULL;");
    expect(plan.warnings).toEqual(["n is NOT NULL with no default, so the rows t already has get the type's zero value"]);
  });

  it("changes the engine and the comment, and refuses an engine that is not a name", () => {
    const base = table("t", [col("id", "int")], { comment: "Old" });
    expect(script(alter(base, (m) => ({ ...m, engine: "MyISAM", comment: null })))).toBe([
      "ALTER TABLE `shop`.`t` ENGINE=MyISAM;",
      "ALTER TABLE `shop`.`t` COMMENT='';",
    ].join("\n"));
    expect(() => alter(base, (m) => ({ ...m, engine: "InnoDB; DROP TABLE t" }))).toThrow(DdlUnsupportedError);
    expect(() => mysqlCreateTable({ ...base, engine: "x y" })).toThrow("x y is not an engine name");
  });
});
