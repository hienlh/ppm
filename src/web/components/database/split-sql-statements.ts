export interface SqlStatement {
  /** Statement text from its first token through its terminating semicolon. */
  sql: string;
  /** 1-based line of the statement's first token (blank/comment lines skipped). */
  startLine: number;
  /** 1-based line the statement ends on. */
  endLine: number;
}

const IDENT_CHAR = /[A-Za-z0-9_]/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Split SQL into statements on top-level semicolons.
 *
 * A semicolon only terminates a statement when it is not inside a string, a
 * quoted identifier, a comment, or a dollar-quoted block — so a trailing
 * `-- comment` after the semicolon, or a `;` inside a literal, no longer glues
 * two statements together.
 */
export function splitSqlStatements(text: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let line = 1;
  let firstTokenIdx = -1;
  let firstTokenLine = 1;
  let i = 0;

  const flush = (endIdx: number, endLine: number) => {
    if (firstTokenIdx === -1) return;
    const sql = text.slice(firstTokenIdx, endIdx).trim();
    if (sql) statements.push({ sql, startLine: firstTokenLine, endLine });
    firstTokenIdx = -1;
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\n") { line++; i++; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }

    // Line comment — runs to end of line, never part of a statement's start
    if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    // Block comment — Postgres allows these to nest
    if (ch === "/" && text[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") { depth++; i += 2; continue; }
        if (text[i] === "*" && text[i + 1] === "/") { depth--; i += 2; continue; }
        if (text[i] === "\n") line++;
        i++;
      }
      continue;
    }

    if (firstTokenIdx === -1) { firstTokenIdx = i; firstTokenLine = line; }

    if (ch === ";") { flush(i + 1, line); i++; continue; }

    // String literal or quoted identifier
    if (ch === "'" || ch === '"') {
      // E'...' honours backslash escapes; plain strings only double the quote
      const prev = text[i - 1];
      const prev2 = text[i - 2];
      const escapes = ch === "'" && (prev === "e" || prev === "E") && !(prev2 !== undefined && IDENT_CHAR.test(prev2));
      i++;
      while (i < text.length) {
        const c = text[i]!;
        if (c === "\n") { line++; i++; continue; }
        if (escapes && c === "\\") { i += 2; continue; }
        if (c === ch) {
          if (text[i + 1] === ch) { i += 2; continue; } // doubled quote = literal
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Dollar-quoted block ($$ … $$ / $tag$ … $tag$) — bodies hold their own semicolons
    if (ch === "$") {
      const m = DOLLAR_TAG.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        const stop = close === -1 ? text.length : close + tag.length;
        for (let k = i; k < stop; k++) if (text[k] === "\n") line++;
        i = stop;
        continue;
      }
    }

    i++;
  }

  flush(text.length, line);
  return statements;
}

/**
 * The statement the cursor sits in. Falls back to the next statement below the
 * cursor (cursor parked on a blank line between statements), then to the last.
 */
export function getStatementAtCursor(text: string, cursorLine: number): string {
  const statements = splitSqlStatements(text);
  if (statements.length === 0) return "";
  const containing = statements.find((s) => s.startLine <= cursorLine && cursorLine <= s.endLine);
  if (containing) return containing.sql;
  const following = statements.find((s) => s.startLine > cursorLine);
  return (following ?? statements[statements.length - 1]!).sql;
}
