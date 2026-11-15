import { getDb } from "../db.service.ts";
import type { VaultItemKind, VaultItemMeta, VaultLockedTier, VaultTier } from "../../shared/vault.ts";

/**
 * The vault's two tables (migration 73). Plain storage: no crypto and no policy here; the rows
 * of a locked tier carry only ciphertext, so nothing read from this module is ever a secret
 * except the public tier's `value_plain`.
 */

export interface VaultKeyRow {
  tier: VaultLockedTier;
  kdf: string;
  kdf_params: string;
  salt: Buffer;
  dek_nonce: Buffer;
  wrapped_dek: Buffer;
  created_at: number;
  failed_attempts: number;
  locked_until: number;
}

export interface VaultItemRow {
  id: string;
  tier: VaultTier;
  name: string;
  kind: VaultItemKind;
  value_plain: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  created_at: number;
  updated_at: number;
}

const asBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array));

function keyRow(raw: Record<string, unknown> | null): VaultKeyRow | null {
  if (!raw) return null;
  return {
    ...(raw as unknown as VaultKeyRow),
    salt: asBuffer(raw.salt), dek_nonce: asBuffer(raw.dek_nonce), wrapped_dek: asBuffer(raw.wrapped_dek),
  };
}

function itemRow(raw: Record<string, unknown>): VaultItemRow {
  return {
    ...(raw as unknown as VaultItemRow),
    ciphertext: raw.ciphertext == null ? null : asBuffer(raw.ciphertext),
    nonce: raw.nonce == null ? null : asBuffer(raw.nonce),
  };
}

export const toMeta = (r: VaultItemRow): VaultItemMeta => ({
  id: r.id, tier: r.tier, name: r.name, kind: r.kind, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function getKeyRow(tier: VaultLockedTier): VaultKeyRow | null {
  return keyRow(getDb().query("SELECT * FROM vault_keys WHERE tier = ?").get(tier) as Record<string, unknown> | null);
}

export function insertKeyRow(row: Omit<VaultKeyRow, "failed_attempts" | "locked_until">): void {
  getDb().query(
    "INSERT INTO vault_keys (tier, kdf, kdf_params, salt, dek_nonce, wrapped_dek, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.tier, row.kdf, row.kdf_params, row.salt, row.dek_nonce, row.wrapped_dek, row.created_at);
}

/** Replaces the wrapping of a tier's data key (password change); the counter starts again. */
export function rewrapKeyRow(tier: VaultLockedTier, kdfParams: string, salt: Buffer, nonce: Buffer, wrapped: Buffer): void {
  getDb().query(
    "UPDATE vault_keys SET kdf_params = ?, salt = ?, dek_nonce = ?, wrapped_dek = ?, failed_attempts = 0, locked_until = 0 WHERE tier = ?",
  ).run(kdfParams, salt, nonce, wrapped, tier);
}

export function setAttempts(tier: VaultLockedTier, failed: number, lockedUntil: number): void {
  getDb().query("UPDATE vault_keys SET failed_attempts = ?, locked_until = ? WHERE tier = ?").run(failed, lockedUntil, tier);
}

/** Removes a tier's key and every item of that tier, in one transaction. */
export function deleteTierRows(tier: VaultLockedTier): number {
  const db = getDb();
  let removed = 0;
  db.transaction(() => {
    removed = db.query("DELETE FROM vault_items WHERE tier = ?").run(tier).changes;
    db.query("DELETE FROM vault_keys WHERE tier = ?").run(tier);
  })();
  return removed;
}

export function listItemRows(tier?: VaultTier): VaultItemRow[] {
  const rows = tier
    ? getDb().query("SELECT * FROM vault_items WHERE tier = ? ORDER BY name COLLATE NOCASE, id").all(tier)
    : getDb().query("SELECT * FROM vault_items ORDER BY tier, name COLLATE NOCASE, id").all();
  return (rows as Record<string, unknown>[]).map(itemRow);
}

export function getItemRow(id: string): VaultItemRow | null {
  const raw = getDb().query("SELECT * FROM vault_items WHERE id = ?").get(id) as Record<string, unknown> | null;
  return raw ? itemRow(raw) : null;
}

export function countItems(tier: VaultTier): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM vault_items WHERE tier = ?").get(tier) as { n: number }).n;
}

export function insertItemRow(row: VaultItemRow): void {
  getDb().query(
    "INSERT INTO vault_items (id, tier, name, kind, value_plain, ciphertext, nonce, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.tier, row.name, row.kind, row.value_plain, row.ciphertext, row.nonce, row.created_at, row.updated_at);
}

/** Overwrites every stored column of an existing item (tier included, for a move). */
export function updateItemRow(row: VaultItemRow): boolean {
  return getDb().query(
    "UPDATE vault_items SET tier = ?, name = ?, kind = ?, value_plain = ?, ciphertext = ?, nonce = ?, updated_at = ? WHERE id = ?",
  ).run(row.tier, row.name, row.kind, row.value_plain, row.ciphertext, row.nonce, row.updated_at, row.id).changes > 0;
}

export function deleteItemRow(id: string): boolean {
  return getDb().query("DELETE FROM vault_items WHERE id = ?").run(id).changes > 0;
}
