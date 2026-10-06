/**
 * Split a SQL script into statements, and read the code of one without its
 * literals, the way the given engine reads them. One implementation for the
 * server and the editor, so the statement a Run button shows is the one the
 * server runs.
 *
 * - `-- …` and `/* … *​/` comments (nested in Postgres, not elsewhere); MySQL
 *   adds `# …`, and needs a blank after `--` (`1--1` is `1 - -1` there)
 * - `'…'` strings with `''`; backslash escapes in Postgres `E'…'` and in every
 *   MySQL string (see `backslashEscapes`)
 * - `"…"` identifiers (strings in MySQL), plus `` `…` `` in SQLite and MySQL
 *   and `[…]` in SQLite
 * - Postgres dollar quotes, `$$…$$` and `$tag$…$tag$`
 * - MySQL's `DELIMITER //` lines, which the mysql client reads to let a
 *   procedure body hold semicolons; they are not statements themselves
 * - MySQL's executable comments, `/*!50001 … *​/` and MariaDB's `/*M! … *​/`,
 *   whose content the server runs — so they count as code, not comments
 *
 * Getting these wrong is not cosmetic: the readonly check reads each
 * statement's first keyword, so a splitter that took `E'\''; DELETE …` for one
 * string would hide a statement from it. The database has the last word
 * anyway — a readonly connection runs one statement at a time, inside a READ
 * ONLY transaction.
 */
import type { DialectName } from "./db-types.ts";

export interface SqlLexOptions {
  /**
   * Whether a backslash escapes the next character in a quoted string. MySQL
   * does unless the server runs NO_BACKSLASH_ESCAPES, which the text cannot
   * say — the readonly check reads a MySQL statement both ways. Postgres only
   * does in `E'…'` strings, SQLite never.
   */
  backslashEscapes?: boolean;
}

type PieceKind = "code" | "literal" | "comment" | "end" | "directive";
interface Piece { kind: PieceKind; start: number; end: number }

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
/** A dollar-quote tag: `$`, an identifier that does not start with a digit, `$` — or `$$`. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
/** `DELIMITER //`: the command word, blanks, then the new terminator up to the next blank. */
const DELIMITER_LINE = /^delimiter[ \t]+(\S+)/i;

/** Index just past a quoted run starting at `start`; `closer` doubled is an escaped closer. */
function endOfQuoted(sql: string, start: number, closer: string, backslashEscapes: boolean): number {
  let j = start + 1;
  while (j < sql.length) {
    const c = sql[j]!;
    if (backslashEscapes && c === "\\") { j += 2; continue; }
    if (c === closer) {
      if (closer !== "]" && sql[j + 1] === closer) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

function endOfBlockComment(sql: string, start: number, nested: boolean): number {
  let depth = 0;
  let j = start;
  while (j < sql.length) {
    if (sql[j] === "/" && sql[j + 1] === "*") {
      depth++;
      j += 2;
      if (!nested && depth > 1) depth = 1;
    } else if (sql[j] === "*" && sql[j + 1] === "/") {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else j++;
  }
  return sql.length;
}

function lineEnd(sql: string, from: number): number {
  const nl = sql.indexOf("\n", from);
  return nl === -1 ? sql.length : nl;
}

/** MySQL reads `--` as a comment only when a blank or control character (or the end) follows. */
function mysqlDashComment(sql: string, i: number): boolean {
  const next = sql[i + 2];
  return next === undefined || next <= " ";
}

/** Every character of `sql` lands in exactly one piece, in order. */
function* lex(sql: string, dialect: DialectName, opts: SqlLexOptions = {}): Generator<Piece> {
  const pg = dialect === "postgres";
  const my = dialect === "mysql";
  const backslash = opts.backslashEscapes ?? my;
  let delimiter = ";";
  let i = 0;
  let codeStart = -1;
  /** Code or a literal since the last terminator or directive. */
  let hasCode = false;
  /** Nothing but blanks since the last line break. */
  let lineStart = true;
  const flush = function* (): Generator<Piece> {
    if (codeStart !== -1) { yield { kind: "code", start: codeStart, end: i }; codeStart = -1; }
  };
  while (i < sql.length) {
    const c = sql[i]!;
    // The mysql client reads DELIMITER only at the start of a line, between statements.
    if (my && lineStart && !hasCode && (c === "d" || c === "D")) {
      const eol = lineEnd(sql, i);
      const m = DELIMITER_LINE.exec(sql.slice(i, eol));
      if (m && !m[1]!.includes("\\")) {
        yield* flush();
        yield { kind: "directive", start: i, end: eol };
        delimiter = m[1]!;
        i = eol;
        continue;
      }
    }
    if (sql.startsWith(delimiter, i)) {
      yield* flush();
      yield { kind: "end", start: i, end: i + delimiter.length };
      i += delimiter.length;
      hasCode = false;
      lineStart = false;
      continue;
    }
    const prev = i > 0 ? sql[i - 1]! : "";
    let end = -1;
    let kind: PieceKind = "literal";
    if (c === "-" && sql[i + 1] === "-" && (!my || mysqlDashComment(sql, i))) {
      end = lineEnd(sql, i);
      kind = "comment";
    } else if (my && c === "#") {
      end = lineEnd(sql, i);
      kind = "comment";
    } else if (c === "/" && sql[i + 1] === "*") {
      end = endOfBlockComment(sql, i, pg);
      // `/*!…*/` and `/*M!…*/` are run by MySQL and MariaDB: read them as code.
      kind = my && (sql[i + 2] === "!" || (sql[i + 2] === "M" && sql[i + 3] === "!")) ? "code" : "comment";
    } else if (c === "'") {
      // E'…' only when the E starts a token: `aE'x'` is not an escape string.
      const escapeString = pg && (prev === "E" || prev === "e") && !IDENT_CHAR.test(sql[i - 2] ?? "");
      end = endOfQuoted(sql, i, "'", escapeString || (!pg && backslash));
    } else if (c === '"') {
      end = endOfQuoted(sql, i, '"', my && backslash);
    } else if (!pg && c === "`") {
      end = endOfQuoted(sql, i, "`", false);
    } else if (dialect === "sqlite" && c === "[") {
      end = endOfQuoted(sql, i, "]", false);
    } else if (pg && c === "$" && !IDENT_CHAR.test(prev)) {
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        end = close === -1 ? sql.length : close + tag[0].length;
      }
    }
    if (end !== -1) {
      yield* flush();
      yield { kind, start: i, end };
      if (kind !== "comment") hasCode = true;
      lineStart = false;
      i = end;
      continue;
    }
    if (codeStart === -1) codeStart = i;
    if (c === "\n") lineStart = true;
    else if (c !== " " && c !== "\t" && c !== "\r") { lineStart = false; hasCode = true; }
    i++;
  }
  yield* flush();
}

function hasCodeIn(sql: string, p: Piece): boolean {
  return p.kind === "literal" || (p.kind === "code" && sql.slice(p.start, p.end).trim() !== "");
}

/**
 * Non-empty statements, trimmed, without their terminator. A statement made
 * only of comments is dropped: there is nothing in it to run. Comments in
 * front of a statement stay with it — a Postgres planner hint lives there.
 */
export function splitSqlStatements(script: string, dialect: DialectName = "postgres", opts: SqlLexOptions = {}): string[] {
  const statements: string[] = [];
  let from = 0;
  let hasCode = false;
  const push = (to: number) => {
    const text = script.slice(from, to).trim();
    if (hasCode && text) statements.push(text);
    hasCode = false;
  };
  for (const p of lex(script, dialect, opts)) {
    if (p.kind === "end" || p.kind === "directive") {
      push(p.start);
      from = p.end;
    } else if (hasCodeIn(script, p)) hasCode = true;
  }
  push(script.length);
  return statements;
}

/**
 * One statement's code with comments removed and every string and quoted
 * name replaced by an empty one, so a keyword search sees only keywords.
 */
export function sqlCode(statement: string, dialect: DialectName = "postgres", opts: SqlLexOptions = {}): string {
  let out = "";
  for (const p of lex(statement, dialect, opts)) {
    const text = statement.slice(p.start, p.end);
    if (p.kind === "code") out += text;
    else if (p.kind === "literal") out += text[0] === '"' || text[0] === "`" || text[0] === "[" ? ' "" ' : " '' ";
    else if (p.kind === "comment") out += " ";
    else if (p.kind === "end") out += ";";
    else out += " ";
  }
  return out;
}

/** A MySQL `DELIMITER` line, and the terminator it sets for what follows. */
export interface DelimiterDirective {
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past its last character, before the line break. */
  end: number;
  delimiter: string;
}

/**
 * A MySQL script's `DELIMITER` lines, read where the mysql client reads them — not inside a
 * string, a comment or an unfinished statement. Other dialects have none.
 */
export function delimiterDirectives(text: string, dialect: DialectName = "postgres"): DelimiterDirective[] {
  const found: DelimiterDirective[] = [];
  for (const p of lex(text, dialect)) {
    if (p.kind === "directive") found.push({ start: p.start, end: p.end, delimiter: DELIMITER_LINE.exec(text.slice(p.start, p.end))![1]! });
  }
  return found;
}

export interface SqlStatement {
  /** From the statement's first token through its terminator, as typed. */
  sql: string;
  /**
   * What to send to run just this statement. The same as `sql`, except after
   * a MySQL `DELIMITER` line: then the statement goes out with that line in
   * front, or the server would split a procedure body at its semicolons.
   */
  run: string;
  /** 1-based line of the statement's first token (blank/comment lines skipped). */
  startLine: number;
  /** 1-based line the statement ends on. */
  endLine: number;
}

/** The 1-based line `offset` of `text` is on; `lines` is how many there are. */
function lineLocator(text: string): { lineAt: (offset: number) => number; lines: number } {
  const newlines: number[] = [];
  for (let k = text.indexOf("\n"); k !== -1; k = text.indexOf("\n", k + 1)) newlines.push(k);
  /** 1 + the line breaks before `offset`. */
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  return { lineAt, lines: newlines.length + 1 };
}

/** Statements with where they sit, for Run buttons beside each one. */
export function splitSqlStatementsWithLines(text: string, dialect: DialectName = "postgres"): SqlStatement[] {
  const { lineAt, lines } = lineLocator(text);
  const statements: SqlStatement[] = [];
  let delimiter = ";";
  let first = -1;
  const push = (end: number, endLine: number, terminated: boolean) => {
    if (first === -1) return;
    const sql = text.slice(first, end).trim();
    if (sql) {
      let run = sql;
      if (delimiter !== ";") {
        // The server splits again, so the DELIMITER that made this one statement goes with it.
        const body = terminated ? sql.slice(0, sql.length - delimiter.length).trimEnd() : sql;
        run = `DELIMITER ${delimiter}\n${body}\n${delimiter}`;
      }
      statements.push({ sql, run, startLine: lineAt(first), endLine });
    }
    first = -1;
  };

  for (const p of lex(text, dialect)) {
    if (p.kind === "directive") {
      delimiter = DELIMITER_LINE.exec(text.slice(p.start, p.end))![1]!;
      continue;
    }
    if (p.kind === "comment") continue;
    if (first === -1) {
      const lead = text.slice(p.start, p.end).search(/\S/);
      if (lead !== -1) first = p.start + lead;
    }
    if (p.kind === "end") push(p.end, lineAt(p.start), true);
  }
  push(text.length, lines, false);
  return statements;
}

export interface SqlScriptStatement {
  /** What to send to run it: as `splitSqlStatements` gives it — trimmed, without its terminator. */
  sql: string;
  /** 1-based line of `sql`'s first character, which may be a comment in front of the statement. */
  firstLine: number;
  /** 1-based line of the statement's first keyword, where an editor marks it. */
  startLine: number;
  /** 1-based line it ends on: its terminator's, or its last character's. */
  endLine: number;
}

/**
 * A script's statements as the server runs them, one by one, each with the lines it sits on in the
 * text, so what is said about a statement — its error above all — can point into the editor.
 */
export function splitSqlScript(script: string, dialect: DialectName = "postgres", opts: SqlLexOptions = {}): SqlScriptStatement[] {
  const { lineAt } = lineLocator(script);
  const statements: SqlScriptStatement[] = [];
  let from = 0;
  let codeStart = -1;
  const push = (to: number, terminator: number | null) => {
    const raw = script.slice(from, to);
    const sql = raw.trim();
    if (codeStart !== -1 && sql) {
      const first = from + raw.length - raw.trimStart().length;
      const last = terminator ?? first + sql.length - 1;
      statements.push({ sql, firstLine: lineAt(first), startLine: lineAt(codeStart), endLine: lineAt(last) });
    }
    codeStart = -1;
  };
  for (const p of lex(script, dialect, opts)) {
    if (p.kind === "end" || p.kind === "directive") {
      push(p.start, p.kind === "end" ? p.start : null);
      from = p.end;
    } else if (codeStart === -1 && hasCodeIn(script, p)) {
      codeStart = p.start + Math.max(0, script.slice(p.start, p.end).search(/\S/));
    }
  }
  push(script.length, null);
  return statements;
}

/** The script line an error points at, from its 1-based character `position` in `statement.sql`. */
export function lineOfPosition(statement: Pick<SqlScriptStatement, "sql" | "firstLine">, position: number): number {
  const before = statement.sql.slice(0, Math.max(0, position - 1));
  let breaks = 0;
  for (let k = before.indexOf("\n"); k !== -1; k = before.indexOf("\n", k + 1)) breaks++;
  return statement.firstLine + breaks;
}

/**
 * The statement the cursor sits in. Falls back to the next statement below
 * the cursor (cursor parked on a blank line between statements), then to the
 * last; null when the text holds none.
 */
export function statementAtCursor(text: string, cursorLine: number, dialect: DialectName = "postgres"): SqlStatement | null {
  return statementAt(splitSqlStatementsWithLines(text, dialect), cursorLine);
}

/** `statementAtCursor` over statements already split. */
export function statementAt(statements: readonly SqlStatement[], cursorLine: number): SqlStatement | null {
  if (statements.length === 0) return null;
  return statements.find((s) => s.startLine <= cursorLine && cursorLine <= s.endLine)
    ?? statements.find((s) => s.startLine > cursorLine)
    ?? statements[statements.length - 1]!;
}

/** What to run for the statement the cursor sits in (see `statementAtCursor`). */
export function getStatementAtCursor(text: string, cursorLine: number, dialect: DialectName = "postgres"): string {
  return statementAtCursor(text, cursorLine, dialect)?.run ?? "";
}

/**
 * The lines of the text above the first line of `statement.run`, so a line the
 * server names in what it ran maps back: line N of `run` is line N + this.
 * A `DELIMITER` line sent in front of the statement is a line of `run` that
 * the text has elsewhere.
 */
export function runLineOffset(statement: SqlStatement): number {
  return statement.startLine - (statement.run === statement.sql ? 1 : 2);
}
