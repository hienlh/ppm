import { basename, dirname, join } from "node:path";

/**
 * Where the vault keeps the encrypted files attached to its items, derived from the database file
 * it belongs to: `vault-files/` beside `ppm.db`, `vault-files.dev/` beside `ppm.dev.db`. One folder
 * per database (as `avatars` does), because the "is this file still named?" check can only ask the
 * database it runs on: with one shared folder a dev server would delete production's files.
 *
 * Pure on purpose: the backup core (`db-backup-sync.ts`) runs before `db.service` can be imported
 * and is handed the database path, so it derives the same folder from that path.
 *
 * The folder sits inside the PPM directory, so every filesystem door already refuses it
 * (`isPpmDirPath` in `fs-credential-path-guard.ts`). It must never move under `uploads/`, the one
 * part of the PPM directory those doors open.
 */
export function vaultFilesDirFor(dbPath: string): string {
  const stem = basename(dbPath).replace(/\.db$/, "");
  const profile = stem === "ppm" ? "" : stem.replace(/^ppm\./, "");
  return join(dirname(dbPath), profile ? `vault-files.${profile}` : "vault-files");
}

/**
 * Files no row names any more wait here until a database snapshot taken after their removal has
 * collected what it needs, so a snapshot never names a file that is already gone.
 */
export const RETIRED_DIR_NAME = "retired";

/** A file's name on disk: 32 random hex characters. Anything else is refused, never resolved. */
export const VAULT_FILE_ID = /^[0-9a-f]{32}$/;

export const vaultFileName = (fileId: string): string => {
  if (!VAULT_FILE_ID.test(fileId)) throw new Error("Invalid vault file id");
  return `${fileId}.bin`;
};
