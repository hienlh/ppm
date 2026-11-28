import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { CARD_FILE_ID_RE, sniffCardFile, type CardFile } from "../../shared/card-files.ts";
import { turnSecretScrubber } from "../vault/turn-secret-scrubber.ts";
import { createLogger } from "../logger.ts";

/**
 * PPM's own copies of the files managers attach to report cards: `<ppm dir>/card-files/<id>.bin`
 * beside `<id>.json` (what the card says about it). Copied when the report is filed, so the card
 * shows and sends what the manager attached, not what the file became later. The folder is inside
 * the PPM folder, so no generic file route opens it; the card reads a copy only through
 * `/api/card-files/<id>` behind PPM's login.
 *
 * A text file is searched for the value of a vault item read in the last day before it is kept:
 * vault values never leave PPM, and a file sent to Telegram would carry one out.
 *
 * Copies are kept {@link CARD_FILE_TTL_MS} and at most {@link CARD_FILES_MAX_BYTES} in all, the
 * oldest going first; a card whose copy is gone says so.
 */

export const CARD_FILE_TTL_MS = 30 * 24 * 60 * 60_000;
export const CARD_FILES_MAX_BYTES = 5 * 1024 * 1024 * 1024;
/** How much of a text file is searched for vault values; a larger text file is searched up to here. */
const VAULT_SCAN_BYTES = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const log = createLogger("card-files");

export interface StoredCardFile extends CardFile {
  projectPath: string;
  createdAt: string;
}

export const cardFilesDir = (): string => join(getPpmDir(), "card-files");
export const cardFilePath = (id: string): string => join(cardFilesDir(), `${id}.bin`);
/** A smaller copy of a video made for Telegram's upload limit, kept beside the original. */
export const cardFileTelegramCopyPath = (id: string): string => join(cardFilesDir(), `${id}.telegram.mp4`);
/** The "Smooth" copy of a video (`card-file-smooth.ts`), and the mark saying why there is none. */
export const cardFileSmoothPath = (id: string): string => join(cardFilesDir(), `${id}.smooth.mp4`);
export const cardFileSmoothMarkerPath = (id: string): string => join(cardFilesDir(), `${id}.smooth.json`);
const metaPath = (id: string): string => join(cardFilesDir(), `${id}.json`);

export class CardFileRefused extends Error {}

/** Whether the bytes read like text rather than a binary format: no NUL in the first 8 KB. */
function looksLikeText(head: Uint8Array): boolean {
  const n = Math.min(head.length, 8192);
  for (let i = 0; i < n; i++) if (head[i] === 0) return false;
  return true;
}

/**
 * Copies the file at `realPath` (already checked by `checkReportFilePath`) into the store.
 * Refuses with {@link CardFileRefused} when it is no longer that ordinary file, or when it holds a
 * vault value.
 */
export async function storeCardFile(realPath: string, name: string, projectPath: string): Promise<StoredCardFile> {
  await mkdir(cardFilesDir(), { recursive: true });
  const id = randomBytes(16).toString("hex");
  const part = join(cardFilesDir(), `${id}.part`);
  // Opened by its real path, then checked to still be that ordinary file: a link put in its place
  // between the check and here is refused rather than followed.
  const before = await lstat(realPath).catch(() => null);
  if (!before || before.isSymbolicLink() || !before.isFile()) throw new CardFileRefused(`"${name}" changed before it could be copied`);
  const src = await open(realPath, "r");
  const hash = createHash("sha256");
  let head: Uint8Array = new Uint8Array(0);
  let size = 0;
  try {
    const st = await src.stat();
    if (!st.isFile() || (before.ino && st.ino && before.ino !== st.ino)) throw new CardFileRefused(`"${name}" changed before it could be copied`);
    const out = await open(part, "w");
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, CHUNK, null);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        if (head.length < 8192) head = Buffer.concat([head, chunk.subarray(0, 8192 - head.length)]);
        hash.update(chunk);
        await out.write(chunk);
        size += bytesRead;
      }
    } finally {
      await out.close();
    }
  } catch (e) {
    await rm(part, { force: true }).catch(() => {});
    throw e;
  } finally {
    await src.close();
  }
  const { kind, mime } = sniffCardFile(head);
  if (kind === "other" && looksLikeText(head)) {
    const fd = await open(part, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, VAULT_SCAN_BYTES));
      await fd.read(buf, 0, buf.length, 0);
      const leaked = turnSecretScrubber.find(buf.toString("utf8"));
      if (leaked) {
        await fd.close().catch(() => {});
        await rm(part, { force: true });
        throw new CardFileRefused(`"${name}" contains the value of the vault item "${leaked}"; vault values never leave PPM`);
      }
    } finally {
      await fd.close().catch(() => {});
    }
  }
  const stored: StoredCardFile = {
    id, name, size, kind, mime, sha256: hash.digest("hex"), projectPath, createdAt: new Date().toISOString(),
  };
  await rename(part, cardFilePath(id));
  await writeFile(metaPath(id), JSON.stringify(stored));
  return stored;
}

/** The card's view of a stored copy: what `payload.files` holds. */
export function cardFileOf(stored: StoredCardFile): CardFile {
  const { id, name, size, kind, mime, sha256 } = stored;
  return { id, name, size, kind, mime, sha256 };
}

/** A stored copy's record, or null when the id names none (unknown, pruned, malformed). */
export async function readCardFile(id: string): Promise<StoredCardFile | null> {
  if (!CARD_FILE_ID_RE.test(id)) return null;
  try {
    const meta = JSON.parse(await readFile(metaPath(id), "utf8")) as StoredCardFile;
    return meta.id === id && existsSync(cardFilePath(id)) ? meta : null;
  } catch {
    return null;
  }
}

/** Blocking twin, for a caller that cannot await. */
export function readCardFileSync(id: string): StoredCardFile | null {
  if (!CARD_FILE_ID_RE.test(id)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath(id), "utf8")) as StoredCardFile;
    return meta.id === id && existsSync(cardFilePath(id)) ? meta : null;
  } catch {
    return null;
  }
}

/** Removes one copy (a report that was not filed); never throws. */
export async function removeCardFile(id: string): Promise<void> {
  if (!CARD_FILE_ID_RE.test(id)) return;
  for (const p of [cardFilePath(id), metaPath(id), cardFileTelegramCopyPath(id), cardFileSmoothPath(id), cardFileSmoothMarkerPath(id)]) {
    await rm(p, { force: true }).catch(() => {});
  }
}

/** Deletes copies past their age, then the oldest past the total size; never throws. */
export async function pruneCardFiles(now = Date.now()): Promise<void> {
  const names = await readdir(cardFilesDir()).catch(() => [] as string[]);
  const kept: Array<{ id: string; at: number; size: number }> = [];
  for (const name of names) {
    // A half-written copy left by a crash: gone once it is an hour old.
    if (name.endsWith(".part")) {
      const st = await stat(join(cardFilesDir(), name)).catch(() => null);
      if (st && now - st.mtimeMs > 60 * 60_000) await rm(join(cardFilesDir(), name), { force: true }).catch(() => {});
      continue;
    }
    const m = /^([0-9a-f]{32})\.bin$/.exec(name);
    if (!m) continue;
    const st = await stat(join(cardFilesDir(), name)).catch(() => null);
    if (st) kept.push({ id: m[1]!, at: st.mtimeMs, size: st.size });
  }
  kept.sort((a, b) => b.at - a.at);
  let total = 0;
  for (const file of kept) {
    total += file.size;
    if (now - file.at <= CARD_FILE_TTL_MS && total <= CARD_FILES_MAX_BYTES) continue;
    log.info(`card file ${file.id} removed (${now - file.at > CARD_FILE_TTL_MS ? "older than 30 days" : "over the store's size"})`);
    await removeCardFile(file.id);
  }
}
