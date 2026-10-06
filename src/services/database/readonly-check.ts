import type { DialectName } from "./dialect.ts";
import { splitSqlStatements, sqlCode, type SqlLexOptions } from "../../shared/split-sql-statements.ts";

/** What a statement may start with and still be a read. A leading `(` opens `(SELECT …) UNION …`. */
const READ_START = /^\(*\s*(SELECT|WITH|VALUES|TABLE|EXPLAIN|SHOW|PRAGMA|DESCRIBE|DESC)\b/i;

/**
 * Keywords that make a read statement write: a data-modifying CTE
 * (`WITH x AS (DELETE …) SELECT …`), `EXPLAIN ANALYZE` of a write (which runs
 * it), and `SELECT … INTO`, which creates a table in Postgres and writes a
 * file on the server in MySQL (`INTO OUTFILE`) — measured: MariaDB writes that
 * file even inside a READ ONLY transaction, so only this check stops it.
 */
const WRITE_KEYWORD = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|CREATE|ALTER|TRUNCATE|INTO)\b/i;

/** SHOW never writes, and MySQL's most used one is `SHOW CREATE TABLE`. */
const SHOW = /^\(*\s*SHOW\b/i;

/**
 * How many ways a statement has to be read. A MySQL server running
 * NO_BACKSLASH_ESCAPES ends `'x\'` at the second quote, which the text cannot
 * say — so a MySQL statement has to be a plain read both ways, or
 * `SELECT 'x\' INTO OUTFILE '/tmp/f' -- '` would pass as one string.
 */
function readings(dialect: DialectName): SqlLexOptions[] {
  return dialect === "mysql" ? [{ backslashEscapes: true }, { backslashEscapes: false }] : [{}];
}

/**
 * True when every statement in `sql` is a plain read. This is the first,
 * fast check that gives a readable error; on a readonly connection the
 * database is asked to refuse writes as well, which is what catches reads that
 * write (`SELECT nextval('s')`, a function that deletes).
 *
 * Every statement is checked, not just the first: `SELECT 1; SET …` fails.
 * Keywords inside strings, quoted names and comments do not count — except a
 * MySQL `/*!…*​/` comment, whose content the server runs.
 */
export function isReadOnlyQuery(sql: string, dialect: DialectName = "postgres"): boolean {
  return readings(dialect).every((opts) => {
    const statements = splitSqlStatements(sql, dialect, opts).map((s) => sqlCode(s, dialect, opts).trim()).filter(Boolean);
    if (statements.length === 0) return false;
    return statements.every((code) => SHOW.test(code) || (READ_START.test(code) && !WRITE_KEYWORD.test(code)));
  });
}
