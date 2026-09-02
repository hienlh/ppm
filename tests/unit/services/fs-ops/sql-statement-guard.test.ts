import { describe, it, expect } from "bun:test";
import {
  assertNoAttachStatement,
  hasAttachStatement,
  stripSqlNoise,
} from "../../../../src/services/fs-ops/sql-statement-guard.ts";

describe("hasAttachStatement", () => {
  it("catches a plain ATTACH", () => {
    expect(hasAttachStatement("ATTACH DATABASE '/tmp/x.db' AS p")).toBe(true);
  });

  it("catches lower case and leading whitespace", () => {
    expect(hasAttachStatement("\n  attach database '/tmp/x.db' as p")).toBe(true);
  });

  it("catches DETACH", () => {
    expect(hasAttachStatement("DETACH DATABASE p")).toBe(true);
  });

  it("catches an ATTACH hidden behind a leading statement", () => {
    expect(hasAttachStatement("SELECT 1; ATTACH DATABASE '/tmp/x.db' AS p")).toBe(true);
  });

  it("catches an ATTACH hidden behind a block comment", () => {
    expect(hasAttachStatement("/* harmless */ATTACH DATABASE '/tmp/x.db' AS p")).toBe(true);
  });

  it("catches an ATTACH hidden behind a line comment", () => {
    expect(hasAttachStatement("-- note\nATTACH DATABASE '/tmp/x.db' AS p")).toBe(true);
  });

  it("does not fire on the word inside a string literal", () => {
    expect(hasAttachStatement("SELECT 'attach' AS label")).toBe(false);
  });

  it("does not fire on a quoted identifier", () => {
    expect(hasAttachStatement('SELECT "attach" FROM notes')).toBe(false);
  });

  it("does not fire on a column named like the keyword", () => {
    expect(hasAttachStatement("SELECT attachment FROM mail")).toBe(false);
  });

  it("leaves ordinary statements alone", () => {
    expect(hasAttachStatement("SELECT * FROM notes WHERE body LIKE '%a%'")).toBe(false);
  });
});

describe("stripSqlNoise", () => {
  it("removes comments and literals but keeps keywords", () => {
    const out = stripSqlNoise("SELECT /* c */ 'text' , \"ident\" -- tail\nFROM t");
    expect(out).toContain("SELECT");
    expect(out).toContain("FROM t");
    expect(out).not.toContain("text");
    expect(out).not.toContain("tail");
  });

  it("handles a doubled quote inside a literal", () => {
    expect(stripSqlNoise("SELECT 'it''s attach' , 1")).not.toContain("attach");
  });
});

describe("assertNoAttachStatement", () => {
  it("throws 400 EINVAL for ATTACH", () => {
    expect(() => assertNoAttachStatement("ATTACH DATABASE '/tmp/x.db' AS p")).toThrow(
      "ATTACH and DETACH are not allowed",
    );
  });

  it("passes a normal SELECT", () => {
    expect(() => assertNoAttachStatement("SELECT 1")).not.toThrow();
  });
});
