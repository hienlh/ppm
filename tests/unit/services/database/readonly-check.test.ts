import { describe, it, expect } from "bun:test";
import { isReadOnlyQuery } from "../../../../src/services/database/readonly-check.ts";

describe("isReadOnlyQuery", () => {
  // ── Read-only (should return true) ─────────────────────────────────
  it("allows SELECT", () => {
    expect(isReadOnlyQuery("SELECT * FROM users")).toBe(true);
  });

  it("allows SELECT with leading whitespace", () => {
    expect(isReadOnlyQuery("  SELECT 1")).toBe(true);
  });

  it("allows EXPLAIN", () => {
    expect(isReadOnlyQuery("EXPLAIN SELECT * FROM users")).toBe(true);
  });

  it("allows SHOW", () => {
    expect(isReadOnlyQuery("SHOW TABLES")).toBe(true);
  });

  it("allows PRAGMA", () => {
    expect(isReadOnlyQuery("PRAGMA table_info('users')")).toBe(true);
  });

  it("allows DESCRIBE", () => {
    expect(isReadOnlyQuery("DESCRIBE users")).toBe(true);
  });

  it("allows WITH ... SELECT (plain CTE)", () => {
    expect(isReadOnlyQuery("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(true);
  });

  // ── Write (should return false) ────────────────────────────────────
  it("blocks INSERT", () => {
    expect(isReadOnlyQuery("INSERT INTO users (name) VALUES ('a')")).toBe(false);
  });

  it("blocks UPDATE", () => {
    expect(isReadOnlyQuery("UPDATE users SET name = 'b' WHERE id = 1")).toBe(false);
  });

  it("blocks DELETE", () => {
    expect(isReadOnlyQuery("DELETE FROM users WHERE id = 1")).toBe(false);
  });

  it("blocks DROP", () => {
    expect(isReadOnlyQuery("DROP TABLE users")).toBe(false);
  });

  it("blocks CREATE", () => {
    expect(isReadOnlyQuery("CREATE TABLE foo (id INTEGER)")).toBe(false);
  });

  it("blocks ALTER", () => {
    expect(isReadOnlyQuery("ALTER TABLE users ADD COLUMN age INTEGER")).toBe(false);
  });

  it("blocks TRUNCATE", () => {
    expect(isReadOnlyQuery("TRUNCATE TABLE users")).toBe(false);
  });

  it("blocks REPLACE", () => {
    expect(isReadOnlyQuery("REPLACE INTO users (id, name) VALUES (1, 'a')")).toBe(false);
  });

  it("blocks MERGE", () => {
    expect(isReadOnlyQuery("MERGE INTO target USING source ON ...")).toBe(false);
  });

  // ── CTE attack patterns ────────────────────────────────────────────
  it("blocks CTE with DELETE", () => {
    expect(isReadOnlyQuery("WITH x AS (DELETE FROM users) SELECT * FROM x")).toBe(false);
  });

  it("blocks CTE with INSERT", () => {
    expect(isReadOnlyQuery("WITH x AS (INSERT INTO users VALUES (1)) SELECT 1")).toBe(false);
  });

  // ── Case insensitivity ─────────────────────────────────────────────
  it("is case-insensitive for keywords", () => {
    expect(isReadOnlyQuery("select * from users")).toBe(true);
    expect(isReadOnlyQuery("insert into users values (1)")).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────────────
  it("rejects empty string", () => {
    expect(isReadOnlyQuery("")).toBe(false);
  });

  it("rejects random text", () => {
    expect(isReadOnlyQuery("hello world")).toBe(false);
  });
});
