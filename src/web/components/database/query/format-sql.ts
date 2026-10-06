/**
 * The Query tab's Format, DBGate's "Format code" (Shift+Alt+F): the whole script laid out by
 * sql-formatter in the engine's own dialect, keyword case left as typed.
 */
import { formatDialect, mariadb, mysql, postgresql, sqlite, type DialectOptions } from "sql-formatter";
import { dialectNameOf, type DbType } from "../../../../shared/db-types";
import { delimiterDirectives } from "../../../../shared/split-sql-statements";

const DIALECTS: Record<DbType, DialectOptions> = { postgres: postgresql, mysql, mariadb, sqlite };

/**
 * The longest script Format takes on. The formatter runs on the page and its parser grows with the
 * text: measured, 1 MB took 3 s and 400 MB, 2 MB 6 s and 1.3 GB.
 */
export const FORMAT_MAX_CHARS = 500_000;

function lineBreaks(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * Text run under `;`, laid out, with the line breaks around it kept. `linesBefore` counts the
 * script's line breaks above it, so a complaint names the line as the editor numbers it.
 */
function formatPart(text: string, dialect: DialectOptions, linesBefore: number): string {
  if (!text.trim()) return text;
  let formatted: string;
  try {
    formatted = formatDialect(text, { dialect, tabWidth: 2 });
  } catch (e) {
    // The first line says what and where; the rest is the parser's grammar.
    const what = (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
    throw new Error(what.replace(/at line (\d+)/, (_, n: string) => `at line ${Number(n) + linesBefore}`));
  }
  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  return "\n".repeat(lineBreaks(lead)) + formatted + "\n".repeat(lineBreaks(trail));
}

/**
 * `sql` laid out by sql-formatter. A MySQL script is formatted between its `DELIMITER` lines: the
 * formatter knows only `;`, so those lines, and what runs under another terminator — a procedure
 * body — stay as typed. Throws what the formatter could not read, its line counted in `sql`.
 */
export function formatSqlScript(sql: string, engine: DbType): string {
  if (sql.length > FORMAT_MAX_CHARS) {
    throw new Error(`The script is longer than ${FORMAT_MAX_CHARS.toLocaleString("en-US")} characters.`);
  }
  const dialect = DIALECTS[engine];
  let out = "";
  let from = 0;
  let delimiter = ";";
  const part = (to: number) => {
    const text = sql.slice(from, to);
    out += delimiter === ";" ? formatPart(text, dialect, lineBreaks(sql.slice(0, from))) : text;
  };
  for (const d of delimiterDirectives(sql, dialectNameOf(engine))) {
    part(d.start);
    out += sql.slice(d.start, d.end);
    from = d.end;
    delimiter = d.delimiter;
  }
  part(sql.length);
  return out;
}
