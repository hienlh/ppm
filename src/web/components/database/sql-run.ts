/**
 * What the Query tab's keys send: F5 the selection or else the whole script, Ctrl+Enter the
 * statement at the cursor — split as the server splits it — and with each, where in the editor
 * the text sent begins, so the lines the server answers with can be put back where they are.
 */
import { runLineOffset, statementAtCursor } from "../../../shared/split-sql-statements";
import type { DialectName } from "../../../shared/db-types";

export type SqlRunFrom = "script" | "selection" | "statement";

export interface SqlRun {
  sql: string;
  /** The editor's line of the text's line 1, less one. */
  lineOffset: number;
  from: SqlRunFrom;
}

/** The text selected and the editor line it begins on. */
export interface EditorSelection {
  text: string;
  startLine: number;
}

/** F5: the selection, when anything is selected, else the whole script. Null when there is nothing to run. */
export function scriptRun(text: string, selection: EditorSelection | null): SqlRun | null {
  if (selection?.text.trim()) return { sql: selection.text, lineOffset: selection.startLine - 1, from: "selection" };
  return text.trim() ? { sql: text, lineOffset: 0, from: "script" } : null;
}

/** Ctrl+Enter: the statement the cursor is in — or the next one below it, or the last. */
export function statementRun(text: string, cursorLine: number, dialect: DialectName): SqlRun | null {
  const statement = statementAtCursor(text, cursorLine, dialect);
  return statement ? { sql: statement.run, lineOffset: runLineOffset(statement), from: "statement" } : null;
}

/** Explain: the selection, when anything is selected, else the statement at the cursor. */
export function selectionOrStatementRun(text: string, selection: EditorSelection | null, cursorLine: number, dialect: DialectName): SqlRun | null {
  if (selection?.text.trim()) return { sql: selection.text, lineOffset: selection.startLine - 1, from: "selection" };
  return statementRun(text, cursorLine, dialect);
}
