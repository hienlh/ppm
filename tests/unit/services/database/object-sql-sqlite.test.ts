/**
 * The SQL tab's CREATE for SQLite: run on an empty database, the scripts of every object must
 * give back the same structure — keys both ways, generated columns, checks, indexes, the view
 * and the trigger.
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteGetStructure, sqliteListObjects } from "../../../../src/services/database/analyser-sqlite.ts";
import { sqliteObjectSql } from "../../../../src/services/database/object-sql-sqlite.ts";

const SCHEMA = `
  CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, region TEXT DEFAULT 'eu');
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    org_id INTEGER REFERENCES orgs (id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    price REAL, qty INTEGER,
    total REAL GENERATED ALWAYS AS (price * qty) STORED,
    CONSTRAINT email_shape CHECK (email LIKE '%@%')
  );
  CREATE TABLE tags (org_id INTEGER, tag TEXT, PRIMARY KEY (org_id, tag)) WITHOUT ROWID;
  CREATE INDEX users_email ON users (lower(email));
  CREATE UNIQUE INDEX users_org_email ON users (org_id, email) WHERE org_id IS NOT NULL;
  CREATE VIEW big_orders AS SELECT id, total FROM users WHERE total > 100;
  CREATE TRIGGER users_touch AFTER UPDATE ON users BEGIN UPDATE orgs SET name = name WHERE id = NEW.org_id; END;
`;

describe("sqliteObjectSql", () => {
  it("gives scripts that build the same database again on an empty one", () => {
    const source = new Database(":memory:");
    source.exec(SCHEMA);
    const objects = sqliteListObjects(source).objects;
    const scripts = new Map(objects.map((o) => [`${o.kind}:${o.name}`, sqliteObjectSql(source, o)]));
    for (const [key, sql] of scripts) expect(sql, key).toBeString();

    const target = new Database(":memory:");
    for (const kind of ["table", "view", "trigger"]) {
      for (const o of objects.filter((x) => x.kind === kind)) target.exec(scripts.get(`${o.kind}:${o.name}`)!);
    }
    expect(sqliteListObjects(target)).toEqual(sqliteListObjects(source));
    for (const o of objects.filter((x) => x.kind === "table" || x.kind === "view")) {
      expect(sqliteGetStructure(target, o.name), o.name).toEqual(sqliteGetStructure(source, o.name));
    }
  });

  it("writes a table with the indexes created on it, and leaves out those SQLite made for a key", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    expect(sqliteObjectSql(db, { schema: null, name: "USERS", kind: "table" })!.split("\n").filter((l) => l.startsWith("CREATE INDEX") || l.startsWith("CREATE UNIQUE INDEX")))
      .toEqual([
        "CREATE INDEX users_email ON users (lower(email));",
        "CREATE UNIQUE INDEX users_org_email ON users (org_id, email) WHERE org_id IS NOT NULL;",
      ]);
    expect(sqliteObjectSql(db, { schema: null, name: "orgs", kind: "table" })).toBe(
      "CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, region TEXT DEFAULT 'eu');",
    );
  });

  it("answers null for what the file does not hold, or SQLite has no such thing as", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    expect(sqliteObjectSql(db, { schema: null, name: "nope", kind: "table" })).toBeNull();
    expect(sqliteObjectSql(db, { schema: null, name: "big_orders", kind: "table" })).toBeNull();
    expect(sqliteObjectSql(db, { schema: null, name: "f", kind: "function" })).toBeNull();
  });
});
