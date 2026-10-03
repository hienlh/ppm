import { describe, expect, it } from "bun:test";
// postgres.js's own array parser, which `exports` does not offer: the test runs the real one.
import { arrayParser } from "../../../../node_modules/postgres/src/types.js";
import { keepArrayNulls, parsePostgresArray } from "../../../../src/services/database/postgres-array-nulls.ts";
import { postgresService } from "../../../../src/services/postgres.service.ts";

type Parser = (text: string) => unknown;
const text = (x: string) => x;

describe("an array as Postgres prints it", () => {
  it("reads a bare NULL as NULL and a quoted one as the text", () => {
    expect(parsePostgresArray("{1,NULL,3}", Number)).toEqual([1, null, 3]);
    expect(parsePostgresArray('{"NULL",NULL,null}', text)).toEqual(["NULL", null, null]);
  });

  it("reads a quoted element whole, its escapes undone", () => {
    expect(parsePostgresArray('{"a,b","say \\"hi\\"","back\\\\slash","{brace}",""," padded "}', text))
      .toEqual(["a,b", 'say "hi"', "back\\slash", "{brace}", "", " padded "]);
  });

  it("reads nested and empty arrays, and bounds that are not the default", () => {
    expect(parsePostgresArray("{{1,2},{NULL,4}}", Number)).toEqual([[1, 2], [null, 4]]);
    expect(parsePostgresArray("{}", Number)).toEqual([]);
    expect(parsePostgresArray("[0:1]={7,8}", Number)).toEqual([7, 8]);
    expect(parsePostgresArray("[1:1][1:2]={{1,NULL}}", Number)).toEqual([[1, null]]);
  });

  it("splits a box array on ;, a box being written with commas", () => {
    expect(parsePostgresArray("{(1,1),(0,0);NULL}", text, ";")).toEqual(["(1,1),(0,0)", null]);
  });

  it("hands only what is not NULL to the element's parser", () => {
    const seen: string[] = [];
    parsePostgresArray('{a,NULL,"b"}', (x) => seen.push(x));
    expect(seen).toEqual(["a", "b"]);
  });

  it("refuses text Postgres would not print", () => {
    for (const bad of ["{1,2", '{"a}', "1,2}", "{1}x", '{"a\\']) expect(() => parsePostgresArray(bad, text)).toThrow();
  });
});

describe("postgres.js's array parsers, once kept NULL-aware", () => {
  /** connection.js `addArrayType`, which runs as each connection first opens. */
  function addArrayTypes(parsers: Record<number, Parser>): void {
    for (const [oid, typarray] of [[16, 1000], [17, 1001], [23, 1007], [25, 1009], [603, 1020]] as const) {
      const parser = parsers[oid];
      parsers[typarray] = (xs: string) => arrayParser(xs, parser, typarray);
      (parsers[typarray] as Parser & { array?: boolean }).array = true;
    }
  }
  /** connection.js `DataRow`: a parser marked `array` is handed the text without its first character. */
  const read = (parsers: Record<number, Parser>, oid: number, value: string) => {
    const parser = parsers[oid] as Parser & { array?: boolean };
    return parser.array === true ? parser(value.slice(1)) : parser(value);
  };
  const builtins = (): Record<number, Parser> => ({
    16: (x) => x === "t",
    17: (x) => Buffer.from(x.slice(2), "hex"),
    23: (x) => +x,
  });

  it("are needed: postgres.js reads a NULL element as the text NULL", () => {
    const parsers = builtins();
    addArrayTypes(parsers);
    expect(read(parsers, 1000, "{t,f,NULL}")).toEqual([true, false, false]);
    expect(read(parsers, 1009, '{"NULL",NULL}')).toEqual(["NULL", "NULL"]);
  });

  it("read NULL as NULL, and every other element as postgres.js does", () => {
    const parsers = builtins();
    keepArrayNulls(parsers);
    addArrayTypes(parsers);
    expect(read(parsers, 1000, "{t,f,NULL}")).toEqual([true, false, null]);
    expect(read(parsers, 1001, '{"\\\\x00ff",NULL}')).toEqual([Buffer.from([0, 0xff]), null]);
    expect(read(parsers, 1007, "{{1,NULL},{3,4}}")).toEqual([[1, null], [3, 4]]);
    expect(read(parsers, 1007, "[0:1]={7,8}")).toEqual([7, 8]);
    expect(read(parsers, 1009, '{"NULL",NULL,"a,b"}')).toEqual(["NULL", null, "a,b"]);
    expect(read(parsers, 1020, "{(1,1),(0,0);NULL}")).toEqual(["(1,1),(0,0)", null]);
  });

  it("leave the parsers already there alone, and a later one that is not an array", () => {
    const parsers = builtins();
    const int4 = parsers[23];
    keepArrayNulls(parsers);
    addArrayTypes(parsers);
    parsers[999] = (x) => `${x}!`;
    expect(parsers[23]).toBe(int4);
    expect(read(parsers, 999, "a")).toBe("a!");
  });

  it("are what every client PostgresService opens reads arrays with", async () => {
    type Client = { options: { parsers: Record<number, Parser> }; end: () => Promise<void> };
    const svc = postgresService as unknown as { client: (connectionString: string, max: number) => Client };
    // postgres.js connects on the first query, so nothing here reaches a server.
    const sql = svc.client("postgres://ppm@127.0.0.1:9/none", 1);
    try {
      addArrayTypes(sql.options.parsers);
      expect(read(sql.options.parsers, 1000, "{t,NULL}")).toEqual([true, null]);
      expect(read(sql.options.parsers, 1009, '{"NULL",NULL}')).toEqual(["NULL", null]);
    } finally {
      await sql.end();
    }
  });

  it("fall back to postgres.js's reading of text Postgres would not print", () => {
    const parsers = builtins();
    keepArrayNulls(parsers);
    addArrayTypes(parsers);
    expect(read(parsers, 1007, "{1,2")).toEqual(arrayParser("1,2", builtins()[23], 1007));
  });
});
