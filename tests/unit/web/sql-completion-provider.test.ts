import { describe, it, expect } from "bun:test";
import {
  extractTableRefs,
  resolveTable,
  getCompletionContext,
  SQL_KEYWORDS,
  SORT_DIRS,
  OPERATORS,
} from "../../../src/web/components/database/sql-completion-provider";

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
