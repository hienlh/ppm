import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync, type Dirent } from "node:fs";
import { getPpmDir } from "../ppm-dir.ts";
import { getBackupsDir } from "../db-backup/db-backup-paths.ts";

/**
 * Whether a file is, under another name, one of the files PPM keeps its credentials in.
 *
 * A hard link has a real path of its own, so the path checks in `sqlite-path-guard.ts` never see
 * that it is `ppm.db` (or a snapshot of it). The file system does: both names share one device
 * and inode. Only a file with more than one link can be such a second name, so nothing is listed
 * for the ordinary single-link file.
 */

interface FileId {
  dev: bigint;
  ino: bigint;
  links: bigint;
}

/** Device, inode and link count, as bigints when the runtime offers them (Windows file ids are 64-bit). */
function fileId(path: string): FileId | null {
  try {
    const s = statSync(path, { bigint: true });
    return s.isFile() ? { dev: s.dev, ino: s.ino, links: s.nlink } : null;
  } catch {
    try {
      const s = statSync(path);
      return s.isFile() ? { dev: BigInt(s.dev), ino: BigInt(s.ino), links: BigInt(s.nlink) } : null;
    } catch {
      return null;
    }
  }
}

/** Every regular file under `dir`, `depth` folders deep. */
function filesUnder(dir: string, depth: number, out: string[] = []): string[] {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isFile()) out.push(path);
    else if (e.isDirectory() && depth > 0) filesUnder(path, depth - 1, out);
  }
  return out;
}

/**
 * The credential stores a SQLite connection must not reach: PPM's databases (every profile's,
 * with their journals), its snapshots, and the Cloudflare login.
 */
function protectedFiles(): Array<{ path: string; place: string }> {
  return [
    ...filesUnder(getPpmDir(), 0).map((path) => ({ path, place: "PPM's own data folder" })),
    ...filesUnder(getBackupsDir(), 2).map((path) => ({ path, place: "PPM's database snapshots" })),
    ...filesUnder(join(homedir(), ".cloudflared"), 0).map((path) => ({ path, place: "the Cloudflare login folder" })),
  ];
}

/** Where the protected file `path` is another name for lives, or null when it is no such file. */
export function protectedFileLinkedAs(path: string): { path: string; place: string } | null {
  const id = fileId(path);
  // A file system that reports no inode (0) cannot tell two files apart this way.
  if (!id || id.links <= 1n || id.ino === 0n) return null;
  for (const candidate of protectedFiles()) {
    const other = fileId(candidate.path);
    if (other && other.dev === id.dev && other.ino === id.ino) return candidate;
  }
  return null;
}
