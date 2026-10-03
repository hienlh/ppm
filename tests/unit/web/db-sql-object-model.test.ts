/**
 * What the SQL tab offers for one object — its CREATE under the name of what it is, then the
 * SELECT and INSERT a table has — and the request that asks the server for them.
 */
import { describe, expect, it } from "bun:test";
import { objectSqlPath, scriptChoices } from "../../../src/web/components/database/sql-object/sql-object-model.ts";

describe("the scripts a SQL tab offers", () => {
  it("are a table's CREATE, SELECT and INSERT, in DBGate's order", () => {
    expect(scriptChoices("table", { kind: "table", create: "CREATE TABLE t (id int);", select: "SELECT * FROM t;", insert: "INSERT INTO t (id) VALUES (1);" }))
      .toEqual([
        { kind: "create", label: "CREATE TABLE", sql: "CREATE TABLE t (id int);" },
        { kind: "select", label: "SELECT", sql: "SELECT * FROM t;" },
        { kind: "insert", label: "INSERT", sql: "INSERT INTO t (id) VALUES (1);" },
      ]);
  });

  it("name the CREATE after what the object is", () => {
    const labels = (["view", "matview", "function", "procedure", "trigger", "sequence"] as const)
      .map((kind) => scriptChoices(kind, { kind, create: "x" })[0]!.label);
    expect(labels).toEqual(["CREATE VIEW", "CREATE MATERIALIZED VIEW", "CREATE FUNCTION", "CREATE PROCEDURE", "CREATE TRIGGER", "CREATE SEQUENCE"]);
  });

  it("are only what the server sent, and nothing before it answers", () => {
    expect(scriptChoices("view", { kind: "view", create: "CREATE VIEW v AS SELECT 1;", select: "SELECT * FROM v;" }).map((c) => c.kind))
      .toEqual(["create", "select"]);
    expect(scriptChoices("function", { kind: "function", create: "CREATE FUNCTION f() …" }).map((c) => c.kind)).toEqual(["create"]);
    // An empty script is still one the server sent.
    expect(scriptChoices("table", { kind: "table", create: "", select: "" }).map((c) => c.kind)).toEqual(["create", "select"]);
    expect(scriptChoices("table", null)).toEqual([]);
  });
});

describe("the request for them", () => {
  it("names the object, encoded, with its schema when it has one", () => {
    expect(objectSqlPath({ kind: "table", schema: "public", name: "order items" })).toBe("/object-sql?kind=table&name=order%20items&schema=public");
    expect(objectSqlPath({ kind: "table", schema: null, name: "users" })).toBe("/object-sql?kind=table&name=users");
    expect(objectSqlPath({ kind: "view", schema: "", name: "v&w" })).toBe("/object-sql?kind=view&name=v%26w");
  });

  it("sends a routine's argument list even when it is empty — that is one overload too", () => {
    expect(objectSqlPath({ kind: "function", schema: "public", name: "f", args: "" })).toBe("/object-sql?kind=function&name=f&schema=public&args=");
    expect(objectSqlPath({ kind: "function", schema: "public", name: "f", args: "a integer, b text" }))
      .toBe("/object-sql?kind=function&name=f&schema=public&args=a%20integer%2C%20b%20text");
    expect(objectSqlPath({ kind: "function", schema: "public", name: "f" })).toBe("/object-sql?kind=function&name=f&schema=public");
  });

  it("says which table a trigger is on", () => {
    expect(objectSqlPath({ kind: "trigger", schema: "main", name: "t", table: "orders" })).toBe("/object-sql?kind=trigger&name=t&schema=main&table=orders");
  });
});
