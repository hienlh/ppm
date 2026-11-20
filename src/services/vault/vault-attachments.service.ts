import { createHash, randomUUID } from "node:crypto";
import { getDb, getDbPath } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import {
  isVaultLockedTier, VAULT_FILE_MAX_BYTES, VAULT_FILES_PER_ITEM, VAULT_FILES_TOTAL_BYTES, VAULT_MAX_LABEL_LENGTH,
  type VaultAttachmentMeta, type VaultFileType, type VaultLockedTier,
} from "../../shared/vault.ts";
import { decryptFilePart, decryptItem, encryptFilePart, parseVaultFileBytes, vaultFileBytes } from "./vault-crypto.ts";
import { getItemRow, type VaultItemRow } from "./vault-db.ts";
import {
  countItemAttachments, deleteAttachmentRow, deleteItemAttachmentRows, deleteTierAttachmentRows, getAttachmentRow,
  insertAttachmentRow, listAttachmentRows, referencedFileIds, toAttachmentMeta, totalAttachmentBytes, updateAttachmentRow, type VaultAttachmentRow,
} from "./vault-attachments-db.ts";
import { newVaultFileId, purgeRetired, readVaultFile, retireUnreferenced, retireVaultFile, writeVaultFile } from "./vault-file-store.ts";
import { vaultFilesDirFor } from "./vault-files-dir.ts";
import { VaultError } from "./vault-errors.ts";
import { cleanFileName, sniffVaultFileType } from "./vault-file-type.ts";

export { cleanFileName, sniffVaultFileType };

/**
 * Files attached to items of the secure and sealed tiers: the rules over `vault_attachments` and
 * the encrypted files on disk. Every action takes the tier's data key and proves it by opening the
 * item (or the file's own encrypted name) with it, the way `vault.service.ts` does for values.
 *
 * The type is decided from the file's first bytes, never from what the browser says: only JPEG,
 * PNG, WebP and PDF, so nothing that runs script on PPM's origin (SVG, HTML) can be stored.
 *
 * Logging names ids, tiers and sizes only — never a label's file, a name or a byte.
 */

const log = createLogger("vault");

function cleanLabel(label: unknown, fallback: string): string {
  const l = typeof label === "string" ? label.replace(/[\r\n\u0000]/g, " ").trim() : "";
  const out = l || fallback;
  if (out.length > VAULT_MAX_LABEL_LENGTH) throw new VaultError("bad-label", `A label may have at most ${VAULT_MAX_LABEL_LENGTH} characters.`);
  return out;
}

interface FileMeta { name: string; sha256: string }

export interface VaultFileContent {
  meta: VaultAttachmentMeta;
  fileName: string;
  bytes: Buffer;
}

export function createVaultAttachments(opts: { now?: () => number; dir?: () => string } = {}) {
  const now = opts.now ?? Date.now;
  const dir = opts.dir ?? (() => vaultFilesDirFor(getDbPath()));

  /** The item, after proving `dek` opens it: a wrong key never touches a file. */
  function lockedItem(itemId: string, dek: Buffer | null): VaultItemRow & { tier: VaultLockedTier } {
    const item = getItemRow(itemId);
    if (!item) throw new VaultError("not-found", "No such vault item.", 404);
    if (!isVaultLockedTier(item.tier)) throw new VaultError("public-no-files", "Files can only be attached to Secure and Sealed items.");
    if (!dek) throw new VaultError("locked", "Unlock this tier first.", 423);
    if (!item.nonce || !item.ciphertext || !decryptItem(dek, item.tier, item.id, item.nonce, item.ciphertext)) {
      throw new VaultError("bad-row", "This item does not open with the tier's key.", 409);
    }
    return item as VaultItemRow & { tier: VaultLockedTier };
  }

  function existing(id: string): VaultAttachmentRow {
    const row = getAttachmentRow(id);
    if (!row) throw new VaultError("not-found", "No such file.", 404);
    return row;
  }

  function openMeta(row: VaultAttachmentRow, dek: Buffer): FileMeta {
    const plain = decryptFilePart(dek, row.tier, row.item_id, row.id, "meta", row.meta_nonce, row.meta_ciphertext);
    if (!plain) throw new VaultError("bad-row", "This file does not open with the tier's key; it may have been tampered with.", 409);
    try {
      const m = JSON.parse(plain.toString("utf8")) as Partial<FileMeta>;
      if (typeof m.name !== "string" || typeof m.sha256 !== "string") throw new Error("shape");
      return { name: m.name, sha256: m.sha256 };
    } catch {
      throw new VaultError("bad-row", "This file's record is damaged.", 409);
    } finally {
      plain.fill(0);
    }
  }

  function openBody(row: VaultAttachmentRow, dek: Buffer, meta: FileMeta): Buffer {
    const raw = readVaultFile(row.file_id, dir());
    if (!raw) throw new VaultError("file-missing", "This file is missing on disk. Restore it from a backup with `ppm restore`.", 409);
    const parts = parseVaultFileBytes(raw);
    const body = parts && decryptFilePart(dek, row.tier, row.item_id, row.id, "body", parts.nonce, parts.ciphertext);
    if (!body) throw new VaultError("bad-row", "This file does not open with the tier's key; it may have been tampered with.", 409);
    if (createHash("sha256").update(body).digest("hex") !== meta.sha256) {
      body.fill(0);
      throw new VaultError("bad-row", "This file does not match its checksum.", 409);
    }
    return body;
  }

  /** Encrypts `body` and `meta` for an attachment of `tier` and writes the file; returns the new columns. */
  function sealFor(tier: VaultLockedTier, itemId: string, id: string, dek: Buffer, body: Buffer, meta: FileMeta) {
    const fileId = newVaultFileId();
    writeVaultFile(fileId, vaultFileBytes(encryptFilePart(dek, tier, itemId, id, "body", body)), dir());
    const metaPlain = Buffer.from(JSON.stringify(meta), "utf8");
    try {
      const sealedMeta = encryptFilePart(dek, tier, itemId, id, "meta", metaPlain);
      return { file_id: fileId, meta_nonce: sealedMeta.nonce, meta_ciphertext: sealedMeta.ciphertext };
    } finally {
      metaPlain.fill(0);
    }
  }

  return {
    list(itemId?: string): VaultAttachmentMeta[] {
      return listAttachmentRows(itemId).map(toAttachmentMeta);
    },

    getMeta(id: string): VaultAttachmentMeta | null {
      const row = getAttachmentRow(id);
      return row ? toAttachmentMeta(row) : null;
    },

    /** Attaches a file to a locked item. The size, count and total limits are checked first. */
    add(itemId: string, input: { fileName?: string; label?: string; bytes: Buffer }, dek: Buffer | null): VaultAttachmentMeta {
      const item = lockedItem(itemId, dek);
      const { bytes } = input;
      if (bytes.length === 0) throw new VaultError("empty-file", "The file is empty.");
      if (bytes.length > VAULT_FILE_MAX_BYTES) throw new VaultError("file-too-large", `A file may be at most ${VAULT_FILE_MAX_BYTES / (1024 * 1024)} MB.`, 413);
      const type = sniffVaultFileType(bytes);
      if (!type) throw new VaultError("bad-file-type", "Only JPEG, PNG and WebP photos and PDF files can be kept in the vault.");
      if (countItemAttachments(itemId) >= VAULT_FILES_PER_ITEM) throw new VaultError("too-many-files", `An item may hold at most ${VAULT_FILES_PER_ITEM} files.`, 409);
      if (totalAttachmentBytes() + bytes.length > VAULT_FILES_TOTAL_BYTES) {
        throw new VaultError("vault-full", `The vault's files may take at most ${VAULT_FILES_TOTAL_BYTES / (1024 * 1024)} MB in all.`, 409);
      }
      const name = cleanFileName(input.fileName, type);
      const id = randomUUID();
      const t = now();
      const count = countItemAttachments(itemId) + 1;
      const label = cleanLabel(input.label, type === "application/pdf" ? `Document ${count}` : `Photo ${count}`);
      const cols = sealFor(item.tier, itemId, id, dek!, bytes, { name, sha256: createHash("sha256").update(bytes).digest("hex") });
      const row: VaultAttachmentRow = {
        id, item_id: itemId, tier: item.tier, label, mime: type, size: bytes.length, ...cols, created_at: t, updated_at: t,
      };
      try {
        insertAttachmentRow(row);
      } catch (e) {
        retireVaultFile(cols.file_id, dir());
        throw e;
      }
      log.info(`file=${id} (${bytes.length} bytes) attached to item=${itemId} tier=${item.tier}`);
      return toAttachmentMeta(row);
    },

    /** The decrypted file, for the one HTTP response that shows or downloads it. */
    read(id: string, dek: Buffer | null): VaultFileContent {
      const row = existing(id);
      if (!dek) throw new VaultError("locked", "Unlock this tier first.", 423);
      const meta = openMeta(row, dek);
      const bytes = openBody(row, dek, meta);
      // The type column is not encrypted: what is answered is what the bytes themselves are.
      if (sniffVaultFileType(bytes) !== row.mime) {
        bytes.fill(0);
        throw new VaultError("bad-row", "This file's type does not match its record; it may have been tampered with.", 409);
      }
      return { meta: toAttachmentMeta(row), fileName: meta.name, bytes };
    },

    rename(id: string, label: unknown, dek: Buffer | null): VaultAttachmentMeta {
      const row = existing(id);
      if (!dek) throw new VaultError("locked", "Unlock this tier first.", 423);
      openMeta(row, dek);
      const next: VaultAttachmentRow = { ...row, label: cleanLabel(label, row.label), updated_at: now() };
      updateAttachmentRow(next);
      return toAttachmentMeta(next);
    },

    remove(id: string, dek: Buffer | null): void {
      const row = existing(id);
      // Proved on the item, not on the file's own record, so a damaged file can still be deleted.
      lockedItem(row.item_id, dek);
      deleteAttachmentRow(id);
      retireVaultFile(row.file_id, dir());
      log.info(`file=${id} removed from item=${row.item_id}`);
    },

    /**
     * Prepares moving an item's files to another locked tier: each file is opened with the old key
     * and written anew under the new one. `apply` updates the rows (inside the caller's
     * transaction); `commit` retires the old files once that transaction has committed and
     * `abort` the new ones if it has not.
     */
    prepareMove(itemId: string, to: VaultLockedTier, fromDek: Buffer, toDek: Buffer) {
      const rows = listAttachmentRows(itemId);
      const written: VaultAttachmentRow[] = [];
      try {
        for (const row of rows) {
          const meta = openMeta(row, fromDek);
          const body = openBody(row, fromDek, meta);
          try {
            written.push({ ...row, tier: to, ...sealFor(to, itemId, row.id, toDek, body, meta), updated_at: now() });
          } finally {
            body.fill(0);
          }
        }
      } catch (e) {
        for (const w of written) retireVaultFile(w.file_id, dir());
        throw e;
      }
      return {
        apply: () => { for (const w of written) updateAttachmentRow(w); },
        commit: () => { for (const r of rows) retireVaultFile(r.file_id, dir()); },
        abort: () => { for (const w of written) retireVaultFile(w.file_id, dir()); },
      };
    },

    /**
     * Removes the rows of an item's files (inside the caller's transaction, its key proved by the
     * caller) and returns their files, for `retire` once that transaction has committed.
     */
    removeRowsForItem: (itemId: string): string[] => deleteItemAttachmentRows(itemId),

    /** The same for a whole tier, its password proved by the caller. */
    removeRowsForTier: (tier: VaultLockedTier): string[] => deleteTierAttachmentRows(tier),

    retire(fileIds: readonly string[]): void {
      for (const f of fileIds) retireVaultFile(f, dir());
    },

    /** Retires the files in the vault's folder that no row names (a write a crash cut short). */
    sweep(): number {
      const retired = retireUnreferenced(referencedFileIds(), dir());
      // Without snapshots (no supervisor) nothing else purges: the age cap applies here too.
      purgeRetired(0, dir());
      return retired;
    },

    count: (itemId: string): number => countItemAttachments(itemId),
    totalBytes: (): number => totalAttachmentBytes(),
    transaction: <T>(fn: () => T): T => getDb().transaction(fn)(),
  };
}

export type VaultAttachments = ReturnType<typeof createVaultAttachments>;

export const vaultAttachments = createVaultAttachments();
