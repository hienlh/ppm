/**
 * Injectable filesystem access for the /proc and /sys collectors, so every parser
 * is fixture-tested without a real host. Each call returns null instead of
 * throwing: a device or a process vanishing between a directory listing and the
 * read is the normal case here, not an error worth a stack trace per tick.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";

export type FileReader = (path: string) => string | null;
export type DirLister = (path: string) => string[] | null;
export type LinkReader = (path: string) => string | null;

export interface LinuxFs {
  read: FileReader;
  list: DirLister;
  /** The link's own target, as written (often relative: `../../devices/...`). */
  readlink: LinkReader;
  /** Fully resolved absolute path, or null when it does not resolve. */
  realpath: LinkReader;
  exists: (path: string) => boolean;
}

export const realLinuxFs: LinuxFs = {
  read: (path) => { try { return readFileSync(path, "utf-8"); } catch { return null; } },
  list: (path) => { try { return readdirSync(path); } catch { return null; } },
  readlink: (path) => { try { return readlinkSync(path); } catch { return null; } },
  realpath: (path) => { try { return realpathSync(path); } catch { return null; } },
  exists: (path) => existsSync(path),
};

/** A sysfs attribute as a trimmed string, or undefined when absent or blank. */
export function readAttr(fs: Pick<LinuxFs, "read">, path: string): string | undefined {
  const v = fs.read(path)?.trim();
  return v ? v : undefined;
}

/** A sysfs attribute as a finite number, or undefined. */
export function readNumber(fs: Pick<LinuxFs, "read">, path: string): number | undefined {
  const v = readAttr(fs, path);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
