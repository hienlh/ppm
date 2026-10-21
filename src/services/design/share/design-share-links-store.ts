import { getDb } from "../../db.service.ts";
import { SHARE_LIMITS } from "../../../shared/design-share-types.ts";

/** Rows of `design_share_links`. No column holds a code: only `code_hash`. */

export interface ShareLinkRecord {
  id: string;
  codeHash: string;
  codeVersion: number;
  projectPath: string;
  projectKey: string;
  slug: string;
  snapshotId: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface ShareLinkRow {
  id: string;
  code_hash: string;
  code_version: number;
  project_path: string;
  project_key: string;
  slug: string;
  snapshot_id: string;
  label: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

function toRecord(r: ShareLinkRow): ShareLinkRecord {
  return {
    id: r.id,
    codeHash: r.code_hash,
    codeVersion: r.code_version,
    projectPath: r.project_path,
    projectKey: r.project_key,
    slug: r.slug,
    snapshotId: r.snapshot_id,
    label: r.label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  };
}

const COLUMNS = "id, code_hash, code_version, project_path, project_key, slug, snapshot_id, label, created_at, updated_at, expires_at, revoked_at";

/**
 * Insert a link unless its design already has {@link SHARE_LIMITS.maxLinksPerDesign}.
 * Count and insert run in one transaction, so two creates cannot both take the last slot.
 */
export function insertShareLink(record: ShareLinkRecord): boolean {
  const db = getDb();
  return db.transaction(() => {
    const { n } = db.query("SELECT COUNT(*) AS n FROM design_share_links WHERE project_key = ? AND slug = ?")
      .get(record.projectKey, record.slug) as { n: number };
    if (n >= SHARE_LIMITS.maxLinksPerDesign) return false;
    db.query(`INSERT INTO design_share_links (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.codeHash, record.codeVersion, record.projectPath, record.projectKey, record.slug,
      record.snapshotId, record.label, record.createdAt, record.updatedAt, record.expiresAt, record.revokedAt,
    );
    return true;
  }).immediate();
}

export function getShareLink(id: string): ShareLinkRecord | null {
  const row = getDb().query(`SELECT ${COLUMNS} FROM design_share_links WHERE id = ?`).get(id) as ShareLinkRow | null;
  return row ? toRecord(row) : null;
}

export function getShareLinkByCodeHash(codeHash: string): ShareLinkRecord | null {
  const row = getDb().query(`SELECT ${COLUMNS} FROM design_share_links WHERE code_hash = ?`).get(codeHash) as ShareLinkRow | null;
  return row ? toRecord(row) : null;
}

/** One design's links, oldest first. */
export function listShareLinksForDesign(projectKey: string, slug: string): ShareLinkRecord[] {
  const rows = getDb().query(`SELECT ${COLUMNS} FROM design_share_links WHERE project_key = ? AND slug = ? ORDER BY created_at, id`)
    .all(projectKey, slug) as ShareLinkRow[];
  return rows.map(toRecord);
}

/** What one owner request changes on a link. Absent fields are left as the row has them. */
export interface ShareLinkChange {
  updatedAt: number;
  label?: string;
  expiresAt?: number | null;
  revoke?: boolean;
  /** Issue the next code: the hash of the code for a given version. */
  newCodeHash?: (version: number) => string;
  snapshotId?: string;
}

export type ShareLinkChangeResult =
  | { record: ShareLinkRecord; previous: ShareLinkRecord }
  | "missing"
  | "revoked";

/**
 * Apply `change` to the row as it is now, in one transaction, writing only the columns the
 * change names. The caller may have awaited a snapshot since it last read the row, and a
 * revoke, new code or expiry committed meanwhile must survive: a new code counts up from the
 * stored version, `revoked_at` once set is never cleared, and a re-pin or new code on a row
 * revoked meanwhile is refused instead of applied.
 */
export function applyShareLinkChange(id: string, change: ShareLinkChange): ShareLinkChangeResult {
  const db = getDb();
  return db.transaction((): ShareLinkChangeResult => {
    const previous = getShareLink(id);
    if (!previous) return "missing";
    if ((change.newCodeHash || change.snapshotId !== undefined) && previous.revokedAt !== null) return "revoked";
    const sets = ["updated_at = ?"];
    const values: (string | number | null)[] = [change.updatedAt];
    const set = (column: string, value: string | number | null) => { sets.push(`${column} = ?`); values.push(value); };
    if (change.label !== undefined) set("label", change.label);
    if (change.expiresAt !== undefined) set("expires_at", change.expiresAt);
    if (change.snapshotId !== undefined) set("snapshot_id", change.snapshotId);
    if (change.newCodeHash) {
      const version = previous.codeVersion + 1;
      set("code_version", version);
      set("code_hash", change.newCodeHash(version));
    }
    if (change.revoke) {
      sets.push("revoked_at = COALESCE(revoked_at, ?)");
      values.push(change.updatedAt);
    }
    db.query(`UPDATE design_share_links SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return { record: getShareLink(id)!, previous };
  }).immediate();
}

export function deleteShareLinkRow(id: string): boolean {
  return getDb().query("DELETE FROM design_share_links WHERE id = ?").run(id).changes > 0;
}

/** Remove every link of a design; returns how many went. */
export function deleteShareLinksForDesign(projectKey: string, slug: string): number {
  return getDb().query("DELETE FROM design_share_links WHERE project_key = ? AND slug = ?").run(projectKey, slug).changes;
}

/**
 * Snapshots a design's links pin, which pruning must keep. Expired links count too, because
 * the owner may extend them; revoked ones do not, because revoking is final.
 */
export function pinnedSnapshotIds(projectKey: string, slug: string): Set<string> {
  const rows = getDb().query(
    "SELECT DISTINCT snapshot_id FROM design_share_links WHERE project_key = ? AND slug = ? AND revoked_at IS NULL",
  ).all(projectKey, slug) as { snapshot_id: string }[];
  return new Set(rows.map((r) => r.snapshot_id));
}
