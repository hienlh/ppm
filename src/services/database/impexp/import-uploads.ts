/**
 * The files the Import tab uploads: written to disk under `importsDir()` as they arrive — never
 * held in memory — and known by an id until the tab removes them, or for an hour since a job or a
 * preview last read them. A job reading one holds it, so neither the hour nor Remove takes the
 * file away mid-read; startup removes what a previous server left (`wipeImpExpFiles`).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { IMPORT_MAX_FILE_BYTES, type ImportUpload } from "../../../shared/db-impexp.ts";
import { IMPEXP_FILE_TTL_MS, importsDir, makeDir, removePath, writeChunks } from "./impexp-files.ts";

/** Bytes every upload together may take on disk. */
export const MAX_UPLOADS_BYTES = 2 * 1024 * 1024 * 1024;

/** How often uploads past their hour are let go. */
const SWEEP_EVERY_MS = 5 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** True for something an upload could be known by: 16 random bytes, base64url. */
export function isUploadId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** An upload refused: the request is wrong (400), or the file — or every upload together — too large (413). */
export class UploadError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message);
  }
}

interface Upload extends ImportUpload {
  path: string;
  lastUsed: number;
  /** Jobs and previews reading it now. */
  readers: number;
  /** Removed while being read: the file goes once the last reader lets it go. */
  removed: boolean;
}

const uploads = new Map<string, Upload>();
/** Bytes of uploads still arriving. */
let arriving = 0;
let sweeper: ReturnType<typeof setInterval> | null = null;

/** Why `name` cannot name an uploaded file, or null. It only labels the file: the server keeps it under the id. */
export function uploadNameProblem(name: string): string | null {
  if (!name.trim()) return "The file needs a name";
  if (name.length > 255) return "The file name is longer than 255 characters";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "The file name holds a control character";
  return null;
}

function storedBytes(): number {
  let n = 0;
  for (const u of uploads.values()) n += u.size;
  return n;
}

const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024).toLocaleString("en-US")} MB`;

/** `body` counted as it passes, refused past either limit. */
async function* limited(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let size = 0;
  let counted = 0;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > IMPORT_MAX_FILE_BYTES) throw new UploadError(`The file is larger than ${megabytes(IMPORT_MAX_FILE_BYTES)}`, 413);
      arriving += chunk.byteLength;
      counted += chunk.byteLength;
      if (storedBytes() + arriving > MAX_UPLOADS_BYTES) {
        throw new UploadError(`Uploaded files already take ${megabytes(MAX_UPLOADS_BYTES)}: remove some from the tab, and add this one again`, 413);
      }
      yield chunk;
    }
  } finally {
    arriving -= counted;
  }
}

/** Keeps `body` as an upload named `name`. */
export async function saveUpload(name: string, body: AsyncIterable<Uint8Array> | null, signal: AbortSignal): Promise<ImportUpload> {
  const problem = uploadNameProblem(name);
  if (problem) throw new UploadError(problem, 400);
  // A file of no bytes has no columns to import, which is better said now than when it runs.
  if (!body) throw new UploadError("The file is empty", 400);
  const id = randomBytes(16).toString("base64url");
  const path = join(await makeDir(importsDir()), id);
  let size: number;
  try {
    size = await writeChunks(path, limited(body), signal);
    if (size === 0) throw new UploadError("The file is empty", 400);
  } catch (e) {
    await removePath(path);
    throw e;
  }
  uploads.set(id, { id, name, size, path, lastUsed: Date.now(), readers: 0, removed: false });
  startSweeper();
  return { id, name, size };
}

/** An upload being read, until `release` lets it go. */
export interface HeldUpload {
  path: string;
  name: string;
  release(): void;
}

/** Holds the upload `id` for a job or a preview to read; null when it is gone. */
export function holdUpload(id: string): HeldUpload | null {
  const upload = uploads.get(id);
  if (!upload) return null;
  upload.readers++;
  upload.lastUsed = Date.now();
  let released = false;
  return {
    path: upload.path,
    name: upload.name,
    release: () => {
      if (released) return;
      released = true;
      upload.readers--;
      upload.lastUsed = Date.now();
      if (upload.removed && upload.readers === 0) void removePath(upload.path);
    },
  };
}

/** The name the upload `id` was added under, or null when it is gone. */
export function uploadName(id: string): string | null {
  return uploads.get(id)?.name ?? null;
}

/** Remove the upload `id`; false when there is none. A job reading it reads on to its end. */
export async function removeUpload(id: string): Promise<boolean> {
  const upload = uploads.get(id);
  if (!upload) return false;
  uploads.delete(id);
  upload.removed = true;
  if (upload.readers === 0) await removePath(upload.path);
  return true;
}

/** Let go of the uploads no one has read for an hour before `now`. */
export async function sweepUploads(now = Date.now()): Promise<void> {
  const expired = [...uploads.values()].filter((u) => u.readers === 0 && now - u.lastUsed >= IMPEXP_FILE_TTL_MS);
  for (const upload of expired) uploads.delete(upload.id);
  await Promise.all(expired.map((u) => removePath(u.path)));
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweepUploads(); }, SWEEP_EVERY_MS);
  sweeper.unref?.();
}

/** Forget every upload, removing its file (shutdown, tests). */
export async function resetUploads(): Promise<void> {
  const all = [...uploads.values()];
  uploads.clear();
  arriving = 0;
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  await Promise.all(all.map((u) => removePath(u.path)));
}
