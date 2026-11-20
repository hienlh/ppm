import { getDb } from "../db.service.ts";
import type { VaultAttachmentMeta, VaultFileType, VaultLockedTier } from "../../shared/vault.ts";

/**
 * The `vault_attachments` table (migration 78). Plain storage, no crypto and no policy: a row holds
 * the label, type and size anyone may list, the file's random name on disk, and the original name
 * and checksum only as ciphertext.
 */

export interface VaultAttachmentRow {
  id: string;
  item_id: string;
  tier: VaultLockedTier;
  label: string;
  mime: VaultFileType;
  size: number;
  file_id: string;
  meta_nonce: Buffer;
  meta_ciphertext: Buffer;
  created_at: number;
  updated_at: number;
}

const asBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array));

function row(raw: Record<string, unknown>): VaultAttachmentRow {
  return { ...(raw as unknown as VaultAttachmentRow), meta_nonce: asBuffer(raw.meta_nonce), meta_ciphertext: asBuffer(raw.meta_ciphertext) };
}

export const toAttachmentMeta = (r: VaultAttachmentRow): VaultAttachmentMeta => ({
  id: r.id, itemId: r.item_id, label: r.label, type: r.mime, size: r.size, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function listAttachmentRows(itemId?: string): VaultAttachmentRow[] {
  const raws = itemId
    ? getDb().query("SELECT * FROM vault_attachments WHERE item_id = ? ORDER BY created_at, id").all(itemId)
    : getDb().query("SELECT * FROM vault_attachments ORDER BY item_id, created_at, id").all();
  return (raws as Record<string, unknown>[]).map(row);
}

export function getAttachmentRow(id: string): VaultAttachmentRow | null {
  const raw = getDb().query("SELECT * FROM vault_attachments WHERE id = ?").get(id) as Record<string, unknown> | null;
  return raw ? row(raw) : null;
}

export function countItemAttachments(itemId: string): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM vault_attachments WHERE item_id = ?").get(itemId) as { n: number }).n;
}

export function totalAttachmentBytes(): number {
  return (getDb().query("SELECT COALESCE(SUM(size), 0) AS n FROM vault_attachments").get() as { n: number }).n;
}

/** Every file name a row still names, for the sweep that retires the others. */
export function referencedFileIds(): Set<string> {
  return new Set((getDb().query("SELECT file_id FROM vault_attachments").all() as { file_id: string }[]).map((r) => r.file_id));
}

export function insertAttachmentRow(r: VaultAttachmentRow): void {
  getDb().query(
    "INSERT INTO vault_attachments (id, item_id, tier, label, mime, size, file_id, meta_nonce, meta_ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(r.id, r.item_id, r.tier, r.label, r.mime, r.size, r.file_id, r.meta_nonce, r.meta_ciphertext, r.created_at, r.updated_at);
}

/** Overwrites the columns that change: label, tier (a move), file, encrypted meta, time. */
export function updateAttachmentRow(r: VaultAttachmentRow): boolean {
  return getDb().query(
    "UPDATE vault_attachments SET tier = ?, label = ?, file_id = ?, meta_nonce = ?, meta_ciphertext = ?, updated_at = ? WHERE id = ?",
  ).run(r.tier, r.label, r.file_id, r.meta_nonce, r.meta_ciphertext, r.updated_at, r.id).changes > 0;
}

export function deleteAttachmentRow(id: string): boolean {
  return getDb().query("DELETE FROM vault_attachments WHERE id = ?").run(id).changes > 0;
}

/** Removes the rows of an item; their files are retired by the caller. */
export function deleteItemAttachmentRows(itemId: string): string[] {
  const ids = listAttachmentRows(itemId).map((r) => r.file_id);
  getDb().query("DELETE FROM vault_attachments WHERE item_id = ?").run(itemId);
  return ids;
}

/** Removes the rows of a whole tier; their files are retired by the caller. */
export function deleteTierAttachmentRows(tier: VaultLockedTier): string[] {
  const ids = (getDb().query("SELECT file_id FROM vault_attachments WHERE tier = ?").all(tier) as { file_id: string }[]).map((r) => r.file_id);
  getDb().query("DELETE FROM vault_attachments WHERE tier = ?").run(tier);
  return ids;
}
