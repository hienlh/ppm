import { randomUUID } from "node:crypto";
import { getDb } from "../db.service.ts";
import type { ApprovalRuleKind } from "../../shared/remembered-approval-pattern.ts";

/**
 * Storage for remembered approvals (`approval_rules`, migration 81) and for how many times the user
 * approved each pattern by hand (`approval_pattern_tallies`), which is only ever used to suggest
 * remembering one. Rules are keyed by the project's folder (`projectKey`), not its name.
 */

export interface ApprovalRuleRow {
  id: string;
  projectKey: string;
  projectName: string;
  kind: ApprovalRuleKind;
  pattern: string;
  label: string;
  createdAt: number;
  /** Where the press that made it came from: `chat`, `assistant_card` or `telegram`. */
  createdVia: string;
  lastUsedAt: number | null;
  useCount: number;
}

interface Raw {
  id: string; project_key: string; project_name: string; kind: string; pattern: string; label: string;
  created_at: number; created_via: string; last_used_at: number | null; use_count: number;
}

const COLUMNS = "id, project_key, project_name, kind, pattern, label, created_at, created_via, last_used_at, use_count";

const toRow = (r: Raw): ApprovalRuleRow => ({
  id: r.id, projectKey: r.project_key, projectName: r.project_name, kind: r.kind as ApprovalRuleKind, pattern: r.pattern,
  label: r.label, createdAt: r.created_at, createdVia: r.created_via, lastUsedAt: r.last_used_at, useCount: r.use_count,
});

/** Stores a rule; the existing one when the project already has the same kind and pattern. */
export function insertApprovalRule(input: Omit<ApprovalRuleRow, "id" | "lastUsedAt" | "useCount">): { row: ApprovalRuleRow; created: boolean } {
  const db = getDb();
  const existing = db.query(`SELECT ${COLUMNS} FROM approval_rules WHERE project_key = ? AND kind = ? AND pattern = ?`)
    .get(input.projectKey, input.kind, input.pattern) as Raw | null;
  if (existing) return { row: toRow(existing), created: false };
  const id = randomUUID();
  db.query(`INSERT INTO approval_rules (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`)
    .run(id, input.projectKey, input.projectName, input.kind, input.pattern, input.label, input.createdAt, input.createdVia);
  return { row: toRow(db.query(`SELECT ${COLUMNS} FROM approval_rules WHERE id = ?`).get(id) as Raw), created: true };
}

/** Every rule, newest first; one project's when `projectKey` names it. */
export function listApprovalRules(projectKey?: string): ApprovalRuleRow[] {
  const rows = projectKey === undefined
    ? getDb().query(`SELECT ${COLUMNS} FROM approval_rules ORDER BY created_at DESC, rowid DESC`).all()
    : getDb().query(`SELECT ${COLUMNS} FROM approval_rules WHERE project_key = ? ORDER BY created_at DESC, rowid DESC`).all(projectKey);
  return (rows as Raw[]).map(toRow);
}

export function deleteApprovalRule(id: string): boolean {
  return getDb().query("DELETE FROM approval_rules WHERE id = ?").run(id).changes > 0;
}

/** A rule just approved a request. */
export function touchApprovalRule(id: string, at: number): void {
  getDb().query("UPDATE approval_rules SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?").run(at, id);
}

/** Counts one more approval of `pattern` the user gave by hand; returns the new count. */
export function tallyApproval(projectKey: string, kind: string, pattern: string, at: number): number {
  const db = getDb();
  db.query(`INSERT INTO approval_pattern_tallies (project_key, kind, pattern, approvals, last_at) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT (project_key, kind, pattern) DO UPDATE SET approvals = approvals + 1, last_at = excluded.last_at`)
    .run(projectKey, kind, pattern, at);
  return approvalTally(projectKey, kind, pattern);
}

export function approvalTally(projectKey: string, kind: string, pattern: string): number {
  const row = getDb().query("SELECT approvals FROM approval_pattern_tallies WHERE project_key = ? AND kind = ? AND pattern = ?")
    .get(projectKey, kind, pattern) as { approvals: number } | null;
  return row?.approvals ?? 0;
}
