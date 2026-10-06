import { describe, expect, test } from "bun:test";
import type { ColumnKind } from "../../../src/shared/db-column-kind.ts";
import { FILTER_MAX_IN_VALUES, type FilterCondition } from "../../../src/shared/db-grid.ts";
import { parseAnyColumnFilter, parseFilter } from "../../../src/shared/db-filter-parser.ts";

function read(text: string, kind: ColumnKind, now?: Date): FilterCondition[][] {
  const r = parseFilter(text, kind, now);
  if (!r.ok) throw new Error(`${JSON.stringify(text)} on ${kind}: ${r.error.message}`);
  return r.anyOf;
}

function wrong(text: string, kind: ColumnKind, now?: Date) {
  const r = parseFilter(text, kind, now);
  if (r.ok) throw new Error(`${JSON.stringify(text)} on ${kind} was read as ${JSON.stringify(r.anyOf)}`);
  return r.error;
}

/** The marked part of the text an error points at. */
function marked(text: string, kind: ColumnKind): string {
  const e = wrong(text, kind);
  return text.slice(e.start, e.end);
}

/**
 * bun test forces UTC, where an offset of +00:00 hides a parser that never
 * looks at the zone. The variable is assigned back, never deleted: after a
 * delete Bun ignores every later assignment for the rest of the process.
 */
function inZone<T>(zone: string, fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    process.env.TZ = saved ?? "UTC";
  }
}

const range = (from: string | undefined, to: string | undefined, offset: string): FilterCondition => ({
  op: "dateRange", ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), offset,
});

describe("every kind", () => {
  const kinds: ColumnKind[] = ["text", "number", "boolean", "date", "datetime", "datetimetz", "time", "binary", "json", "other"];

  test("NULL and NOT NULL, in any case", () => {
    for (const kind of kinds) {
      expect(read("NULL", kind)).toEqual([[{ op: "isNull" }]]);
      expect(read("null", kind)).toEqual([[{ op: "isNull" }]]);
      expect(read("NOT NULL", kind)).toEqual([[{ op: "notNull" }]]);
      expect(read("not   null", kind)).toEqual([[{ op: "notNull" }]]);
    }
  });

  test("an SQL condition in braces, with $$ left for the server", () => {
    for (const kind of kinds) expect(read("{$$ > 5}", kind)).toEqual([[{ op: "rawSql", sql: "$$ > 5" }]]);
  });

  test("blank text is no filter", () => {
    expect(read("", "text")).toEqual([]);
    expect(read("   \n\t", "number")).toEqual([]);
  });

  test("an SQL condition keeps braces, commas and spaces inside its own strings", () => {
    expect(read("{$$ in ('a}', 'b, c')}", "text")).toEqual([[{ op: "rawSql", sql: "$$ in ('a}', 'b, c')" }]]);
    expect(read('{"x}" = $$}', "text")).toEqual([[{ op: "rawSql", sql: '"x}" = $$' }]]);
    expect(read("{`a}` = $$}", "text")).toEqual([[{ op: "rawSql", sql: "`a}` = $$" }]]);
    expect(read("{coalesce($$, {fn now()}) > 1}", "text")).toEqual([[{ op: "rawSql", sql: "coalesce($$, {fn now()}) > 1" }]]);
    expect(read("{$$ = 'it''s'}", "text")).toEqual([[{ op: "rawSql", sql: "$$ = 'it''s'" }]]);
  });

  test("an SQL condition joins others like any value", () => {
    expect(read("{$$ > 1} {$$ < 9}, NULL", "number")).toEqual([
      [{ op: "rawSql", sql: "$$ > 1" }, { op: "rawSql", sql: "$$ < 9" }],
      [{ op: "isNull" }],
    ]);
  });

  test("an SQL condition may not start a second statement", () => {
    expect(marked("{$$ > 1; drop table t}", "text")).toBe(";");
    expect(read("{$$ = ';'}", "text")).toEqual([[{ op: "rawSql", sql: "$$ = ';'" }]]);
  });

  test("an empty or unclosed SQL condition is wrong", () => {
    expect(wrong("{  }", "text").message).toBe("The SQL condition is empty");
    const e = wrong("a {$$ > 1", "text");
    expect(e.message).toBe("Missing closing }");
    expect([e.start, e.end]).toEqual([2, 9]);
    expect(wrong(`{${"x".repeat(4001)}}`, "text").message).toBe("An SQL condition may hold at most 4000 characters");
    expect(read(`{${"x".repeat(4000)}}`, "text")).toEqual([[{ op: "rawSql", sql: "x".repeat(4000) }]]);
  });
});

describe("text", () => {
  test("a word, or + in front of it, is contains", () => {
    expect(read("canada", "text")).toEqual([[{ op: "contains", value: "canada" }]]);
    expect(read("+canada", "text")).toEqual([[{ op: "contains", value: "canada" }]]);
  });

  test("quotes keep spaces and commas, and a doubled quote is the quote itself", () => {
    expect(read("'new york'", "text")).toEqual([[{ op: "contains", value: "new york" }]]);
    expect(read('"new york"', "text")).toEqual([[{ op: "contains", value: "new york" }]]);
    expect(read("'a, b'", "text")).toEqual([[{ op: "contains", value: "a, b" }]]);
    expect(read("'it''s'", "text")).toEqual([[{ op: "contains", value: "it's" }]]);
    expect(read('"say ""hi"""', "text")).toEqual([[{ op: "contains", value: 'say "hi"' }]]);
    expect(read(`"it's"`, "text")).toEqual([[{ op: "contains", value: "it's" }]]);
  });

  test("a quote inside a word is part of it", () => {
    expect(read("don't", "text")).toEqual([[{ op: "contains", value: "don't" }]]);
    expect(read('5"', "text")).toEqual([[{ op: "contains", value: '5"' }]]);
  });

  test("begins, ends and their negations", () => {
    expect(read("^ca", "text")).toEqual([[{ op: "startsWith", value: "ca" }]]);
    expect(read("$da", "text")).toEqual([[{ op: "endsWith", value: "da" }]]);
    expect(read("~ca", "text")).toEqual([[{ op: "notContains", value: "ca" }]]);
    expect(read("!^ca", "text")).toEqual([[{ op: "notStartsWith", value: "ca" }]]);
    expect(read("!$da", "text")).toEqual([[{ op: "notEndsWith", value: "da" }]]);
  });

  test("equals and not equal", () => {
    expect(read("=active", "text")).toEqual([[{ op: "eq", value: "active" }]]);
    expect(read("!=active", "text")).toEqual([[{ op: "ne", value: "active" }]]);
    expect(read("<>active", "text")).toEqual([[{ op: "ne", value: "active" }]]);
    expect(read("=''", "text")).toEqual([[{ op: "eq", value: "" }]]);
  });

  test("comparisons", () => {
    expect(read("<b", "text")).toEqual([[{ op: "lt", value: "b" }]]);
    expect(read(">b", "text")).toEqual([[{ op: "gt", value: "b" }]]);
    expect(read("<=b", "text")).toEqual([[{ op: "le", value: "b" }]]);
    expect(read(">=b", "text")).toEqual([[{ op: "ge", value: "b" }]]);
  });

  test("an operator may be followed by a space", () => {
    expect(read(">= b", "text")).toEqual([[{ op: "ge", value: "b" }]]);
    expect(read("^ 'new y'", "text")).toEqual([[{ op: "startsWith", value: "new y" }]]);
  });

  test("an operator applies to quoted text too", () => {
    expect(read("='new york'", "text")).toEqual([[{ op: "eq", value: "new york" }]]);
    expect(read("!$\"a b\"", "text")).toEqual([[{ op: "notEndsWith", value: "a b" }]]);
  });

  test("EMPTY and NOT EMPTY", () => {
    expect(read("EMPTY", "text")).toEqual([[{ op: "isEmpty" }]]);
    expect(read("empty", "text")).toEqual([[{ op: "isEmpty" }]]);
    expect(read("NOT EMPTY", "text")).toEqual([[{ op: "notEmpty" }]]);
  });

  test("a quoted keyword is just the word", () => {
    expect(read("'NULL'", "text")).toEqual([[{ op: "contains", value: "NULL" }]]);
    expect(read("'EMPTY'", "text")).toEqual([[{ op: "contains", value: "EMPTY" }]]);
    expect(read("NOT 'EMPTY'", "text")).toEqual([[{ op: "contains", value: "NOT" }, { op: "contains", value: "EMPTY" }]]);
    expect(read("=NULL", "text")).toEqual([[{ op: "eq", value: "NULL" }]]);
  });

  test("words that are keywords elsewhere are text here", () => {
    expect(read("TRUE", "text")).toEqual([[{ op: "contains", value: "TRUE" }]]);
    expect(read("TODAY", "text")).toEqual([[{ op: "contains", value: "TODAY" }]]);
    expect(read("NOT", "text")).toEqual([[{ op: "contains", value: "NOT" }]]);
    expect(read("NOT x", "text")).toEqual([[{ op: "contains", value: "NOT" }, { op: "contains", value: "x" }]]);
  });

  test("there is no * wildcard", () => {
    expect(read("ca*", "text")).toEqual([[{ op: "contains", value: "ca*" }]]);
    expect(read("*", "text")).toEqual([[{ op: "contains", value: "*" }]]);
  });

  test("a date and a time on a text column are two words", () => {
    expect(read("2021-02-15 23:15", "text")).toEqual([[{ op: "contains", value: "2021-02-15" }, { op: "contains", value: "23:15" }]]);
  });

  test("times, JSON and unknown types read as text", () => {
    for (const kind of ["time", "json", "other"] as const) {
      expect(read("^10:", kind)).toEqual([[{ op: "startsWith", value: "10:" }]]);
      expect(read("EMPTY", kind)).toEqual([[{ op: "isEmpty" }]]);
    }
  });

  test("a value is never a number on a text column", () => {
    expect(read("=5", "text")).toEqual([[{ op: "eq", value: "5" }]]);
  });
});

describe("combining", () => {
  test("a space is AND, a comma is OR, and AND binds tighter", () => {
    expect(read("canada lake, usa", "text")).toEqual([
      [{ op: "contains", value: "canada" }, { op: "contains", value: "lake" }],
      [{ op: "contains", value: "usa" }],
    ]);
    expect(read("a,b c", "text")).toEqual([
      [{ op: "contains", value: "a" }],
      [{ op: "contains", value: "b" }, { op: "contains", value: "c" }],
    ]);
  });

  test("spaces around a comma, tabs and newlines are separators", () => {
    expect(read("  a ,\tb\nc  ", "text")).toEqual([
      [{ op: "contains", value: "a" }],
      [{ op: "contains", value: "b" }, { op: "contains", value: "c" }],
    ]);
  });

  test("^a, ^b is either beginning", () => {
    expect(read("^a, ^b", "text")).toEqual([[{ op: "startsWith", value: "a" }], [{ op: "startsWith", value: "b" }]]);
  });

  test("several plain equals become one in, where the first one was", () => {
    expect(read('="active",="pending"', "text")).toEqual([[{ op: "in", values: ["active", "pending"] }]]);
    expect(read("x, =a, y, =b", "text")).toEqual([
      [{ op: "contains", value: "x" }],
      [{ op: "in", values: ["a", "b"] }],
      [{ op: "contains", value: "y" }],
    ]);
    expect(read("='a',NULL,='b'", "text")).toEqual([[{ op: "in", values: ["a", "b"] }], [{ op: "isNull" }]]);
  });

  test("an operator belongs to the one value after it", () => {
    expect(read('="active","pending"', "text")).toEqual([[{ op: "eq", value: "active" }], [{ op: "contains", value: "pending" }]]);
  });

  test("one equals stays an equals, and an equals joined with AND is not folded", () => {
    expect(read("=a", "text")).toEqual([[{ op: "eq", value: "a" }]]);
    expect(read("=a b, =c", "text")).toEqual([
      [{ op: "eq", value: "a" }, { op: "contains", value: "b" }],
      [{ op: "eq", value: "c" }],
    ]);
  });

  test("at most FILTER_MAX_IN_VALUES values fold into one in", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `=${i}`).join(",");
    expect(read(list(FILTER_MAX_IN_VALUES), "number")[0]![0]!.values).toHaveLength(FILTER_MAX_IN_VALUES);
    expect(wrong(list(FILTER_MAX_IN_VALUES + 1), "number").message).toBe(`More than ${FILTER_MAX_IN_VALUES} values`);
  });
});

describe("syntax errors point at what is wrong", () => {
  test("an operator with nothing after it", () => {
    for (const op of [">=", "=", "<>", "^", "!$", "~"]) {
      const e = wrong(op, "text");
      expect(e.message).toBe(`Expected a value after "${op}"`);
      expect([e.start, e.end]).toEqual([0, op.length]);
    }
    expect(marked("a >=", "text")).toBe(">=");
    expect(marked("a >= , b", "text")).toBe(">=");
    expect(marked(">=   ", "number")).toBe(">=");
  });

  test("an unclosed quote marks from the quote to the end", () => {
    const e = wrong("a 'new york", "text");
    expect(e.message).toBe("Missing closing '");
    expect([e.start, e.end]).toEqual([2, 11]);
    expect(wrong('"abc', "text").message).toBe('Missing closing "');
  });

  test("a stray or doubled comma", () => {
    expect(wrong(",a", "text")).toEqual({ message: `Expected a value before ","`, start: 0, end: 1 });
    expect(wrong("  , a", "text")).toEqual({ message: `Expected a value before ","`, start: 2, end: 3 });
    expect(wrong("a,,b", "text")).toEqual({ message: `Expected a value before ","`, start: 2, end: 3 });
    expect(wrong("a, ,b", "text")).toEqual({ message: `Expected a value before ","`, start: 3, end: 4 });
    expect(wrong("a,", "text")).toEqual({ message: `Expected a value after ","`, start: 1, end: 2 });
    expect(wrong("a ,  ", "text")).toEqual({ message: `Expected a value after ","`, start: 2, end: 3 });
  });

  test("something right after a closing quote or brace", () => {
    expect(wrong("'a'b", "text")).toEqual({ message: "Expected a space or a comma", start: 3, end: 4 });
    expect(wrong("{x}{y}", "text")).toEqual({ message: "Expected a space or a comma", start: 3, end: 4 });
  });

  test("a brace after an operator is plain text", () => {
    expect(read("={x}", "text")).toEqual([[{ op: "eq", value: "{x}" }]]);
  });
});

describe("number", () => {
  test("comparisons", () => {
    expect(read("5", "number")).toEqual([[{ op: "eq", value: 5 }]]);
    expect(read("=5", "number")).toEqual([[{ op: "eq", value: 5 }]]);
    expect(read("!=5", "number")).toEqual([[{ op: "ne", value: 5 }]]);
    expect(read("<>5", "number")).toEqual([[{ op: "ne", value: 5 }]]);
    expect(read(">5", "number")).toEqual([[{ op: "gt", value: 5 }]]);
    expect(read(">=5", "number")).toEqual([[{ op: "ge", value: 5 }]]);
    expect(read("<5", "number")).toEqual([[{ op: "lt", value: 5 }]]);
    expect(read("<=5", "number")).toEqual([[{ op: "le", value: 5 }]]);
  });

  test("1,2,3 is any of them", () => {
    expect(read("1,2,3", "number")).toEqual([[{ op: "in", values: [1, 2, 3] }]]);
  });

  test(">=5 <=10 is the range between", () => {
    expect(read(">=5 <=10", "number")).toEqual([[{ op: "ge", value: 5 }, { op: "le", value: 10 }]]);
    expect(read(">= 5 <= 10", "number")).toEqual([[{ op: "ge", value: 5 }, { op: "le", value: 10 }]]);
  });

  test("signs, fractions and exponents", () => {
    expect(read("-2.5", "number")).toEqual([[{ op: "eq", value: -2.5 }]]);
    expect(read(">-5", "number")).toEqual([[{ op: "gt", value: -5 }]]);
    expect(read(".5", "number")).toEqual([[{ op: "eq", value: 0.5 }]]);
    expect(read("5.", "number")).toEqual([[{ op: "eq", value: 5 }]]);
    expect(read("1e3", "number")).toEqual([[{ op: "eq", value: 1000 }]]);
    expect(read("1.50000000000000000000", "number")).toEqual([[{ op: "eq", value: 1.5 }]]);
    expect(read("0.000", "number")).toEqual([[{ op: "eq", value: 0 }]]);
  });

  test("a quoted number is a number", () => {
    expect(read('="5",="6"', "number")).toEqual([[{ op: "in", values: [5, 6] }]]);
  });

  test("a number a JS number would round goes as typed", () => {
    expect(read("9007199254740991", "number")).toEqual([[{ op: "eq", value: 9007199254740991 }]]);
    expect(read("9007199254740993", "number")).toEqual([[{ op: "eq", value: "9007199254740993" }]]);
    expect(read("12345678901234567890", "number")).toEqual([[{ op: "eq", value: "12345678901234567890" }]]);
    expect(read("123456789012345", "number")).toEqual([[{ op: "eq", value: 123456789012345 }]]);
    expect(read("0.1234567890123456", "number")).toEqual([[{ op: "eq", value: "0.1234567890123456" }]]);
    expect(read("0.123456789012345", "number")).toEqual([[{ op: "eq", value: 0.123456789012345 }]]);
    expect(read("1e20", "number")).toEqual([[{ op: "eq", value: 1e20 }]]);
    expect(read("1.5e300", "number")).toEqual([[{ op: "eq", value: 1.5e300 }]]);
    expect(read("123456789012345678e-2", "number")).toEqual([[{ op: "eq", value: "123456789012345678e-2" }]]);
    expect(read("-9007199254740991", "number")).toEqual([[{ op: "eq", value: -9007199254740991 }]]);
    expect(read("007", "number")).toEqual([[{ op: "eq", value: 7 }]]);
    expect(read("1e400", "number")).toEqual([[{ op: "eq", value: "1e400" }]]);
    expect(read("1e-400", "number")).toEqual([[{ op: "eq", value: "1e-400" }]]);
  });

  test("anything else is wrong, and the value is what is marked", () => {
    expect(wrong("abc", "number").message).toBe(`"abc" is not a number`);
    expect(marked(">=abc", "number")).toBe("abc");
    expect(marked("5 x", "number")).toBe("x");
    expect(wrong("0x10", "number").message).toBe(`"0x10" is not a number`);
    expect(wrong("EMPTY", "number").message).toBe(`"EMPTY" is not a number`);
    expect(wrong("NOT EMPTY", "number").message).toBe(`"NOT" is not a number`);
    expect(wrong("'NULL'", "number").message).toBe(`"NULL" is not a number`);
  });

  test("text operators are wrong, and the operator is what is marked", () => {
    for (const op of ["+", "~", "^", "!^", "$", "!$"]) {
      const e = wrong(`${op}5`, "number");
      expect(e.message).toBe(`"${op}" does not work on number columns`);
      expect([e.start, e.end]).toEqual([0, op.length]);
    }
  });
});

describe("boolean", () => {
  test("TRUE true 1 and FALSE false 0", () => {
    for (const t of ["TRUE", "true", "True", "1", "=TRUE", "'1'"]) expect(read(t, "boolean")).toEqual([[{ op: "isTrue" }]]);
    for (const f of ["FALSE", "false", "0", "=0", '"false"']) expect(read(f, "boolean")).toEqual([[{ op: "isFalse" }]]);
  });

  test("with NULL, the funnel's Is True or NULL", () => {
    expect(read("TRUE, NULL", "boolean")).toEqual([[{ op: "isTrue" }], [{ op: "isNull" }]]);
  });

  test("anything else is wrong", () => {
    expect(wrong("yes", "boolean").message).toBe(`"yes" is not TRUE or FALSE`);
    expect(wrong("2", "boolean").message).toBe(`"2" is not TRUE or FALSE`);
    const e = wrong("<>TRUE", "boolean");
    expect(e.message).toBe(`"<>" does not work on boolean columns`);
    expect([e.start, e.end]).toEqual([0, 2]);
  });
});

describe("binary", () => {
  test("only NULL, NOT NULL and SQL", () => {
    expect(read("NOT NULL, {length($$) > 10}", "binary")).toEqual([[{ op: "notNull" }], [{ op: "rawSql", sql: "length($$) > 10" }]]);
    expect(wrong("abc", "binary").message).toBe("A binary column can only be filtered with NULL, NOT NULL or an SQL condition in braces");
    expect(marked("NULL =x", "binary")).toBe("=x");
  });
});

describe("date: values name a span", () => {
  const Z = "+00:00";

  test("a year, a month, a day, a minute, a second", () => {
    expect(read("2021", "date")).toEqual([[range("2021-01-01 00:00:00", "2022-01-01 00:00:00", Z)]]);
    expect(read("2021-02", "date")).toEqual([[range("2021-02-01 00:00:00", "2021-03-01 00:00:00", Z)]]);
    expect(read("2021-02-15", "date")).toEqual([[range("2021-02-15 00:00:00", "2021-02-16 00:00:00", Z)]]);
    expect(read("2021-02-15 23:15", "datetime")).toEqual([[range("2021-02-15 23:15:00", "2021-02-15 23:16:00", Z)]]);
    expect(read("2021-02-15 23:15:51", "datetime")).toEqual([[range("2021-02-15 23:15:51", "2021-02-15 23:15:52", Z)]]);
  });

  test("spans roll over into the next month and year", () => {
    expect(read("2021-12", "date")).toEqual([[range("2021-12-01 00:00:00", "2022-01-01 00:00:00", Z)]]);
    expect(read("2021-12-31", "date")).toEqual([[range("2021-12-31 00:00:00", "2022-01-01 00:00:00", Z)]]);
    expect(read("2021-02-28", "date")).toEqual([[range("2021-02-28 00:00:00", "2021-03-01 00:00:00", Z)]]);
    expect(read("2024-02-29", "date")).toEqual([[range("2024-02-29 00:00:00", "2024-03-01 00:00:00", Z)]]);
    expect(read("2021-12-31 23:59", "datetime")).toEqual([[range("2021-12-31 23:59:00", "2022-01-01 00:00:00", Z)]]);
    expect(read("2021-12-31 23:59:59", "datetime")).toEqual([[range("2021-12-31 23:59:59", "2022-01-01 00:00:00", Z)]]);
  });

  test("fractions of a second name their own precision", () => {
    expect(read("2024-02-15 10:00:00.5", "datetime")).toEqual([[range("2024-02-15 10:00:00.5", "2024-02-15 10:00:00.6", Z)]]);
    expect(read("2024-02-15 10:00:00.123", "datetime")).toEqual([[range("2024-02-15 10:00:00.123", "2024-02-15 10:00:00.124", Z)]]);
    expect(read("2024-02-15 10:00:00.999", "datetime")).toEqual([[range("2024-02-15 10:00:00.999", "2024-02-15 10:00:01.000", Z)]]);
    expect(read("2024-12-31 23:59:59.999999", "datetime")).toEqual([[range("2024-12-31 23:59:59.999999", "2025-01-01 00:00:00.000000", Z)]]);
  });

  test("T between the date and the time, as ISO writes it", () => {
    expect(read("2021-02-15T23:15", "datetime")).toEqual([[range("2021-02-15 23:15:00", "2021-02-15 23:16:00", Z)]]);
    expect(read("2021-02-15t23:15:51", "datetime")).toEqual([[range("2021-02-15 23:15:51", "2021-02-15 23:15:52", Z)]]);
  });

  test("operators compare with the edge that holds for the whole span", () => {
    expect(read("=2021", "date")).toEqual([[range("2021-01-01 00:00:00", "2022-01-01 00:00:00", Z)]]);
    expect(read(">2021", "date")).toEqual([[range("2022-01-01 00:00:00", undefined, Z)]]);
    expect(read(">=2021", "date")).toEqual([[range("2021-01-01 00:00:00", undefined, Z)]]);
    expect(read("<2021", "date")).toEqual([[range(undefined, "2021-01-01 00:00:00", Z)]]);
    expect(read("<=2021", "date")).toEqual([[range(undefined, "2022-01-01 00:00:00", Z)]]);
    expect(read("<>2021", "date")).toEqual([[range(undefined, "2021-01-01 00:00:00", Z)], [range("2022-01-01 00:00:00", undefined, Z)]]);
    expect(read("!=2021-02-15", "date")).toEqual([[range(undefined, "2021-02-15 00:00:00", Z)], [range("2021-02-16 00:00:00", undefined, Z)]]);
  });

  test(">=2024-01-01 <2024-02-01 is a range", () => {
    expect(read(">=2024-01-01 <2024-02-01", "datetime")).toEqual([[range("2024-01-01 00:00:00", undefined, Z), range(undefined, "2024-02-01 00:00:00", Z)]]);
  });

  test("a time joins the date in front of it, with or without an operator", () => {
    expect(read(">=2021-02-15 23:15", "datetime")).toEqual([[range("2021-02-15 23:15:00", undefined, Z)]]);
    expect(read(">= 2021-02-15 23:15:51 <2021-02-16", "datetime")).toEqual([[range("2021-02-15 23:15:51", undefined, Z), range(undefined, "2021-02-16 00:00:00", Z)]]);
    expect(read("'2021-02-15 23:15'", "datetime")).toEqual([[range("2021-02-15 23:15:00", "2021-02-15 23:16:00", Z)]]);
  });

  test("a time that has its own operator is not joined", () => {
    expect(marked("2021-02-15 >23:15", "datetime")).toBe("23:15");
  });

  test("<> splits a span, and the alternatives multiply out", () => {
    expect(read("<>2021 <>2023", "date")).toEqual([
      [range(undefined, "2021-01-01 00:00:00", Z), range(undefined, "2023-01-01 00:00:00", Z)],
      [range(undefined, "2021-01-01 00:00:00", Z), range("2024-01-01 00:00:00", undefined, Z)],
      [range("2022-01-01 00:00:00", undefined, Z), range(undefined, "2023-01-01 00:00:00", Z)],
      [range("2022-01-01 00:00:00", undefined, Z), range("2024-01-01 00:00:00", undefined, Z)],
    ]);
    expect(read(Array.from({ length: 6 }, (_, i) => `<>${2000 + i}`).join(" "), "date")).toHaveLength(64);
    const seven = Array.from({ length: 7 }, (_, i) => `<>${2000 + i}`).join(" ");
    expect(wrong(seven, "date").message).toBe("Too many conditions joined with spaces");
    expect(marked(seven, "date")).toBe("<>2006");
  });

  test("the year 9999 has no end, and nothing comes after it", () => {
    expect(read("9999", "date")).toEqual([[range("9999-01-01 00:00:00", undefined, Z)]]);
    expect(read("9999-12-31", "date")).toEqual([[range("9999-12-31 00:00:00", undefined, Z)]]);
    expect(read("<>9999", "date")).toEqual([[range(undefined, "9999-01-01 00:00:00", Z)]]);
    expect(read("<=9999", "date")).toEqual([[{ op: "notNull" }]]);
    expect(wrong(">9999", "date").message).toBe("Nothing comes after the year 9999");
  });

  test("years below 100 are not read as 19xx", () => {
    expect(read("0099", "date")).toEqual([[range("0099-01-01 00:00:00", "0100-01-01 00:00:00", Z)]]);
    expect(read("0000-02", "date")).toEqual([[range("0000-02-01 00:00:00", "0000-03-01 00:00:00", Z)]]);
  });

  test("impossible dates and other shapes are wrong", () => {
    for (const bad of ["2021-13", "2021-00", "2021-02-29", "2021-04-31", "2021-02-00", "2021-02-15 24:00", "2021-02-15 23:60", "2021-02-15 23:15:60",
      "21", "2021-2-5", "2021-02-15 23", "2021/02/15", "2021-02-15 23:15:51.1234567", "abc", "2021-02-15Z", "2021-02-15T23:15+24:00", "2021-02-15T23:15+05:60", "2021-02-15T23:15+5", "2021-02-15T23:15+05:3", "2021-02-15T23:15+24"]) {
      expect(wrong(`'${bad}'`, "date").message).toStartWith(`"${bad}" is not a date`);
    }
    expect(wrong("abc", "date").message).toBe(`"abc" is not a date — use 2021, 2021-02, 2021-02-15 or 2021-02-15 23:15`);
    expect(marked(">=abc", "date")).toBe("abc");
  });

  test("text operators are wrong on dates", () => {
    for (const op of ["+", "~", "^", "!^", "$", "!$"]) expect(wrong(`${op}2021`, "datetime").message).toBe(`"${op}" does not work on date columns`);
  });

  test("a value that names its zone is an instant, compared in UTC", () => {
    expect(read("2024-02-15T10:00:00.500Z", "datetimetz")).toEqual([[range("2024-02-15 10:00:00.500", "2024-02-15 10:00:00.501", Z)]]);
    expect(read("2024-02-15T17:00+07:00", "datetimetz")).toEqual([[range("2024-02-15 10:00:00", "2024-02-15 10:01:00", Z)]]);
    expect(read("2024-02-15 01:30:00-05:30", "datetimetz")).toEqual([[range("2024-02-15 07:00:00", "2024-02-15 07:00:01", Z)]]);
    expect(read("2024-01-01T03:00:00+07:00", "datetime")).toEqual([[range("2023-12-31 20:00:00", "2023-12-31 20:00:01", Z)]]);
    // As Postgres prints a timestamptz: hours only, or hours and minutes without a colon.
    expect(read("'2024-01-01 03:00:00+00'", "datetimetz")).toEqual([[range("2024-01-01 03:00:00", "2024-01-01 03:00:01", Z)]]);
    expect(read("2024-01-01 10:00:00.123456+07", "datetimetz")).toEqual([[range("2024-01-01 03:00:00.123456", "2024-01-01 03:00:00.123457", Z)]]);
    expect(read("2024-01-01 08:30:00+0530", "datetimetz")).toEqual([[range("2024-01-01 03:00:00", "2024-01-01 03:00:01", Z)]]);
    inZone("Asia/Ho_Chi_Minh", () => {
      expect(read("2024-02-15T10:00Z", "datetimetz")).toEqual([[range("2024-02-15 10:00:00", "2024-02-15 10:01:00", Z)]]);
    });
  });
});

describe("date: the device's zone", () => {
  test("every bound carries the offset in force at that moment", () => {
    inZone("Asia/Ho_Chi_Minh", () => {
      expect(read("2021-02-15", "datetimetz")).toEqual([[range("2021-02-15 00:00:00", "2021-02-16 00:00:00", "+07:00")]]);
      expect(read(">2021-02-15 23:15", "datetimetz")).toEqual([[range("2021-02-15 23:16:00", undefined, "+07:00")]]);
    });
    inZone("America/New_York", () => {
      expect(read("2021-01", "datetimetz")).toEqual([[range("2021-01-01 00:00:00", "2021-02-01 00:00:00", "-05:00")]]);
    });
    inZone("Asia/Kolkata", () => {
      expect(read("<2021-06-01", "datetimetz")).toEqual([[range(undefined, "2021-06-01 00:00:00", "+05:30")]]);
    });
  });

  test("a span across a daylight-saving change goes as two conditions", () => {
    inZone("Europe/Berlin", () => {
      expect(read("2024-03-30", "datetimetz")).toEqual([[range("2024-03-30 00:00:00", "2024-03-31 00:00:00", "+01:00")]]);
      expect(read("2024-03-31", "datetimetz")).toEqual([[range("2024-03-31 00:00:00", undefined, "+01:00"), range(undefined, "2024-04-01 00:00:00", "+02:00")]]);
      expect(read("2024-03", "datetimetz")).toEqual([[range("2024-03-01 00:00:00", undefined, "+01:00"), range(undefined, "2024-04-01 00:00:00", "+02:00")]]);
      expect(read("2024", "datetimetz")).toEqual([[range("2024-01-01 00:00:00", "2025-01-01 00:00:00", "+01:00")]]);
      expect(read("<>2024-10-27", "datetimetz")).toEqual([[range(undefined, "2024-10-27 00:00:00", "+02:00")], [range("2024-10-28 00:00:00", undefined, "+01:00")]]);
      expect(read("2024-07", "datetimetz")).toEqual([[range("2024-07-01 00:00:00", "2024-08-01 00:00:00", "+02:00")]]);
    });
  });

  test("an offset is rounded to whole minutes", () => {
    // Before 1906 the zone was local mean time, 7:06:40 ahead of UTC.
    inZone("Asia/Ho_Chi_Minh", () => {
      const [[cond]] = read("1900", "datetimetz") as [[FilterCondition]];
      expect(cond.offset).toMatch(/^\+07:0[67]$/);
    });
  });
});

describe("date: relative words, on the device's calendar", () => {
  // Thursday 1 October 2026, 15:00 in Ho Chi Minh City — 08:00 UTC.
  const thursday = () => new Date(2026, 9, 1, 15, 0, 0);
  const at = (now: Date, text: string) => read(text, "datetimetz", now);
  const tz = "+07:00";

  test("today, yesterday and tomorrow", () => {
    inZone("Asia/Ho_Chi_Minh", () => {
      expect(at(thursday(), "TODAY")).toEqual([[range("2026-10-01 00:00:00", "2026-10-02 00:00:00", tz)]]);
      expect(at(thursday(), "today")).toEqual([[range("2026-10-01 00:00:00", "2026-10-02 00:00:00", tz)]]);
      expect(at(thursday(), "YESTERDAY")).toEqual([[range("2026-09-30 00:00:00", "2026-10-01 00:00:00", tz)]]);
      expect(at(thursday(), "TOMORROW")).toEqual([[range("2026-10-02 00:00:00", "2026-10-03 00:00:00", tz)]]);
    });
  });

  test("today is the device's day, not the UTC one", () => {
    inZone("Asia/Ho_Chi_Minh", () => {
      // 2026-10-01 20:00 UTC is already 2 October in Ho Chi Minh City.
      expect(at(new Date(Date.UTC(2026, 9, 1, 20)), "TODAY")).toEqual([[range("2026-10-02 00:00:00", "2026-10-03 00:00:00", tz)]]);
    });
    inZone("America/New_York", () => {
      // ...and still 30 September in New York at 01:00 UTC.
      expect(at(new Date(Date.UTC(2026, 9, 1, 1)), "TODAY")).toEqual([[range("2026-09-30 00:00:00", "2026-10-01 00:00:00", "-04:00")]]);
    });
  });

  test("weeks start on Monday", () => {
    inZone("Asia/Ho_Chi_Minh", () => {
      expect(at(thursday(), "THIS WEEK")).toEqual([[range("2026-09-28 00:00:00", "2026-10-05 00:00:00", tz)]]);
      expect(at(thursday(), "LAST WEEK")).toEqual([[range("2026-09-21 00:00:00", "2026-09-28 00:00:00", tz)]]);
      expect(at(thursday(), "NEXT WEEK")).toEqual([[range("2026-10-05 00:00:00", "2026-10-12 00:00:00", tz)]]);
      const sunday = new Date(2026, 9, 4, 23, 59);
      const monday = new Date(2026, 8, 28, 0, 0);
      expect(at(sunday, "THIS WEEK")).toEqual([[range("2026-09-28 00:00:00", "2026-10-05 00:00:00", tz)]]);
      expect(at(monday, "THIS WEEK")).toEqual([[range("2026-09-28 00:00:00", "2026-10-05 00:00:00", tz)]]);
    });
  });

  test("months and years, across a year's end", () => {
    inZone("Asia/Ho_Chi_Minh", () => {
      expect(at(thursday(), "THIS MONTH")).toEqual([[range("2026-10-01 00:00:00", "2026-11-01 00:00:00", tz)]]);
      expect(at(thursday(), "LAST MONTH")).toEqual([[range("2026-09-01 00:00:00", "2026-10-01 00:00:00", tz)]]);
      expect(at(thursday(), "NEXT MONTH")).toEqual([[range("2026-11-01 00:00:00", "2026-12-01 00:00:00", tz)]]);
      expect(at(new Date(2026, 11, 31), "NEXT MONTH")).toEqual([[range("2027-01-01 00:00:00", "2027-02-01 00:00:00", tz)]]);
      expect(at(new Date(2026, 0, 31), "LAST MONTH")).toEqual([[range("2025-12-01 00:00:00", "2026-01-01 00:00:00", tz)]]);
      expect(at(new Date(2026, 0, 31), "NEXT MONTH")).toEqual([[range("2026-02-01 00:00:00", "2026-03-01 00:00:00", tz)]]);
      expect(at(thursday(), "THIS YEAR")).toEqual([[range("2026-01-01 00:00:00", "2027-01-01 00:00:00", tz)]]);
      expect(at(thursday(), "LAST YEAR")).toEqual([[range("2025-01-01 00:00:00", "2026-01-01 00:00:00", tz)]]);
      expect(at(thursday(), "next year")).toEqual([[range("2027-01-01 00:00:00", "2028-01-01 00:00:00", tz)]]);
      expect(at(new Date(2024, 2, 1), "YESTERDAY")).toEqual([[range("2024-02-29 00:00:00", "2024-03-01 00:00:00", tz)]]);
    });
  });

  test("relative words take operators too", () => {
    inZone("Asia/Ho_Chi_Minh", () => {
      expect(at(thursday(), ">=THIS MONTH")).toEqual([[range("2026-10-01 00:00:00", undefined, tz)]]);
      expect(at(thursday(), "< TODAY")).toEqual([[range(undefined, "2026-10-01 00:00:00", tz)]]);
      expect(at(thursday(), ">LAST WEEK <=TOMORROW")).toEqual([[range("2026-09-28 00:00:00", undefined, tz), range(undefined, "2026-10-03 00:00:00", tz)]]);
      expect(at(thursday(), "<>TODAY")).toEqual([[range(undefined, "2026-10-01 00:00:00", tz)], [range("2026-10-02 00:00:00", undefined, tz)]]);
    });
  });

  test("relative words follow the device's daylight saving", () => {
    inZone("Europe/Berlin", () => {
      expect(at(new Date(2024, 2, 15), "THIS MONTH")).toEqual([[range("2024-03-01 00:00:00", undefined, "+01:00"), range(undefined, "2024-04-01 00:00:00", "+02:00")]]);
    });
  });

  test("THIS, LAST and NEXT need a unit, and a quoted word is not a keyword", () => {
    expect(wrong("THIS", "date").message).toBe("Expected WEEK, MONTH or YEAR after THIS");
    expect(wrong("last day", "date").message).toBe("Expected WEEK, MONTH or YEAR after LAST");
    expect(marked("x NEXT 'MONTH'", "date")).toBe("x");
    expect(marked("NEXT 'MONTH'", "date")).toBe("NEXT");
    expect(marked("NEXT >MONTH", "date")).toBe("NEXT");
    expect(wrong("'TODAY'", "date").message).toStartWith(`"TODAY" is not a date`);
  });

  test("the default now is the current time", () => {
    const before = new Date();
    const [[cond]] = read("TODAY", "date") as [[FilterCondition]];
    const after = new Date();
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 00:00:00`;
    expect([day(before), day(after)]).toContain(cond.from!);
  });
});

describe("Multi column filter", () => {
  const columns = [
    { name: "name", kind: "text" as const },
    { name: "qty", kind: "number" as const },
    { name: "born", kind: "date" as const },
    { name: "active", kind: "boolean" as const },
  ];

  test("each column reads the text its own way, and a column it means nothing to is left out", () => {
    expect(parseAnyColumnFilter("abc", columns)).toEqual({ ok: true, groups: [{ column: "name", anyOf: [[{ op: "contains", value: "abc" }]] }] });
    expect(parseAnyColumnFilter("2026-09-27", columns)).toEqual({
      ok: true,
      groups: [
        { column: "name", anyOf: [[{ op: "contains", value: "2026-09-27" }]] },
        { column: "born", anyOf: [[range("2026-09-27 00:00:00", "2026-09-28 00:00:00", "+00:00")]] },
      ],
    });
    expect(parseAnyColumnFilter("1", columns)).toEqual({
      ok: true,
      groups: [
        { column: "name", anyOf: [[{ op: "contains", value: "1" }]] },
        { column: "qty", anyOf: [[{ op: "eq", value: 1 }]] },
        { column: "active", anyOf: [[{ op: "isTrue" }]] },
      ],
    });
  });

  test("relative dates use the given now", () => {
    const r = parseAnyColumnFilter("TODAY", [{ name: "born", kind: "date" }], new Date(2026, 9, 1, 12));
    expect(r).toEqual({ ok: true, groups: [{ column: "born", anyOf: [[range("2026-10-01 00:00:00", "2026-10-02 00:00:00", "+00:00")]] }] });
  });

  test("blank text is no filter", () => {
    expect(parseAnyColumnFilter("  ", columns)).toEqual({ ok: true, groups: [] });
  });

  test("a syntax error is the text's, whichever column reads it", () => {
    expect(parseAnyColumnFilter("a 'b", columns)).toEqual({ ok: false, error: { message: "Missing closing '", start: 2, end: 4 } });
  });

  test("no column able to read it is wrong", () => {
    expect(parseAnyColumnFilter("~abc", [{ name: "qty", kind: "number" }, { name: "born", kind: "date" }])).toEqual({
      ok: false, error: { message: "No column can read this filter", start: 0, end: 4 },
    });
    expect(parseAnyColumnFilter("abc", [])).toEqual({ ok: false, error: { message: "No column can read this filter", start: 0, end: 3 } });
  });

  test("an SQL condition belongs to one column", () => {
    expect(parseAnyColumnFilter("a, {$$ > 5}", columns)).toEqual({
      ok: false, error: { message: "An SQL condition only works in one column's own filter", start: 3, end: 11 },
    });
  });
});
