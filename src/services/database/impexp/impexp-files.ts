/**
 * Where Import/Export keeps its files: `db-impexp/<server>/exports/<job>/` for what a job wrote,
 * `db-impexp/<server>/imports/` for what the tab uploaded, in the PPM directory. Nothing there
 * outlives an hour unused, or the server that named it.
 *
 * Each server keeps a folder of its own (`<pid>-<random>`) because two servers can share one PPM
 * directory — `bun dev:server` beside the installed PPM does — and one starting must not remove the
 * files of a job the other is still writing. At startup a server removes only the folders of
 * servers no longer running.
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getPpmDir } from "../../ppm-dir.ts";

/** How long a finished job's files, or an upload, are kept after they were last used. */
export const IMPEXP_FILE_TTL_MS = 60 * 60 * 1000;

/** This server's folder name: its process id, then random bytes, so a reused id is not taken for it. */
const INSTANCE = `${process.pid}-${randomBytes(4).toString("hex")}`;

function rootDir(): string {
  return join(getPpmDir(), "db-impexp");
}

function instanceDir(): string {
  return join(rootDir(), INSTANCE);
}

export function exportsDir(): string {
  return join(instanceDir(), "exports");
}

export function importsDir(): string {
  return join(instanceDir(), "imports");
}

export async function makeDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

/** Remove a file or folder, if it is there. Never throws: a file left behind is swept up later. */
export async function removePath(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[impexp] could not remove ${path}:`, (e as Error).message);
  }
}

/**
 * Writes `chunks` to a new file at `path`, which only its owner may read; answers its size. Stop
 * ends it between two pieces. Through Bun's FileSink, because a request body is read off the
 * socket whether or not it is asked for: whatever the disk has not taken yet waits in memory, and
 * through `fs.promises` a 100 MB upload sat there whole (+182 MB of RSS, against +22 MB). One
 * `write()` per piece: on a regular file it answers the whole length (measured up to 58 MB), so a
 * loop resending what it reports unwritten — the pipe trap in CLAUDE.md — would never run twice.
 */
export async function writeChunks(path: string, chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<number> {
  const fd = openSync(path, "wx", 0o600);
  const sink = Bun.file(fd).writer();
  let size = 0;
  try {
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      // `write` takes the whole piece, and what it answers is not how much went in: the flush is
      // what says it is on its way to the disk.
      sink.write(chunk);
      await sink.flush();
      size += chunk.byteLength;
    }
    await sink.end();
  } catch (e) {
    await Promise.resolve().then(() => sink.end()).catch(() => {});
    throw e;
  } finally {
    // Ending the sink leaves a descriptor it was handed open.
    closeSync(fd);
  }
  return size;
}

/** Whether a process with this id is running — one PPM cannot signal counts. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The process a server folder belongs to, from its name; null for a name no server gave. */
export function folderPid(name: string): number | null {
  const match = /^(\d+)-[0-9a-f]+$/.exec(name);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * At startup: the folders of servers that are no longer running — files no job or upload names
 * any more. This server's own, and those of servers still running, stay.
 */
export async function wipeImpExpFiles(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(rootDir());
  } catch {
    return;
  }
  await Promise.all(names.map((name) => {
    if (name === INSTANCE) return Promise.resolve();
    const pid = folderPid(name);
    return pid !== null && pid !== process.pid && isRunning(pid) ? Promise.resolve() : removePath(join(rootDir(), name));
  }));
}
