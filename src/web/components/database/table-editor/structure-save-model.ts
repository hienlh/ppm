/**
 * What the Save changes dialog reads out of the server's answers: a newer script when the table
 * changed under the one it showed (409), and where a script stopped when it failed — each of its
 * statements marked as the "Error when saving" dialog lists them. Pure, so it is tested without a
 * browser.
 */
import type { StructureFailure, StructurePreview, StructureStatement } from "../../../../shared/db-structure-change";

/**
 * What became of one statement of a script that failed: it ran and stays applied (MySQL commits
 * each DDL statement; SQLite's `PRAGMA foreign_keys` outside the transaction), it ran and was
 * rolled back with the rest (one transaction), it is the one that failed, or it never ran. A
 * comment has nothing to run, so it has no outcome — unless it stands for a check that failed.
 */
export type StatementOutcome = "ran" | "rolled-back" | "failed" | "not-run";

export interface StatementReport {
  sql: string;
  outcome: StatementOutcome | null;
}

const isComment = (sql: string) => sql.startsWith("--");

/**
 * The script's statements as the failure left them. `index` counts every statement of the
 * preview, comments included; -1 is the COMMIT that ends a transaction, which is then listed where
 * it ran: after the transaction's statements, before those that run after it.
 */
export function statementReports(preview: Pick<StructurePreview, "statements" | "transactional">, failure: Pick<StructureFailure, "index">): StatementReport[] {
  const commitFailed = failure.index < 0;
  const outcomeOf = (s: StructureStatement, i: number): StatementOutcome | null => {
    if (i === failure.index) return "failed";
    if (isComment(s.sql)) return null;
    // Run whether or not the transaction committed, and even when one before it failed.
    if (s.phase === "after") return "ran";
    if (!commitFailed && i > failure.index) return "not-run";
    return s.phase === "before" || !preview.transactional ? "ran" : "rolled-back";
  };
  const reports = preview.statements.map((s, i): StatementReport => ({ sql: s.sql, outcome: outcomeOf(s, i) }));
  if (!commitFailed) return reports;
  const commit: StatementReport = { sql: "COMMIT;", outcome: "failed" };
  const after = preview.statements.findIndex((s) => s.phase === "after");
  return after < 0 ? [...reports, commit] : [...reports.slice(0, after), commit, ...reports.slice(after)];
}

export const OUTCOME_LABEL: Record<StatementOutcome, string> = {
  ran: "Ran",
  "rolled-back": "Rolled back",
  failed: "Failed",
  "not-run": "Did not run",
};

function dataOf(body: unknown): Record<string, unknown> | null {
  const data = (body as { data?: unknown } | null)?.data;
  return typeof data === "object" && data !== null ? data as Record<string, unknown> : null;
}

function statementOf(value: unknown): StructureStatement | null {
  const s = value as { sql?: unknown; phase?: unknown } | null;
  if (typeof s !== "object" || s === null || typeof s.sql !== "string") return null;
  if (s.phase === "before" || s.phase === "after") return { sql: s.sql, phase: s.phase };
  return s.phase === undefined ? { sql: s.sql } : null;
}

/** The newer script a 409 carries when the table changed since the dialog read its script. */
export function newerPreviewOf(body: unknown): StructurePreview | null {
  const d = dataOf(body);
  const statements = Array.isArray(d?.statements) ? d.statements.map(statementOf) : null;
  if (!d || typeof d.sql !== "string" || !statements || statements.some((s) => s === null)) return null;
  // Whether what ran stays applied is what the failure report rests on: never guessed.
  if (typeof d.recreate !== "boolean" || typeof d.transactional !== "boolean") return null;
  return {
    sql: d.sql,
    statements: statements as StructureStatement[],
    recreate: d.recreate,
    warnings: Array.isArray(d.warnings) ? d.warnings.filter((w): w is string => typeof w === "string") : [],
    transactional: d.transactional,
  };
}

/** Where a failed script stopped, when the server could say. */
export function failureOf(body: unknown): StructureFailure | null {
  const d = dataOf(body);
  if (!d || typeof d.index !== "number" || !Number.isInteger(d.index) || typeof d.statement !== "string") return null;
  return {
    statement: d.statement,
    index: d.index,
    applied: typeof d.applied === "number" ? d.applied : 0,
    total: typeof d.total === "number" ? d.total : 0,
  };
}
