import type { DialectName } from "../../shared/db-types.ts";
import { splitSqlStatements, sqlCodeInPlace, type SqlLexOptions } from "../../shared/split-sql-statements.ts";

/**
 * Which rows an approved UPDATE or DELETE is about to change, as a SELECT of the same table under
 * the same WHERE — so the Assistant can report the old values of what it changed. Only the plain
 * shape is accepted, and anything else answers "not identifiable" rather than a guess:
 *
 *   UPDATE <table> [[AS] <alias>] SET … [WHERE …]
 *   DELETE FROM <table> [[AS] <alias>] [WHERE …]
 *
 * with `<table>` a name of up to three parts. Each refusal is a form whose rows a SELECT of the
 * same WHERE would not name: more than one table (`FROM`/`USING`/`JOIN`, a comma list), Postgres
 * `ONLY` and `t *`, a WITH prefix, a statement modifier (`OR REPLACE`, `LOW_PRIORITY`, `IGNORE`),
 * `WHERE CURRENT OF` a cursor, `ORDER BY`/`LIMIT` cutting the set, `RETURNING`, row sampling, and
 * any nested write. Read on its code only — strings, quoted names and comments cannot pass for a
 * keyword — and, on MySQL, both ways a backslash may read, since the text cannot say which the
 * server uses.
 */

export type WriteTarget =
  | { ok: true; kind: "update" | "delete"; selectSql: string }
  | { ok: false; reason: string };

interface Token {
  /** Upper-cased for a word; the characters as masked otherwise. */
  value: string;
  kind: "word" | "quoted" | "other";
  start: number;
  end: number;
  /** Parenthesis depth the token sits at. */
  depth: number;
}

const WORD = /[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/y;

function tokens(code: string): Token[] | null {
  const out: Token[] = [];
  let depth = 0;
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "\u0001" || c === "\u0002") {
      let j = i;
      while (code[j] === c) j++;
      out.push({ value: code.slice(i, j), kind: c === "\u0002" ? "quoted" : "other", start: i, end: j, depth });
      i = j;
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(code);
    if (word) {
      out.push({ value: word[0].toUpperCase(), kind: "word", start: i, end: i + word[0].length, depth });
      i += word[0].length;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth < 0) return null;
    out.push({ value: c, kind: "other", start: i, end: i + 1, depth: c === "(" ? depth - 1 : depth });
    i++;
  }
  return depth === 0 ? out : null;
}

/** Anywhere in the statement, any of these means its rows cannot be named by a plain SELECT. */
const NEVER = new Set([
  "WITH", "RETURNING", "OUTPUT", "LIMIT", "OFFSET", "FETCH", "TOP", "TABLESAMPLE", "INSERT", "MERGE", "UPSERT",
  "INTO", "CALL", "EXEC", "EXECUTE", "DO", "LOCK", "FOR",
]);
/** Words that are never an alias: what may follow a table name in the forms not accepted here. */
const NOT_AN_ALIAS = new Set([
  "SET", "WHERE", "AS", "FROM", "USING", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "STRAIGHT_JOIN", "ON",
  "PARTITION", "INDEXED", "NOT", "USE", "FORCE", "IGNORE", "ONLY", "ORDER", "LIMIT", "OR", "LOW_PRIORITY", "QUICK",
]);

const notIdentifiable = (why: string): WriteTarget => ({ ok: false, reason: why });

/** A name of up to three parts from `at`: the index past it, or -1. */
function tableName(t: Token[], at: number): number {
  let i = at;
  for (let part = 0; part < 3; part++) {
    const tok = t[i];
    if (!tok || tok.depth !== 0 || !(tok.kind === "quoted" || (tok.kind === "word" && !NOT_AN_ALIAS.has(tok.value)))) return -1;
    i++;
    if (t[i]?.value !== "." || part === 2) return i;
    i++;
  }
  return -1;
}

/** The target and its optional alias from `at`: the index past them, or -1. */
function tableWithAlias(t: Token[], at: number): number {
  let i = tableName(t, at);
  if (i < 0) return -1;
  const next = t[i];
  if (next?.kind === "word" && next.value === "AS") {
    const alias = t[i + 1];
    if (!alias || !(alias.kind === "quoted" || (alias.kind === "word" && !NOT_AN_ALIAS.has(alias.value)))) return -1;
    return i + 2;
  }
  if (next && (next.kind === "quoted" || (next.kind === "word" && !NOT_AN_ALIAS.has(next.value)))) i++;
  return i;
}

function readTarget(statement: string, dialect: DialectName, opts: SqlLexOptions): WriteTarget {
  const t = tokens(sqlCodeInPlace(statement, dialect, opts));
  if (!t || t.length === 0) return notIdentifiable("PPM could not read the statement's shape");
  const first = t[0]!;
  const kind = first.value === "UPDATE" ? "update" : first.value === "DELETE" ? "delete" : null;
  if (!kind || first.kind !== "word") return notIdentifiable("it is not an UPDATE or DELETE");
  for (const tok of t.slice(1)) {
    if (tok.kind !== "word") continue;
    if (NEVER.has(tok.value) || tok.value === "UPDATE" || tok.value === "DELETE") {
      return notIdentifiable(`it uses ${tok.value}, which a plain SELECT of the same WHERE might not match`);
    }
  }
  if (t.some((tok) => tok.value === ";")) return notIdentifiable("it is more than one statement");

  let at = 1;
  if (kind === "delete") {
    if (t[1]?.value !== "FROM") return notIdentifiable("it is not the plain DELETE FROM <table> form");
    at = 2;
  }
  const afterTarget = tableWithAlias(t, at);
  if (afterTarget < 0) return notIdentifiable("its target is not one plainly named table");
  let whereAt = -1;
  if (kind === "update") {
    if (t[afterTarget]?.value !== "SET" || t[afterTarget]!.kind !== "word") return notIdentifiable("its target is not one plainly named table");
    for (let i = afterTarget + 1; i < t.length; i++) {
      const tok = t[i]!;
      if (tok.depth !== 0 || tok.kind !== "word") continue;
      if (tok.value === "WHERE") { whereAt = i; break; }
      if (tok.value === "FROM" || tok.value === "JOIN" || tok.value === "ORDER") {
        return notIdentifiable(`it uses ${tok.value} after SET, so it may change rows a plain SELECT would not name`);
      }
    }
  } else if (afterTarget < t.length) {
    if (t[afterTarget]!.value !== "WHERE") return notIdentifiable("its target is not one plainly named table");
    whereAt = afterTarget;
  }
  if (whereAt >= 0) {
    for (let i = whereAt + 1; i < t.length; i++) {
      const tok = t[i]!;
      if (tok.depth === 0 && tok.kind === "word" && (tok.value === "ORDER" || (tok.value === "CURRENT" && t[i + 1]?.value === "OF"))) {
        return notIdentifiable(`its WHERE ends in ${tok.value === "ORDER" ? "ORDER BY" : "CURRENT OF"}`);
      }
    }
    if (whereAt + 1 >= t.length) return notIdentifiable("its WHERE is empty");
  }
  const target = statement.slice(t[at]!.start, t[afterTarget - 1]!.end);
  const where = whereAt >= 0 ? ` WHERE ${statement.slice(t[whereAt + 1]!.start, t[t.length - 1]!.end)}` : "";
  return { ok: true, kind, selectSql: `SELECT * FROM ${target}${where}` };
}

/** The SELECT naming the rows `sql` would change, when `sql` is one UPDATE or DELETE of the plain shape. */
export function writeTargetSelect(sql: string, dialect: DialectName): WriteTarget {
  const statements = splitSqlStatements(sql, dialect);
  if (statements.length !== 1) return notIdentifiable("it is not exactly one statement");
  const statement = statements[0]!;
  if (dialect !== "mysql") return readTarget(statement, dialect, {});
  const escaping = readTarget(statement, dialect, { backslashEscapes: true });
  const plain = readTarget(statement, dialect, { backslashEscapes: false });
  if (!escaping.ok || !plain.ok) return escaping.ok ? plain : escaping;
  return escaping.selectSql === plain.selectSql ? escaping : notIdentifiable("it reads differently depending on the server's backslash setting");
}

/**
 * Whether the statement is an UPDATE or DELETE at all, read on its code: for those the answer
 * says whether old values were captured; any other write has none to capture.
 */
export function isUpdateOrDelete(sql: string, dialect: DialectName): boolean {
  const statements = splitSqlStatements(sql, dialect);
  if (statements.length !== 1) return false;
  const first = /^\s*([A-Za-z]+)/.exec(sqlCodeInPlace(statements[0]!, dialect))?.[1]?.toUpperCase();
  return first === "UPDATE" || first === "DELETE";
}
