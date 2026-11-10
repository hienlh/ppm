import { getDb } from "../db.service.ts";

/**
 * A project's manager rules as stored on its `manager_chats` row (columns from migration 64):
 * - `approved`: what the user approved — their own edit, an approved change, or the template seed;
 * - `accepted`: the rules in force — `approved` plus additions PPM let through; the file on disk
 *   is kept equal to this;
 * - `proposed` + `pendingHash`: a held change, kept off disk until the user decides.
 * Every write that settles a held change is compare-and-set on the hash, so the first answer wins.
 */
export interface ManagerRules {
  approved: string | null;
  accepted: string | null;
  proposed: string | null;
  pendingHash: string | null;
  approvedAt: number | null;
}

interface Row {
  rules_approved: string | null;
  rules_accepted: string | null;
  rules_proposed: string | null;
  rules_pending_hash: string | null;
  rules_approved_at: number | null;
}

export function getManagerRules(projectKey: string): ManagerRules | null {
  const row = getDb().query(
    "SELECT rules_approved, rules_accepted, rules_proposed, rules_pending_hash, rules_approved_at FROM manager_chats WHERE project_key = ?",
  ).get(projectKey) as Row | null;
  if (!row) return null;
  return {
    approved: row.rules_approved, accepted: row.rules_accepted, proposed: row.rules_proposed,
    pendingHash: row.rules_pending_hash, approvedAt: row.rules_approved_at,
  };
}

/** First rules for a project: only while none were ever set. False when some already were. */
export function seedManagerRules(projectKey: string, template: string, held: { text: string; hash: string } | null, now: number): boolean {
  return getDb().query(`
    UPDATE manager_chats SET rules_approved = ?, rules_accepted = ?, rules_proposed = ?, rules_pending_hash = ?, rules_approved_at = ?
    WHERE project_key = ? AND rules_approved IS NULL
  `).run(template, template, held?.text ?? null, held?.hash ?? null, now, projectKey).changes > 0;
}

/** The manager's additions, let through: the rules in force grow, the approved ones stay. */
export function acceptManagerRules(projectKey: string, accepted: string): void {
  getDb().query("UPDATE manager_chats SET rules_accepted = ? WHERE project_key = ?").run(accepted, projectKey);
}

/** A change held for the user, replacing any change held before it. */
export function holdManagerRules(projectKey: string, proposed: string, hash: string): void {
  getDb().query("UPDATE manager_chats SET rules_proposed = ?, rules_pending_hash = ? WHERE project_key = ?").run(proposed, hash, projectKey);
}

/** Drops the held change named by `hash`. False when that is not the change held now. */
export function clearHeldManagerRules(projectKey: string, hash: string): boolean {
  return getDb().query(
    "UPDATE manager_chats SET rules_proposed = NULL, rules_pending_hash = NULL WHERE project_key = ? AND rules_pending_hash = ?",
  ).run(projectKey, hash).changes > 0;
}

/** The held change named by `hash` becomes the approved rules. Null when that is not the change held now. */
export function approveHeldManagerRules(projectKey: string, hash: string, now: number): string | null {
  const db = getDb();
  return db.transaction(() => {
    const rules = getManagerRules(projectKey);
    if (!rules || rules.pendingHash !== hash || rules.proposed === null) return null;
    db.query(`
      UPDATE manager_chats SET rules_approved = rules_proposed, rules_accepted = rules_proposed, rules_approved_at = ?,
        rules_proposed = NULL, rules_pending_hash = NULL
      WHERE project_key = ? AND rules_pending_hash = ?
    `).run(now, projectKey, hash);
    return rules.proposed;
  })();
}

/** The user's own text: approved and in force at once; a held change is dropped with it. */
export function setManagerRulesByUser(projectKey: string, text: string, now: number): boolean {
  return getDb().query(`
    UPDATE manager_chats SET rules_approved = ?, rules_accepted = ?, rules_approved_at = ?, rules_proposed = NULL, rules_pending_hash = NULL
    WHERE project_key = ?
  `).run(text, text, now, projectKey).changes > 0;
}
