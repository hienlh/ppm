import { describe, expect, it } from "bun:test";
import { ansiLiteral, doubleQuoteIdent, escapeLike, likePattern, type DialectColumn } from "../../../../src/services/database/dialect.ts";
import { classifyPostgresType, postgresDialect } from "../../../../src/services/database/dialect-postgres.ts";
import { classifySqliteType, sqliteDialect } from "../../../../src/services/database/dialect-sqlite.ts";
import { classifyMysqlType, mysqlDialect } from "../../../../src/services/database/dialect-mysql.ts";
import { classifyColumnType, dialectFor } from "../../../../src/services/database/dialects.ts";

const col = (kind: DialectColumn["kind"], name = "c"): DialectColumn => ({ name, type: kind, kind });

describe("identifier quoting", () => {
  it("doubles a quote inside the name instead of ending the identifier early", () => {
    expect(doubleQuoteIdent(`a"b`)).toBe(`"a""b"`);
    expect(doubleQuoteIdent(`"; DROP TABLE x; --`)).toBe(`"""; DROP TABLE x; --"`);
  });

  it("keeps names that are not plain identifiers intact", () => {
    expect(doubleQuoteIdent("order-items")).toBe(`"order-items"`);
    expect(doubleQuoteIdent("Tên khách hàng")).toBe(`"Tên khách hàng"`);
  });

  it("qualifies a Postgres table with its schema, defaulting to public", () => {
    expect(postgresDialect.qualify("users", "auth")).toBe(`"auth"."users"`);
    expect(postgresDialect.qualify("users")).toBe(`"public"."users"`);
    expect(postgresDialect.qualify("users", null)).toBe(`"public"."users"`);
  });

  it("ignores the schema on SQLite, which has none to name", () => {
    expect(sqliteDialect.qualify("users", "auth")).toBe(`"users"`);
  });
});

describe("placeholders and paging", () => {
  it("numbers Postgres parameters and leaves SQLite's positional", () => {
    expect([1, 2, 10].map(postgresDialect.placeholder)).toEqual(["$1", "$2", "$10"]);
    expect([1, 2].map(sqliteDialect.placeholder)).toEqual(["?", "?"]);
  });

  it("takes paging as placeholders so it binds like any other value", () => {
    expect(postgresDialect.limitOffset("$3", "$4")).toBe("LIMIT $3 OFFSET $4");
    expect(sqliteDialect.limitOffset("?", "?")).toBe("LIMIT ? OFFSET ?");
  });
});

describe("LIKE patterns", () => {
  it("escapes %, _ and the escape character so they match themselves", () => {
    expect(escapeLike(`50%_off\\`)).toBe(`50\\%\\_off\\\\`);
  });

  it("builds the three pattern shapes", () => {
    expect(likePattern("ab", "contains")).toBe("%ab%");
    expect(likePattern("ab", "startsWith")).toBe("ab%");
    expect(likePattern("ab", "endsWith")).toBe("%ab");
    expect(likePattern("a%", "contains")).toBe("%a\\%%");
  });

  it("uses ILIKE on Postgres and casts non-text columns to text first", () => {
    expect(postgresDialect.likeInsensitive(`"name"`, "$1", col("text"))).toBe(`"name" ILIKE $1 ESCAPE E'\\\\'`);
    expect(postgresDialect.likeInsensitive(`"id"`, "$1", col("number"))).toBe(`CAST("id" AS TEXT) ILIKE $1 ESCAPE E'\\\\'`);
  });

  it("uses LIKE on SQLite, which has no ILIKE", () => {
    const sql = sqliteDialect.likeInsensitive(`"name"`, "?", col("text"));
    expect(sql).toBe(`"name" LIKE ? ESCAPE '\\'`);
    expect(sql).not.toContain("ILIKE");
  });
});

describe("booleans and dates", () => {
  it("compares booleans the way each engine stores them", () => {
    expect(postgresDialect.isTrue(`"b"`)).toBe(`"b" = TRUE`);
    expect(postgresDialect.isFalse(`"b"`)).toBe(`"b" = FALSE`);
    expect(sqliteDialect.isTrue(`"b"`)).toBe(`"b" = 1`);
    expect(sqliteDialect.isFalse(`"b"`)).toBe(`"b" = 0`);
  });

  it("normalises SQLite date text before comparing it", () => {
    expect(sqliteDialect.dateOperand(`"at"`, col("datetime"))).toBe(`strftime('%Y-%m-%d %H:%M:%f', "at")`);
    expect(postgresDialect.dateOperand(`"at"`, col("datetime"))).toBe(`"at"`);
  });

  it("gives a timestamptz bound the user's zone and leaves wall-clock types alone", () => {
    expect(postgresDialect.dateBound("2024-02-15 00:00:00", "+07:00", col("datetimetz"))).toBe("2024-02-15 00:00:00+07:00");
    expect(postgresDialect.dateBound("2024-02-15 00:00:00", "+07:00", col("datetime"))).toBe("2024-02-15 00:00:00");
    expect(postgresDialect.dateBound("2024-02-15", "+07:00", col("date"))).toBe("2024-02-15");
    expect(sqliteDialect.dateBound("2024-02-15", "+07:00", col("datetime"))).toBe("2024-02-15");
  });
});

describe("display literals", () => {
  it("renders each value type so the text reads as what was bound", () => {
    expect(ansiLiteral(null)).toBe("NULL");
    expect(ansiLiteral(undefined)).toBe("NULL");
    expect(ansiLiteral(42)).toBe("42");
    expect(ansiLiteral(-1.5)).toBe("-1.5");
    expect(ansiLiteral(Number.NaN)).toBe("'NaN'");
    expect(ansiLiteral(9007199254740993n)).toBe("9007199254740993");
    expect(ansiLiteral("it's")).toBe("'it''s'");
    expect(ansiLiteral(new Date("2024-02-15T00:00:00Z"))).toBe("'2024-02-15T00:00:00.000Z'");
    expect(ansiLiteral({ a: "b'c" })).toBe(`'{"a":"b''c"}'`);
  });

  it("writes booleans as TRUE/FALSE on Postgres and 1/0 on SQLite", () => {
    expect(postgresDialect.literal(true)).toBe("TRUE");
    expect(postgresDialect.literal(false)).toBe("FALSE");
    expect(sqliteDialect.literal(true)).toBe("1");
    expect(sqliteDialect.literal(false)).toBe("0");
  });
});

describe("column type classes", () => {
  it("classifies Postgres types as format_type() prints them", () => {
    const cases: [string, string][] = [
      ["character varying(255)", "text"], ["text", "text"], ["character(3)", "text"], ["name", "text"],
      ["integer", "number"], ["bigint", "number"], ["numeric(10,2)", "number"], ["double precision", "number"],
      ["boolean", "boolean"],
      ["date", "date"],
      ["timestamp without time zone", "datetime"], ["timestamp(3) without time zone", "datetime"],
      ["timestamp with time zone", "datetimetz"], ["timestamp(6) with time zone", "datetimetz"],
      ["time without time zone", "time"], ["time with time zone", "time"],
      ["bytea", "binary"], ["json", "json"], ["jsonb", "json"],
      ["uuid", "other"], ["interval", "other"], ["integer[]", "other"], ["character varying(20)[]", "other"],
      ["public.mood", "other"],
    ];
    for (const [type, kind] of cases) expect([type, classifyPostgresType(type)]).toEqual([type, kind]);
  });

  it("classifies SQLite declared types by name first, then by affinity", () => {
    const cases: [string, string][] = [
      ["INTEGER", "number"], ["BIGINT", "number"], ["REAL", "number"], ["NUMERIC", "number"], ["DECIMAL(10,2)", "number"],
      ["TEXT", "text"], ["VARCHAR(20)", "text"], ["NVARCHAR", "text"], ["CLOB", "text"],
      ["BOOLEAN", "boolean"], ["DATE", "date"], ["DATETIME", "datetime"], ["TIMESTAMP", "datetime"], ["TIME", "time"],
      ["JSON", "json"], ["BLOB", "binary"], ["", "other"], ["MONEY", "other"],
    ];
    for (const [type, kind] of cases) expect([type, classifySqliteType(type)]).toEqual([type, kind]);
  });

  it("picks the dialect and classifier by connection type", () => {
    expect(dialectFor("postgres")).toBe(postgresDialect);
    expect(dialectFor("sqlite")).toBe(sqliteDialect);
    expect(classifyColumnType("postgres", "jsonb")).toBe("json");
    expect(classifyColumnType("sqlite", "VARCHAR")).toBe("text");
  });
});

describe("MySQL and MariaDB", () => {
  it("quotes with backticks, doubling one inside the name", () => {
    expect(mysqlDialect.quoteIdent("order items")).toBe("`order items`");
    expect(mysqlDialect.quoteIdent("a`b")).toBe("`a``b`");
    expect(mysqlDialect.quoteIdent("`; DROP TABLE x; --")).toBe("```; DROP TABLE x; --`");
  });

  it("qualifies with the database only when one is named", () => {
    expect(mysqlDialect.qualify("users", "shop")).toBe("`shop`.`users`");
    expect(mysqlDialect.qualify("users", null)).toBe("`users`");
  });

  it("binds every value, paging included, as ?", () => {
    expect([1, 2].map(mysqlDialect.placeholder)).toEqual(["?", "?"]);
    expect(mysqlDialect.limitOffset("?", "?")).toBe("LIMIT ? OFFSET ?");
  });

  it("matches by the column's collation, casting non-text columns first", () => {
    expect(mysqlDialect.likeInsensitive("`name`", "?", col("text"))).toBe("`name` LIKE ? ESCAPE CHAR(92)");
    expect(mysqlDialect.likeInsensitive("`id`", "?", col("number"))).toBe("CAST(`id` AS CHAR) LIKE ? ESCAPE CHAR(92)");
  });

  it("uses MySQL's truthiness and its null-safe equality", () => {
    expect(mysqlDialect.isTrue("`b`")).toBe("`b` <> 0");
    expect(mysqlDialect.isFalse("`b`")).toBe("`b` = 0");
    expect(mysqlDialect.nullSafeEquals("`a`", "?")).toBe("`a` <=> ?");
    expect(mysqlDialect.insertDefaultValues("`t`")).toBe("INSERT INTO `t` () VALUES ()");
  });

  it("writes strings so MySQL reads back the same text, backslashes included", () => {
    expect(mysqlDialect.literal("C:\\temp")).toBe("'C:\\\\temp'");
    expect(mysqlDialect.literal("it's")).toBe("'it''s'");
    expect(mysqlDialect.literal({ a: 'x"y' })).toBe(`'{"a":"x\\\\"y"}'`);
    expect(mysqlDialect.literal(new Uint8Array([0xde, 0xad]))).toBe("X'dead'");
    expect(mysqlDialect.literal(true)).toBe("TRUE");
    expect(mysqlDialect.literal(null)).toBe("NULL");
  });

  it("classifies types as information_schema prints them", () => {
    const cases: [string, string][] = [
      ["tinyint(1)", "boolean"], ["bit(1)", "boolean"], ["tinyint", "number"], ["tinyint(4)", "number"],
      ["int unsigned", "number"], ["bigint", "number"], ["decimal(30,10)", "number"], ["double", "number"],
      ["float", "number"], ["bit(10)", "number"], ["year", "number"],
      ["varchar(255)", "text"], ["longtext", "text"], ["enum('red','green')", "text"], ["set('a','b')", "text"],
      ["date", "date"], ["datetime(3)", "datetime"], ["timestamp", "datetime"], ["time(3)", "time"],
      ["varbinary(8)", "binary"], ["blob", "binary"], ["json", "json"], ["geometry", "other"], ["uuid", "other"],
    ];
    for (const [type, kind] of cases) expect([type, classifyMysqlType(type)]).toEqual([type, kind]);
  });

  it("serves MariaDB with the MySQL dialect", () => {
    expect(dialectFor("mysql")).toBe(mysqlDialect);
    expect(dialectFor("mariadb")).toBe(mysqlDialect);
    expect(classifyColumnType("mariadb", "tinyint(1)")).toBe("boolean");
  });
});
