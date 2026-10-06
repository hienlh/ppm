import { describe, it, expect } from "bun:test";
import {
  columnInsertText,
  createSqlCompletionProvider,
  DIALECT_KEYWORDS,
  extractTableRefs,
  resolveTable,
  getCompletionContext,
  schemaForTable,
  sqlKeywords,
  sqlOperators,
  SQL_KEYWORDS,
  SORT_DIRS,
  OPERATORS,
  type SchemaInfo,
} from "../../../src/web/components/database/sql-completion-provider";
import type { DialectName } from "../../../src/shared/db-types";

// ── extractTableRefs ─────────────────────────────────────────────

describe("extractTableRefs", () => {
  it("extracts table from simple SELECT", () => {
    const { tableRefs } = extractTableRefs("SELECT * FROM users");
    expect(tableRefs.has("users")).toBe(true);
    expect(tableRefs.size).toBe(1);
  });

  it("extracts table from quoted name", () => {
    const { tableRefs } = extractTableRefs('SELECT * FROM "Users"');
    expect(tableRefs.has("Users")).toBe(true);
  });

  it("extracts multiple tables from JOINs", () => {
    const { tableRefs } = extractTableRefs(
      "SELECT * FROM users JOIN orders ON users.id = orders.user_id LEFT JOIN products ON orders.product_id = products.id"
    );
    expect(tableRefs.has("users")).toBe(true);
    expect(tableRefs.has("orders")).toBe(true);
    expect(tableRefs.has("products")).toBe(true);
    expect(tableRefs.size).toBe(3);
  });

  it("extracts alias mappings", () => {
    const { tableRefs, aliasMap } = extractTableRefs("SELECT * FROM users u JOIN orders o ON u.id = o.user_id");
    expect(tableRefs.has("users")).toBe(true);
    expect(tableRefs.has("orders")).toBe(true);
    expect(aliasMap.get("u")).toBe("users");
    expect(aliasMap.get("o")).toBe("orders");
  });

  it("extracts alias with AS keyword", () => {
    const { aliasMap } = extractTableRefs("SELECT * FROM users AS u");
    expect(aliasMap.get("u")).toBe("users");
  });

  it("skips keyword-like aliases (WHERE, SET, etc.)", () => {
    const { aliasMap } = extractTableRefs("SELECT * FROM users WHERE id = 1");
    expect(aliasMap.has("where")).toBe(false);
  });

  it("extracts from UPDATE statement", () => {
    const { tableRefs } = extractTableRefs("UPDATE users SET name = 'foo'");
    expect(tableRefs.has("users")).toBe(true);
  });

  it("extracts from INSERT INTO", () => {
    const { tableRefs } = extractTableRefs("INSERT INTO logs (msg) VALUES ('test')");
    expect(tableRefs.has("logs")).toBe(true);
  });

  it("returns empty for no table references", () => {
    const { tableRefs, aliasMap } = extractTableRefs("SELECT 1 + 1");
    expect(tableRefs.size).toBe(0);
    expect(aliasMap.size).toBe(0);
  });

  it("is case insensitive for keywords", () => {
    const { tableRefs } = extractTableRefs("select * from users join orders on 1=1");
    expect(tableRefs.has("users")).toBe(true);
    expect(tableRefs.has("orders")).toBe(true);
  });
});

// ── resolveTable ─────────────────────────────────────────────────

describe("resolveTable", () => {
  it("resolves alias to real table", () => {
    const aliasMap = new Map([["u", "users"], ["o", "orders"]]);
    expect(resolveTable("u", aliasMap)).toBe("users");
    expect(resolveTable("o", aliasMap)).toBe("orders");
  });

  it("returns original name if not an alias", () => {
    const aliasMap = new Map([["u", "users"]]);
    expect(resolveTable("orders", aliasMap)).toBe("orders");
  });

  it("is case insensitive for alias lookup", () => {
    const aliasMap = new Map([["u", "users"]]);
    expect(resolveTable("U", aliasMap)).toBe("users");
  });
});

// ── getCompletionContext ─────────────────────────────────────────

describe("getCompletionContext", () => {
  // dot context
  it("returns 'dot' after table.prefix", () => {
    expect(getCompletionContext("SELECT u.")).toBe("dot");
    expect(getCompletionContext("SELECT users.")).toBe("dot");
  });

  it("returns 'dot' after alias dot with partial word", () => {
    // After "u." cursor is right after dot — word match is empty
    expect(getCompletionContext("SELECT u.")).toBe("dot");
  });

  // table context
  it("returns 'table' after FROM", () => {
    expect(getCompletionContext("SELECT * FROM ")).toBe("table");
    expect(getCompletionContext("SELECT * FROM u")).toBe("table");
  });

  it("returns 'table' after JOIN", () => {
    expect(getCompletionContext("SELECT * FROM users JOIN ")).toBe("table");
    expect(getCompletionContext("SELECT * FROM users LEFT JOIN o")).toBe("table");
  });

  it("returns 'table' after INTO", () => {
    expect(getCompletionContext("INSERT INTO ")).toBe("table");
  });

  it("returns 'table' after UPDATE", () => {
    expect(getCompletionContext("UPDATE ")).toBe("table");
    expect(getCompletionContext("UPDATE u")).toBe("table");
  });

  it("returns 'table' after TABLE", () => {
    expect(getCompletionContext("CREATE TABLE ")).toBe("table");
  });

  // columns context
  it("returns 'columns' after SELECT", () => {
    expect(getCompletionContext("SELECT ")).toBe("columns");
    expect(getCompletionContext("SELECT n")).toBe("columns");
  });

  it("returns 'columns' after SELECT col,", () => {
    expect(getCompletionContext("SELECT id, ")).toBe("columns");
    expect(getCompletionContext("SELECT id, n")).toBe("columns");
  });

  it("returns 'columns' after WHERE", () => {
    expect(getCompletionContext("SELECT * FROM users WHERE ")).toBe("columns");
    expect(getCompletionContext("SELECT * FROM users WHERE n")).toBe("columns");
  });

  it("returns 'columns' after AND", () => {
    expect(getCompletionContext("SELECT * FROM users WHERE id = 1 AND ")).toBe("columns");
  });

  it("returns 'columns' after OR", () => {
    expect(getCompletionContext("SELECT * FROM users WHERE id = 1 OR n")).toBe("columns");
  });

  it("returns 'columns' after ORDER BY", () => {
    expect(getCompletionContext("SELECT * FROM users ORDER BY ")).toBe("columns");
    expect(getCompletionContext("SELECT * FROM users ORDER BY n")).toBe("columns");
  });

  it("returns 'columns' after GROUP BY", () => {
    expect(getCompletionContext("SELECT * FROM users GROUP BY ")).toBe("columns");
  });

  it("returns 'columns' after SET", () => {
    expect(getCompletionContext("UPDATE users SET ")).toBe("columns");
    expect(getCompletionContext("UPDATE users SET n")).toBe("columns");
  });

  it("returns 'columns' after ON", () => {
    expect(getCompletionContext("SELECT * FROM users JOIN orders ON ")).toBe("columns");
  });

  it("returns 'columns' after HAVING", () => {
    expect(getCompletionContext("SELECT * FROM users GROUP BY id HAVING ")).toBe("columns");
  });

  // sort direction context
  it("returns 'sort-direction' after ORDER BY col", () => {
    expect(getCompletionContext("SELECT * FROM users ORDER BY name ")).toBe("sort-direction");
  });

  it("returns 'sort-direction' after ORDER BY col with partial", () => {
    expect(getCompletionContext("SELECT * FROM users ORDER BY name A")).toBe("sort-direction");
  });

  it("returns 'sort-direction' after ORDER BY quoted col", () => {
    expect(getCompletionContext('SELECT * FROM users ORDER BY "name" ')).toBe("sort-direction");
  });

  it("returns 'after-direction' when ASC/DESC already typed", () => {
    expect(getCompletionContext("SELECT * FROM users ORDER BY name ASC")).toBe("after-direction");
    expect(getCompletionContext("SELECT * FROM users ORDER BY name DESC")).toBe("after-direction");
  });

  // order-by-next-col
  it("returns 'order-by-next-col' after ORDER BY col ASC,", () => {
    expect(getCompletionContext("SELECT * FROM users ORDER BY name ASC, ")).toBe("order-by-next-col");
    expect(getCompletionContext("SELECT * FROM users ORDER BY name DESC, n")).toBe("order-by-next-col");
  });

  // operator context
  it("returns 'operator' after WHERE col", () => {
    expect(getCompletionContext("SELECT * FROM users WHERE id ")).toBe("operator");
    expect(getCompletionContext("SELECT * FROM users WHERE id >")).toBe("operator");
  });

  it("returns 'operator' after AND col", () => {
    expect(getCompletionContext("SELECT * FROM users WHERE id = 1 AND name ")).toBe("operator");
  });

  it("returns 'operator' after OR col", () => {
    expect(getCompletionContext("SELECT * FROM users WHERE id = 1 OR name L")).toBe("operator");
  });

  // insert columns
  it("returns 'insert-cols' after INSERT INTO table (", () => {
    expect(getCompletionContext("INSERT INTO users (")).toBe("insert-cols");
    expect(getCompletionContext("INSERT INTO users (id, ")).toBe("insert-cols");
    expect(getCompletionContext("INSERT INTO users (id, n")).toBe("insert-cols");
  });

  // comma columns
  it("returns 'comma-cols' after generic comma", () => {
    // Comma that doesn't match any other pattern
    expect(getCompletionContext("some_context, ")).toBe("comma-cols");
  });

  // default
  it("returns 'default' for empty input", () => {
    expect(getCompletionContext("")).toBe("default");
  });

  it("returns 'default' for bare keyword start", () => {
    expect(getCompletionContext("S")).toBe("default");
    expect(getCompletionContext("CR")).toBe("default");
  });
});

// ── SQL_KEYWORDS, SORT_DIRS, OPERATORS ───────────────────────────

describe("constants", () => {
  it("SQL_KEYWORDS contains essential keywords", () => {
    expect(SQL_KEYWORDS).toContain("SELECT");
    expect(SQL_KEYWORDS).toContain("FROM");
    expect(SQL_KEYWORDS).toContain("WHERE");
    expect(SQL_KEYWORDS).toContain("ORDER BY");
    expect(SQL_KEYWORDS).toContain("GROUP BY");
    expect(SQL_KEYWORDS).toContain("LEFT JOIN");
  });

  it("SORT_DIRS has ASC and DESC", () => {
    expect(SORT_DIRS).toEqual(["ASC", "DESC"]);
  });

  it("OPERATORS contains comparison operators", () => {
    expect(OPERATORS).toContain("=");
    expect(OPERATORS).toContain("!=");
    expect(OPERATORS).toContain("LIKE");
    expect(OPERATORS).toContain("IS NULL");
    expect(OPERATORS).toContain("IS NOT NULL");
  });
});

// ── MySQL ────────────────────────────────────────────────────────

describe("MySQL identifiers", () => {
  it("finds tables written in backticks", () => {
    const { tableRefs, aliasMap } = extractTableRefs("SELECT * FROM `users` u JOIN `orders` ON u.id = orders.user_id");
    expect([...tableRefs]).toEqual(["users", "orders"]);
    expect(aliasMap.get("u")).toBe("users");
  });

  it("reads the context after a backticked column", () => {
    expect(getCompletionContext("SELECT * FROM `t` WHERE `name` ")).toBe("operator");
    expect(getCompletionContext("SELECT * FROM `t` ORDER BY `name` ")).toBe("sort-direction");
    expect(getCompletionContext("INSERT INTO `t` (`a`, ")).toBe("insert-cols");
  });

  it("never offers a double-quoted column, which MySQL reads as a string", () => {
    expect(columnInsertText("UserName", "mysql")).toBe("UserName");
    expect(columnInsertText("order date", "mysql")).toBe("`order date`");
    expect(columnInsertText("a`b", "mysql")).toBe("`a``b`");
  });

  it("still quotes a capitalised column on Postgres, which folds unquoted names", () => {
    expect(columnInsertText("UserName", "postgres")).toBe('"UserName"');
    expect(columnInsertText("user_name", "postgres")).toBe("user_name");
  });
});

// ── Aliases and schemas ──────────────────────────────────────────

describe("aliases", () => {
  it("gives every table in a FROM list its alias", () => {
    const { tableRefs, aliasMap } = extractTableRefs("SELECT * FROM users u, orders AS o,items WHERE o.id = 1");
    expect([...tableRefs]).toEqual(["users", "orders", "items"]);
    expect([...aliasMap]).toEqual([["u", "users"], ["o", "orders"]]);
  });

  it("reads a table written with its schema, and remembers the schema", () => {
    const { tableRefs, aliasMap, schemaOf } = extractTableRefs("SELECT * FROM public.users u JOIN sales . orders AS o ON o.user_id = u.id");
    expect([...tableRefs]).toEqual(["users", "orders"]);
    expect([...aliasMap]).toEqual([["u", "users"], ["o", "orders"]]);
    expect([...schemaOf]).toEqual([["users", "public"], ["orders", "sales"]]);
  });

  it("reads quoted names whole, spaces and all, and a quoted alias", () => {
    const { tableRefs, aliasMap, schemaOf } = extractTableRefs('SELECT * FROM "Order Items" oi JOIN `shop`.`orders` AS `O` ON 1 = 1');
    expect([...tableRefs]).toEqual(["Order Items", "orders"]);
    expect([...aliasMap]).toEqual([["oi", "Order Items"], ["o", "orders"]]);
    expect(schemaOf.get("orders")).toBe("shop");
  });

  it("takes no keyword after a table for its alias", () => {
    const sql = "SELECT * FROM users JOIN orders USING (id) NATURAL JOIN items FORCE INDEX (x) WHERE 1 = 1";
    expect([...extractTableRefs(sql).aliasMap]).toEqual([]);
    expect([...extractTableRefs("UPDATE users SET a = 1 RETURNING id").aliasMap]).toEqual([]);
    expect([...extractTableRefs("DELETE FROM users RETURNING id").aliasMap]).toEqual([]);
    expect([...extractTableRefs("SELECT * FROM users NATURAL JOIN orders").aliasMap]).toEqual([]);
    expect([...extractTableRefs("INSERT INTO users DEFAULT VALUES").aliasMap]).toEqual([]);
  });

  it("reads MySQL's UPDATE of several tables as a list too", () => {
    const { tableRefs, aliasMap } = extractTableRefs("UPDATE users u, orders o SET o.total = 0 WHERE o.user_id = u.id");
    expect([...tableRefs]).toEqual(["users", "orders"]);
    expect([...aliasMap]).toEqual([["u", "users"], ["o", "orders"]]);
  });

  it("does not read a list after INSERT INTO, where a comma is a column's", () => {
    expect([...extractTableRefs("INSERT INTO logs (a, b) VALUES (1, 2)").tableRefs]).toEqual(["logs"]);
    expect([...extractTableRefs("INSERT INTO logs, b VALUES (1)").tableRefs]).toEqual(["logs"]);
  });
});

describe("schemaForTable", () => {
  const info = (tables: { name: string; schema: string }[]): SchemaInfo => ({ tables, getColumns: async () => [] });

  it("is the schema written before the table, first", () => {
    const written = new Map([["orders", "archive"]]);
    expect(schemaForTable("Orders", written, info([{ name: "orders", schema: "sales" }]))).toBe("archive");
  });

  it("is the only schema with a table by that name, which Postgres would not look in unasked", () => {
    expect(schemaForTable("ORDERS", new Map(), info([{ name: "orders", schema: "sales" }, { name: "users", schema: "public" }]))).toBe("sales");
  });

  it("is the connection's own when two schemas have the table, or the engine has no schemas", () => {
    expect(schemaForTable("orders", new Map(), info([{ name: "orders", schema: "sales" }, { name: "orders", schema: "public" }]))).toBeUndefined();
    expect(schemaForTable("orders", new Map(), info([{ name: "orders", schema: "" }]))).toBeUndefined();
    expect(schemaForTable("ghost", new Map(), info([]))).toBeUndefined();
  });
});

// ── Keywords by engine ───────────────────────────────────────────

describe("keywords and operators by engine", () => {
  const only: Record<DialectName, string[]> = {
    postgres: ["RETURNING", "ILIKE", "FULL OUTER JOIN", "DISTINCT ON", "ON CONFLICT"],
    mysql: ["ON DUPLICATE KEY UPDATE", "AUTO_INCREMENT", "SHOW TABLES", "REPLACE INTO"],
    sqlite: ["PRAGMA", "AUTOINCREMENT", "WITHOUT ROWID", "INSERT OR REPLACE"],
  };

  it("offers each engine its own keywords besides the common ones", () => {
    for (const d of ["postgres", "mysql", "sqlite"] as const) {
      const offered = sqlKeywords(d);
      for (const kw of SQL_KEYWORDS) expect(offered).toContain(kw);
      for (const kw of only[d]) expect([d, offered.includes(kw)]).toEqual([d, true]);
    }
  });

  it("offers no engine a keyword it does not have", () => {
    expect(sqlKeywords("mysql")).not.toContain("RETURNING");
    expect(sqlKeywords("mysql")).not.toContain("FULL OUTER JOIN");
    expect(sqlKeywords("mysql")).not.toContain("ILIKE");
    expect(sqlKeywords("postgres")).not.toContain("ON DUPLICATE KEY UPDATE");
    expect(sqlKeywords("postgres")).not.toContain("PRAGMA");
    expect(sqlKeywords("sqlite")).not.toContain("AUTO_INCREMENT");
    expect(SQL_KEYWORDS).not.toContain("FULL OUTER JOIN");
  });

  it("lists no keyword twice for one engine", () => {
    for (const d of ["postgres", "mysql", "sqlite"] as const) {
      expect(new Set(sqlKeywords(d)).size).toBe(sqlKeywords(d).length);
      expect(new Set(DIALECT_KEYWORDS[d]).size).toBe(DIALECT_KEYWORDS[d].length);
    }
  });

  it("offers ILIKE on Postgres only, REGEXP on MySQL and GLOB on SQLite", () => {
    expect(OPERATORS).not.toContain("ILIKE");
    expect(sqlOperators("postgres")).toContain("ILIKE");
    expect(sqlOperators("mysql")).not.toContain("ILIKE");
    expect(sqlOperators("mysql")).toContain("REGEXP");
    expect(sqlOperators("sqlite")).toContain("GLOB");
    expect(sqlOperators("sqlite")).not.toContain("REGEXP");
  });
});

// ── The provider, against a model ────────────────────────────────

describe("what the editor is offered", () => {
  const monaco = {
    languages: {
      CompletionItemKind: { Field: 3, Keyword: 17, Operator: 11, Struct: 22, Value: 12, Function: 1 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
  } as never;
  const COLUMNS: Record<string, string[]> = {
    "public.users": ["id", "email"],
    "sales.orders": ["id", "user_id", "total"],
    "archive.orders": ["id", "closed_at"],
  };
  let asked: string[] = [];
  const schemaInfo = (): SchemaInfo => ({
    tables: [{ name: "users", schema: "public" }, { name: "orders", schema: "sales" }],
    getColumns: async (table, schema) => {
      asked.push(`${schema ?? "-"}.${table}`);
      return (COLUMNS[`${schema}.${table}`] ?? []).map((name) => ({ name, type: "text" }));
    },
  });
  /** What the provider offers on one line of SQL, with the cursor at `|` — or at its end. */
  async function offered(sql: string, dialect: DialectName = "postgres", info = schemaInfo()) {
    const text = sql.replace("|", "");
    const cursor = sql.includes("|") ? sql.indexOf("|") : text.length;
    const model = {
      getValue: () => text,
      getValueInRange: (r: { endColumn: number }) => text.slice(0, r.endColumn - 1),
      getWordUntilPosition: (p: { column: number }) => {
        const word = /\w*$/.exec(text.slice(0, p.column - 1))![0];
        return { word, startColumn: p.column - word.length, endColumn: p.column };
      },
    };
    const provider = createSqlCompletionProvider(monaco, info, () => dialect, { getModel: () => model as never });
    const list = await provider.provideCompletionItems(model as never, { lineNumber: 1, column: cursor + 1 } as never, {} as never, {} as never);
    return (list as { suggestions: { label: string }[] }).suggestions.map((s) => s.label);
  }

  it("completes an alias with its table's columns, read from the table's schema", async () => {
    asked = [];
    expect(await offered("SELECT * FROM users u WHERE u.")).toEqual(["id", "email"]);
    expect(await offered("SELECT * FROM users u JOIN orders AS o ON o.")).toEqual(["id", "user_id", "total"]);
    // orders is only in sales, which Postgres would not have looked in.
    expect(asked).toEqual(["public.users", "sales.orders"]);
  });

  it("completes an alias the statement names after the cursor", async () => {
    expect(await offered("SELECT u.| FROM users u")).toEqual(["id", "email"]);
    expect(await offered("SELECT o.|, u.email FROM users u JOIN sales.orders o ON o.user_id = u.id")).toEqual(["id", "user_id", "total"]);
  });

  it("keeps the columns of two schemas' tables of one name apart", async () => {
    const info = schemaInfo();
    expect(await offered("SELECT * FROM sales.orders o WHERE o.", "postgres", info)).toEqual(["id", "user_id", "total"]);
    expect(await offered("SELECT * FROM archive.orders a WHERE a.", "postgres", info)).toEqual(["id", "closed_at"]);
  });

  it("completes an alias from a FROM list", async () => {
    expect(await offered("SELECT * FROM users u, orders o WHERE o.")).toEqual(["id", "user_id", "total"]);
  });

  it("offers the columns of every table read, once each, after SELECT and WHERE", async () => {
    const select = await offered("SELECT | FROM users u JOIN orders o ON o.user_id = u.id");
    expect(select.slice(0, 6)).toEqual(["id", "email", "user_id", "total", "*", "COUNT()"]);
    const where = await offered("SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE ");
    expect(where.slice(0, 4)).toEqual(["id", "email", "user_id", "total"]);
  });

  it("offers each engine its own keywords", async () => {
    const mysql = await offered("", "mysql");
    expect(mysql).toContain("ON DUPLICATE KEY UPDATE");
    expect(mysql).not.toContain("RETURNING");
    const postgres = await offered("", "postgres");
    expect(postgres).toContain("RETURNING");
    expect(postgres).not.toContain("ON DUPLICATE KEY UPDATE");
    expect(await offered("SELECT * FROM users WHERE ", "sqlite")).toContain("PRAGMA");
  });

  it("offers each engine its own comparisons", async () => {
    expect(await offered("SELECT * FROM users WHERE email ", "postgres")).toContain("ILIKE");
    const mysql = await offered("SELECT * FROM users WHERE email ", "mysql");
    expect(mysql).toContain("REGEXP");
    expect(mysql).not.toContain("ILIKE");
  });
});
