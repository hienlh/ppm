import type { DialectName } from "../../shared/db-types.ts";
import { splitSqlStatements, sqlCode, type SqlLexOptions } from "../../shared/split-sql-statements.ts";
import { isReadOnlyQuery } from "../database/readonly-check.ts";

/**
 * Whether a query the PPM Assistant wants to run is *proven* to only read, so it may run without
 * asking. Running on a read-only transaction or file handle is not proof on its own: a read-only
 * transaction still lets a function terminate a backend (`pg_terminate_backend`), reload the
 * server's config, take an advisory lock, write through another connection (`dblink_exec`),
 * sleep for an hour or set a variable, and a PRAGMA can set what it names.
 *
 * Proven means: {@link isReadOnlyQuery} holds, every PRAGMA only reads, there is no locking
 * clause, and every function called is on the list below — aggregates, window functions, string,
 * date/time, math, JSON accessors and casts — called by its own name or through `pg_catalog`.
 * Anything else (a function on no list, one in another schema, one named in quotes) is not
 * proven, and the caller asks the user before running it. The list is deliberately short:
 * an ordinary read that misses it only costs a question.
 *
 * This reads the text only. What the text names can still call something it does not show — a
 * view, a row-level security policy, a user function that shadows a listed name or that Postgres
 * runs for a row written as `t.name` — so on Postgres and MySQL a text that passes here is proven
 * only once `assistantSqlReachSafety` (`assistant-sql-reach-check.ts`) has asked the database's
 * catalog what it reaches.
 */

export type SqlSafety = { proven: true } | { proven: false; reason: string };

/** Names the check lets a query call. */
const SAFE_FUNCTIONS: ReadonlySet<string> = new Set(`
count sum avg min max total string_agg array_agg group_concat bool_and bool_or every stddev stddev_pop stddev_samp
variance var_pop var_samp json_agg jsonb_agg json_object_agg jsonb_object_agg json_arrayagg json_objectagg
percentile_cont percentile_disc mode bit_and bit_or bit_xor grouping
row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
lower upper lcase ucase length char_length character_length octet_length bit_length substr substring mid trim ltrim
rtrim btrim replace concat concat_ws left right lpad rpad position strpos instr locate reverse repeat split_part overlay normalize
initcap format regexp_replace regexp_matches regexp_match regexp_like regexp_substr regexp_instr regexp_count ascii
chr char md5 translate starts_with to_hex hex unhex printf unicode field find_in_set soundex space string_to_array
array_to_string array_length cardinality unnest array_position quote_ident quote_literal
json_extract json_unquote json_object json_array json_build_object json_build_array jsonb_build_object
jsonb_build_array to_json to_jsonb row_to_json json_typeof jsonb_typeof json_array_length jsonb_array_length
json_extract_path jsonb_extract_path json_extract_path_text jsonb_extract_path_text json_each jsonb_each json_each_text
jsonb_each_text json_array_elements jsonb_array_elements json_array_elements_text jsonb_array_elements_text
json_object_keys jsonb_object_keys jsonb_pretty json_valid json_length json_keys json_contains json_type
now date time datetime julianday strftime unixepoch date_trunc date_part extract age to_char to_date to_timestamp
to_number make_date make_time make_timestamp make_interval date_add date_sub datediff timestampdiff timestampadd
date_format str_to_date year month day dayofmonth dayofweek dayofyear hour minute second week weekday quarter last_day
from_unixtime unix_timestamp curdate curtime utc_timestamp utc_date clock_timestamp statement_timestamp
transaction_timestamp current_timestamp current_date current_time localtime localtimestamp timezone convert_tz
isfinite justify_days justify_hours justify_interval generate_series overlaps
abs ceil ceiling floor round trunc truncate mod power pow sqrt cbrt exp ln log log10 log2 sign pi degrees radians sin
cos tan asin acos atan atan2 cot greatest least div random width_bucket
coalesce nullif ifnull nvl if iif cast convert try_cast typeof pg_typeof encode decode to_base64 from_base64
version current_database current_schema current_schemas database schema current_user session_user user
pg_size_pretty pg_total_relation_size pg_relation_size pg_table_size pg_indexes_size pg_database_size
`.trim().split(/\s+/));

const words = (list: string): ReadonlySet<string> => new Set(list.trim().split(/\s+/));

/**
 * Words that may stand bare before a parenthesis without calling anything, per dialect: only
 * those the dialect's grammar never reads as a function name. A keyword that is not reserved
 * is an ordinary name there — Postgres lets a user function be called `first(…)`, `cube(…)`,
 * `match(…)` or `xor(…)`, and MySQL a stored function `offset(…)` or `any(…)` — so such a word
 * before `(` is a call like any other, unless {@link SYNTAX_AFTER} or {@link isCallPosition}
 * says the place it stands in cannot hold one.
 *
 * Postgres: its reserved keywords and the column-name keywords its grammar keeps for types and
 * special forms (`row`, `values`, `exists`, `between`, `varchar`…), which cannot name a function.
 * Not the "type or function name" keywords (`join`, `like`, `ilike`, `similar`, `is`, `binary`):
 * a function may carry those, so `x LIKE (…)` costs a question there.
 * MySQL and MariaDB: words both reserve. SQLite: it has no stored functions and PPM registers
 * none, so a skipped word can only ever reach a built-in — the full list stays.
 */
const NEVER_A_FUNCTION: Record<DialectName, ReadonlySet<string>> = {
  postgres: words(`
select from where in exists as values on and or not when then else case between distinct all any some using lateral
union intersect except having limit offset with row array group order window table fetch analyze
varchar char character nchar numeric decimal dec float real timestamp time bit interval
`),
  mysql: words(`
select from where in exists as values on and or not when then else case between distinct all using union having limit
with group order table fetch analyze like regexp rlike xor match binary join is partition by range
varchar char character varying numeric decimal dec float real interval
`),
  sqlite: words(`
select from where in exists as values join on and or not when then else case is between like ilike similar escape
distinct all any some using lateral union intersect except having limit offset with recursive materialized row array
over filter within by group order partition window rows range groups explain analyze table first next fetch cube
rollup sets xor regexp rlike match against binary
varchar char character varying nchar nvarchar numeric decimal dec float real timestamp timestamptz time timetz bit
varbit interval
`),
};

/**
 * Syntax words that sit before a parenthesis without calling anything — but only straight after
 * the token listed: a window's `OVER (…)` and an aggregate's `FILTER (…)` follow the call they
 * qualify, as MySQL's `AGAINST (…)` follows `MATCH (…)`; `FETCH FIRST (n)`, `GROUPING SETS (…)`,
 * `CHARACTER VARYING (n)`, `AS MATERIALIZED (…)`, `ORDER BY (…)`. The same word anywhere else is
 * a call.
 */
const SYNTAX_AFTER: Readonly<Record<string, readonly string[]>> = {
  over: [")"],
  filter: [")"],
  against: [")"],
  first: ["fetch"],
  next: ["fetch"],
  sets: ["grouping"],
  varying: ["character", "bit"],
  materialized: ["as", "not"],
  by: ["order", "group", "partition"],
};

/**
 * The token before position `at` of `code`: `::`, a single punctuation character, or the last
 * word (lower case); empty at the start of the statement.
 */
function previousToken(code: string, at: number): string {
  const before = code.slice(0, at).trimEnd();
  if (!before) return "";
  if (before.endsWith("::")) return "::";
  const word = /[A-Za-z_][\w$]*$/.exec(before);
  return word ? word[0].toLowerCase() : before.slice(-1);
}

/**
 * Whether a bare name standing before `(` after `previous` can be a function call at all. Never
 * at the start of a statement (`EXPLAIN (…)`), and never as a type or an alias: after `::` or
 * `AS` a name is a type with its modifier (`x::timestamptz(3)`, `CAST(x AS nvarchar(10))`) or an
 * alias with its column list (`… AS g(n)`), in every dialect.
 */
function isCallPosition(previous: string): boolean {
  return previous !== "" && previous !== "::" && previous !== "as";
}

const READ_PRAGMAS = new Set(`
table_info table_xinfo table_list index_list index_info index_xinfo foreign_key_list database_list collation_list
function_list module_list pragma_list compile_options user_version application_id schema_version data_version
page_count page_size freelist_count encoding journal_mode foreign_keys integrity_check quick_check
`.trim().split(/\s+/));
/** Read-only PRAGMAs whose argument names what to read rather than a value to set. */
const PRAGMAS_WITH_ARGUMENT = new Set(
  "table_info table_xinfo table_list index_list index_info index_xinfo foreign_key_list integrity_check quick_check".split(" "),
);

const PRAGMA = /^\s*PRAGMA\s+(?:\w+\s*\.\s*)?(\w+)\s*([\s\S]*)$/i;
const LOCKING = /\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i;
/** A name (optionally qualified) or a blanked quoted name or string, then an opening parenthesis. */
const CALL = /((?:[A-Za-z_][\w$]*\s*\.\s*)*)([A-Za-z_][\w$]*)\s*\(|(""|'')\s*\(/g;

function readings(dialect: DialectName): SqlLexOptions[] {
  return dialect === "mysql" ? [{ backslashEscapes: true }, { backslashEscapes: false }] : [{}];
}

function pragmaSafety(name: string, rest: string): SqlSafety {
  const pragma = name.toLowerCase();
  if (!READ_PRAGMAS.has(pragma)) return { proven: false, reason: `PRAGMA ${pragma} is not one PPM knows to only read` };
  const argument = rest.replace(/;\s*$/, "").trim();
  if (argument.includes("=")) return { proven: false, reason: `PRAGMA ${pragma} = … sets a value` };
  if (argument && !PRAGMAS_WITH_ARGUMENT.has(pragma)) return { proven: false, reason: `PRAGMA ${pragma}(…) sets a value` };
  return { proven: true };
}

/** `U&"…"`: a Postgres name spelled in Unicode escapes, which no search of the text can match to the object it names. */
const UNICODE_ESCAPED_NAME = /\bU&\s*""/i;

/**
 * Whether the statement `code` (strings, quoted names and comments blanked by `sqlCode`) is proven
 * to only read. Each function on the safe list it calls by a bare name is added to `called`.
 */
function statementSafety(code: string, dialect: DialectName, called?: Set<string>): SqlSafety {
  const pragma = PRAGMA.exec(code);
  if (pragma) return pragmaSafety(pragma[1]!, pragma[2] ?? "");
  if (LOCKING.test(code)) return { proven: false, reason: "it takes row locks (FOR UPDATE / FOR SHARE)" };
  // MySQL's `SELECT @v := …` sets a variable on a pooled session that later queries share.
  if (code.includes(":=")) return { proven: false, reason: "it assigns a variable (:=)" };
  if (UNICODE_ESCAPED_NAME.test(code)) return { proven: false, reason: "it names something in Unicode escapes (U&\"…\")" };
  for (const m of code.matchAll(CALL)) {
    if (m[3]) return { proven: false, reason: "it calls a function named in quotes" };
    const qualifier = (m[1] ?? "").replace(/\s+/g, "").toLowerCase();
    const name = m[2]!.toLowerCase();
    // `"other_schema".lower(…)`: the quoted qualifier was blanked, the dot before the name is left.
    if (!qualifier && code.slice(0, m.index).trimEnd().endsWith(".")) {
      return { proven: false, reason: `it calls ${name}() in a schema named in quotes` };
    }
    if (!qualifier) {
      const previous = previousToken(code, m.index);
      if (NEVER_A_FUNCTION[dialect].has(name) || !isCallPosition(previous) || SYNTAX_AFTER[name]?.includes(previous)) continue;
    }
    if (qualifier && qualifier !== "pg_catalog.") return { proven: false, reason: `it calls ${qualifier}${name}(), a function outside the known-safe list` };
    if (!SAFE_FUNCTIONS.has(name)) return { proven: false, reason: `it calls ${name}(), which is not on PPM's list of functions known to only read` };
    // Only a bare name is looked up on the search path, where something else could answer to it.
    if (!qualifier) called?.add(name);
  }
  return { proven: true };
}

/**
 * Whether `sql` is proven to only read on a `dialect` database, as far as its text shows; when
 * not, why. Each listed function the text calls by a bare name is added to `called`, for the
 * catalog check.
 */
export function assistantSqlSafety(sql: string, dialect: DialectName, called?: Set<string>): SqlSafety {
  if (!isReadOnlyQuery(sql, dialect)) return { proven: false, reason: "it is not a plain read (SELECT, WITH, SHOW, EXPLAIN, VALUES)" };
  for (const opts of readings(dialect)) {
    for (const statement of splitSqlStatements(sql, dialect, opts)) {
      const verdict = statementSafety(sqlCode(statement, dialect, opts), dialect, called);
      if (!verdict.proven) return verdict;
    }
  }
  return { proven: true };
}

/**
 * A quoted name in Postgres's own deparsed SQL that is all lower case means the same as the bare
 * name: `pg_get_viewdef` quotes keywords (`"left"(…)`, `"substring"(…)`) whatever they name.
 * Not when the quote touches another one — `"low""er"` is the name `low"er`.
 */
const LOWER_CASE_QUOTED_NAME = /(?<!")"([a-z_][a-z0-9_$]*)"(?!")/g;

/**
 * The same check over SQL that Postgres deparsed from its catalog — a view's definition, a
 * policy's condition, a generated column's or a domain's expression — rather than SQL a person
 * wrote. Only Postgres writes it, so a quoted lower-case name is read as the bare name.
 */
export function deparsedPostgresSafety(text: string, called?: Set<string>): SqlSafety {
  const code = sqlCode(text.replace(LOWER_CASE_QUOTED_NAME, "$1"), "postgres");
  return statementSafety(code.replace(/;\s*$/, ""), "postgres", called);
}
