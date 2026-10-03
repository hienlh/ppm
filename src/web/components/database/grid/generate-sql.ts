/**
 * DBGate's Generate SQL from data: one INSERT, UPDATE or DELETE for each row the selection lies on,
 * writing the value columns ticked and finding the row by the WHERE columns ticked. Values are the
 * ones the grid shows now, edits included; a row is found by what the database holds, so a key
 * edited and not saved yet still finds its row — as Copy as SQL UPDATEs does.
 *
 * Where DBGate writes `WHERE` with nothing after it, or `SET` with nothing to set, this writes no
 * statement and says why: an UPDATE or DELETE without a condition reaches every row of the table.
 * A new row is not in the database yet, so no UPDATE or DELETE is written for it, and a column a new
 * row was given nothing in is left out of its INSERT, as the grid's own Save leaves it out.
 */
import { quoteIdentifier, sqlLiteral } from "../../../../shared/sql-identifiers";
import { sqlKeyCondition, sqlTableName, type CopySqlTarget } from "./copy-as";

export type GeneratedStatement = "INSERT" | "UPDATE" | "DELETE";

/** DBGate's query types, in its order. */
export const STATEMENT_TYPES: readonly GeneratedStatement[] = ["INSERT", "UPDATE", "DELETE"];

/** INSERT and UPDATE write values; UPDATE and DELETE find their row. */
export const takesValues = (type: GeneratedStatement) => type !== "DELETE";
export const takesWhere = (type: GeneratedStatement) => type !== "INSERT";

export interface SqlSourceRow {
  /** Every value the row shows now; a new row's column nothing was put in is undefined. */
  now: Readonly<Record<string, unknown>>;
  /** The row as the database holds it, which UPDATE and DELETE find it by. */
  stored: Readonly<Record<string, unknown>>;
  /** Not saved yet. */
  isNew: boolean;
}

export type GeneratedSql =
  /** `overLimit`: the text passed `maxChars`, where writing stopped; `statements` holds what was written by then. */
  | { ok: true; statements: string[]; overLimit: boolean }
  | { ok: false; reason: string };

/**
 * The statements for `rows`, the columns in the order given. Writing stops once the text — the
 * statements a line each — passes `maxChars`: a whole column of a fetched-all table is a great many
 * rows, and SQL past what OK can open is not worth writing out.
 */
export function generateSql(
  type: GeneratedStatement,
  rows: Iterable<SqlSourceRow>,
  valueColumns: readonly string[],
  whereColumns: readonly string[],
  target: Omit<CopySqlTarget, "keyColumns">,
  maxChars = Infinity,
): GeneratedSql {
  if (takesValues(type) && !valueColumns.length) return { ok: false, reason: "Tick a value column" };
  if (takesWhere(type) && !whereColumns.length) {
    return { ok: false, reason: "Tick a WHERE column: without one, the statement would reach every row of the table" };
  }
  const table = sqlTableName(target);
  const name = (column: string) => quoteIdentifier(column, target.dialect);
  const literal = (row: Readonly<Record<string, unknown>>, column: string) =>
    sqlLiteral(row[column], target.dialect, target.kinds?.get(column));

  const statements: string[] = [];
  let seen = 0;
  let unsaved = 0;
  let chars = -1;
  for (const row of rows) {
    seen += 1;
    if (takesWhere(type) && row.isNew) {
      unsaved += 1;
      continue;
    }
    const set = takesValues(type) ? valueColumns.filter((c) => row.now[c] !== undefined) : [];
    if (takesValues(type) && !set.length) continue;
    const where = takesWhere(type) ? sqlKeyCondition(row.stored, whereColumns, target) : "";
    const statement = type === "INSERT"
      ? `INSERT INTO ${table} (${set.map(name).join(", ")}) VALUES (${set.map((c) => literal(row.now, c)).join(", ")});`
      : type === "UPDATE"
        ? `UPDATE ${table} SET ${set.map((c) => `${name(c)}=${literal(row.now, c)}`).join(", ")} WHERE ${where};`
        : `DELETE FROM ${table} WHERE ${where};`;
    statements.push(statement);
    // Each statement after the first takes a line break too.
    chars += statement.length + 1;
    if (chars > maxChars) return { ok: true, statements, overLimit: true };
  }
  if (statements.length) return { ok: true, statements, overLimit: false };
  return {
    ok: false,
    reason: !seen ? "Select the rows to write SQL for"
      : unsaved === seen ? "New rows are not in the database yet: no UPDATE or DELETE can find them"
        : "No row selected holds a value in the columns ticked",
  };
}

/**
 * The most SQL OK opens in a Query tab. The tab keeps its text in the layout this browser saves,
 * twice over, beside every other tab of every project in one storage quota of a few million
 * characters; a layout past it is not saved at all, and the project's tabs then reopen as they
 * were before.
 */
export const GENERATED_SQL_MAX_CHARS = 250_000;

/** The statements the preview shows; OK opens them all. */
export const PREVIEW_STATEMENTS = 200;
