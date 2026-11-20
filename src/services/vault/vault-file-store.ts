import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../logger.ts";
import { RETIRED_DIR_NAME, VAULT_FILE_ID, vaultFileName } from "./vault-files-dir.ts";

/**
 * The encrypted files on disk, by their random id: written once and never changed (an edit writes
 * a new file), read whole, and retired rather than deleted. A retired file waits in `retired/`
 * until a database snapshot taken after it was retired has collected the files it names
 * (`db-backup-vault-files.ts`), then goes for good; see `purgeRetired`.
 *
 * Holds ciphertext only. Nothing here knows a key, a name or a value; logging names ids. Every
 * function takes the folder: this module must not import `db.service`, because the backup core,
 * which `db.service` itself imports, uses it.
 */

const log = createLogger("vault");

/** A retired file is deleted after this long even when no snapshot runs (backups switched off). */
export const RETIRED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export const newVaultFileId = (): string => randomBytes(16).toString("hex");

/** Writes `bytes` as file `fileId`: a temporary file beside it, flushed, then renamed into place. */
export function writeVaultFile(fileId: string, bytes: Buffer, dir: string): void {
  ensureDir(dir);
  const target = join(dir, vaultFileName(fileId));
  const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** The bytes of file `fileId`, from the live folder or (just removed, not yet purged) `retired/`. */
export function readVaultFile(fileId: string, dir: string): Buffer | null {
  for (const path of [join(dir, vaultFileName(fileId)), join(dir, RETIRED_DIR_NAME, vaultFileName(fileId))]) {
    try {
      return readFileSync(path);
    } catch { /* next */ }
  }
  return null;
}

/** Moves a file no row names any more to `retired/`, stamped with the time it left. */
export function retireVaultFile(fileId: string, dir: string, now = Date.now()): void {
  const from = join(dir, vaultFileName(fileId));
  if (!existsSync(from)) return;
  const retired = join(dir, RETIRED_DIR_NAME);
  ensureDir(retired);
  try {
    renameSync(from, join(retired, vaultFileName(fileId)));
    // The rename keeps the file's own times; the retired time is what the purge reads.
    const stampFd = openSync(join(retired, `${fileId}.retired`), "w", 0o600);
    try { writeSync(stampFd, String(now)); } finally { closeSync(stampFd); }
  } catch (e) {
    log.warn(`vault file ${fileId} could not be retired: ${(e as Error).message}`);
  }
}

/** Retires every file in the live folder that `referenced` does not name (left by a crash). */
export function retireUnreferenced(referenced: ReadonlySet<string>, dir: string, now = Date.now()): number {
  if (!existsSync(dir)) return 0;
  let retired = 0;
  for (const name of readdirSync(dir)) {
    const m = /^([0-9a-f]{32})\.bin$/.exec(name);
    if (m && !referenced.has(m[1]!)) {
      retireVaultFile(m[1]!, dir, now);
      retired++;
    } else if (/\.tmp$/.test(name)) {
      // A write that never finished: nothing can name it.
      try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
    }
  }
  if (retired) log.info(`retired ${retired} vault file(s) no item names`);
  return retired;
}

/**
 * Deletes retired files that a snapshot no longer needs: those retired before `collectedBefore`
 * (the start of the last snapshot whose files were collected), and any older than the cap.
 */
export function purgeRetired(collectedBefore: number, dir: string, now = Date.now()): number {
  const retired = join(dir, RETIRED_DIR_NAME);
  if (!existsSync(retired)) return 0;
  let purged = 0;
  for (const name of readdirSync(retired)) {
    const m = /^([0-9a-f]{32})\.bin$/.exec(name);
    if (!m) continue;
    const stamp = join(retired, `${m[1]}.retired`);
    let at = 0;
    try { at = Number(readFileSync(stamp, "utf8")) || 0; } catch { at = 0; }
    if (!at) {
      try { at = statSync(join(retired, name)).mtimeMs; } catch { continue; }
    }
    if (at < collectedBefore || now - at > RETIRED_MAX_AGE_MS) {
      try { unlinkSync(join(retired, name)); purged++; } catch { /* next time */ }
      try { unlinkSync(stamp); } catch { /* best effort */ }
    }
  }
  if (purged) log.info(`purged ${purged} retired vault file(s)`);
  return purged;
}

export const isVaultFileId = (v: unknown): v is string => typeof v === "string" && VAULT_FILE_ID.test(v);
