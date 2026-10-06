/**
 * What each file looked like just before a chat session first changed it: the "before" side
 * of the session's review (the changes bar above the composer and the Review tab).
 *
 * PPM keeps its own copy because nothing else can answer the question. Claude Code records a
 * tool's `originalFile` in the transcript only for small files (measured: kept at 9.8 KB,
 * dropped from 13.6 KB up, so a CHANGELOG or a 50 KB component never has one); an Edit's
 * `old_string` is a fragment at an unknown offset; and git HEAD also holds whatever was
 * uncommitted before the session began. So a file is read once, at its first change in the
 * session, and the copy is kept until the session is deleted or ages out.
 *
 * Layout: `<ppm dir>/session-baselines/<session id>/<sha256 of the path>.json`, one record per
 * file. The first capture wins, and that is the whole point: the record is written to a temp
 * file and hard-linked into place, which fails with EEXIST when a record is already there. A
 * later capture can therefore never replace the real "before" with a state the session itself
 * produced, and a reader never sees half a record.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { decodeText, isBinaryContent } from "../binary-content.ts";
import { isCredentialPath } from "../fs-credential-path-guard.ts";
import { realPathOrSelf } from "../fs-ops/fs-real-path.ts";

/** Same ceiling as the system file reader: a bigger file is listed, never copied. */
export const BASELINE_MAX_BYTES = 5 * 1024 * 1024;

/** Days a session's copies are kept after its last capture or recorded write. */
export const BASELINE_RETENTION_DAYS = 30;

export interface FileBaseline {
  /** Absolute path, as the tool named it. */
  path: string;
  /** False when the session created the file, so its "before" side is empty. */
  existed: boolean;
  /** Absent when the file did not exist, was binary, or was over the size cap. */
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
  capturedAt: string;
  /** Microseconds since the epoch: orders captures that land within one millisecond. */
  seq?: number;
}

/** Session ids become directory names, so only the characters ids are actually made of. */
export function isValidBaselineSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== "..";
}

export function baselinesRoot(): string {
  return resolve(getPpmDir(), "session-baselines");
}

export function sessionDir(sessionId: string): string | null {
  return isValidBaselineSessionId(sessionId) ? join(baselinesRoot(), sessionId) : null;
}

export function recordFile(dir: string, path: string): string {
  return join(dir, `${createHash("sha256").update(path).digest("hex")}.json`);
}

function stamp(): Pick<FileBaseline, "capturedAt" | "seq"> {
  return { capturedAt: new Date().toISOString(), seq: Math.round((performance.timeOrigin + performance.now()) * 1000) };
}

/** What a file held before a change: its bytes, `null` when it did not exist, or `"tooLarge"` past the cap. */
export type BaselineSource = Uint8Array | null | "tooLarge";

function recordFrom(path: string, source: BaselineSource): FileBaseline {
  if (!source) return { path, existed: false, ...stamp() };
  if (source === "tooLarge" || source.length > BASELINE_MAX_BYTES) return { path, existed: true, tooLarge: true, ...stamp() };
  if (isBinaryContent(source)) return { path, existed: true, binary: true, ...stamp() };
  return { path, existed: true, content: decodeText(source), ...stamp() };
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Read `filePath` now and keep it as the session's "before" for that file, unless one is
 * already kept. Called right before a tool writes the file. Never throws: a failed capture
 * only means the review falls back to git for that file.
 *
 * A credential path is never copied: the copy would sit in the PPM directory, outside the
 * guard that keeps the original from being served.
 */
export function captureBaseline(sessionId: string, filePath: string): Promise<void> {
  const dir = sessionDir(sessionId);
  if (!dir || !filePath) return Promise.resolve();
  const path = resolve(filePath);
  const key = `${sessionId}\0${path}`;
  const running = inFlight.get(key);
  if (running) return running;
  const task = (async () => {
    const file = recordFile(dir, path);
    if (await stat(file).then(() => true, () => false)) return;
    if (isCredentialPath(path) || isCredentialPath(await realPathOrSelf(path))) return;
    let record: FileBaseline;
    try {
      const st = await stat(path);
      if (!st.isFile()) return;
      record = recordFrom(path, st.size > BASELINE_MAX_BYTES ? "tooLarge" : await readFile(path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
      record = recordFrom(path, null);
    }
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(record));
    try {
      await link(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      await rm(tmp, { force: true });
    }
  })()
    .catch((e) => console.warn(`[session-baselines] capture failed for ${path}: ${(e as Error).message}`))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/**
 * Keep a "before" that was not read just ahead of the change: worked out, as for a codex patch,
 * which is only seen after it has been applied, or read earlier, as for a shell command, which
 * names no file. `content: null` records a file that did not exist. True when this call kept it,
 * false when one was kept already (the first capture wins) or it could not be written.
 */
export function recordBaseline(sessionId: string, filePath: string, content: string | BaselineSource): boolean {
  const dir = sessionDir(sessionId);
  if (!dir || !filePath) return false;
  const path = resolve(filePath);
  if (isCredentialPath(path)) return false;
  const file = recordFile(dir, path);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(recordFrom(path, typeof content === "string" ? new TextEncoder().encode(content) : content)));
    try {
      linkSync(tmp, file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return false;
    } finally {
      rmSync(tmp, { force: true });
    }
  } catch (e) {
    console.warn(`[session-baselines] record failed for ${path}: ${(e as Error).message}`);
    return false;
  }
}

/** Whether the session already keeps a "before" for `filePath`. */
export function hasBaseline(sessionId: string, filePath: string): boolean {
  const dir = sessionDir(sessionId);
  return !!dir && !!filePath && existsSync(recordFile(dir, resolve(filePath)));
}

function parseRecord(file: string): FileBaseline | null {
  try {
    const rec = JSON.parse(readFileSync(file, "utf8")) as FileBaseline;
    return typeof rec?.path === "string" && typeof rec.existed === "boolean" ? rec : null;
  } catch {
    return null;
  }
}

export function readBaseline(sessionId: string, filePath: string): FileBaseline | null {
  const dir = sessionDir(sessionId);
  if (!dir || !filePath) return null;
  return parseRecord(recordFile(dir, resolve(filePath)));
}

function order(b: FileBaseline): number {
  return b.seq ?? Date.parse(b.capturedAt) * 1000;
}

/** Every file the session has a "before" for, oldest capture first. */
export function listBaselines(sessionId: string): FileBaseline[] {
  const dir = sessionDir(sessionId);
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => parseRecord(join(dir, n)))
    .filter((r): r is FileBaseline => r !== null)
    .sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
}

/**
 * Whether PPM keeps anything the session itself wrote: a "before" (`<hash>.json`) or a file's
 * history (`history/`). Review marks and undo journals are the user's answers, not its writes.
 */
export function keepsSessionWrites(sessionId: string): boolean {
  const dir = sessionDir(sessionId);
  if (!dir) return false;
  try {
    return readdirSync(dir).some((name) => name === "history" || name.endsWith(".json"));
  } catch {
    return false;
  }
}

export function deleteSessionBaselines(sessionId: string): void {
  const dir = sessionDir(sessionId);
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/**
 * Drop the copies of sessions with no capture or recorded write in `maxAgeDays`. A directory's
 * mtime moves whenever a record is linked in, and every observation in the session's history
 * touches it (`observeFile`), so it is the time of the session's last write. Returns how many
 * sessions were dropped.
 */
export function pruneSessionBaselines(maxAgeDays = BASELINE_RETENTION_DAYS, now = Date.now()): number {
  const root = baselinesRoot();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (statSync(dir).mtimeMs >= cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch { /* gone already */ }
  }
  return removed;
}
