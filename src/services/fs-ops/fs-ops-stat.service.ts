import { constants } from "node:fs";
import { access, lstat, opendir, readlink } from "node:fs/promises";
import { basename } from "node:path";
import {
  assertAllowed,
  assertNotPpmSubtree,
  resolvePath,
} from "../fs-path-guard.service.ts";
import { isHiddenName } from "./fs-hidden-names.ts";
import { realPathOrSelf } from "./fs-ops-read-write.service.ts";

export type EntryKind = "file" | "directory" | "symlink" | "unknown";

export interface StatResult {
  path: string;
  name: string;
  kind: EntryKind;
  size: number;
  mtime: string;
  ctime: string;
  birthtime: string;
  mode: number;
  readonly: boolean;
  isHidden: boolean;
  /** Symlink destination, unresolved — links are never auto-followed. */
  target?: string;
  /** Number of direct children for directories, capped. */
  childCount?: number;
  /** True when `childCount` hit the cap and is therefore a lower bound. */
  truncated?: boolean;
}

/** Counting children of a huge directory must not turn into an endless scan. */
const CHILD_COUNT_CAP = 10_000;

export function kindOfStats(st: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): EntryKind {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "directory";
  if (st.isFile()) return "file";
  return "unknown";
}

/** Write permission is not encoded in the mode bits on Windows, so probe it. */
async function isReadOnly(path: string, mode: number): Promise<boolean> {
  if (process.platform !== "win32") return (mode & 0o200) === 0;
  try {
    await access(path, constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

async function countChildren(path: string): Promise<{ childCount: number; truncated: boolean }> {
  let childCount = 0;
  const dir = await opendir(path);
  try {
    for await (const _entry of dir) {
      childCount++;
      if (childCount >= CHILD_COUNT_CAP) return { childCount, truncated: true };
    }
  } finally {
    // The async iterator already closes the handle when it drains, and a
    // second close reports differently per runtime — ignore whatever it says.
    try {
      await dir.close();
    } catch {
      /* already closed */
    }
  }
  return { childCount, truncated: false };
}

/** Describe a single entry. Reports the link itself, never its target. */
export async function statPath(input: string): Promise<StatResult> {
  const path = resolvePath(input);
  assertAllowed(path);
  // Sizes and timestamps of the credentials store are metadata the explorer
  // has no business exposing; `browse` still lists the names.
  assertNotPpmSubtree(path);
  assertNotPpmSubtree(await realPathOrSelf(path));

  const st = await lstat(path);
  const kind = kindOfStats(st);
  const result: StatResult = {
    path,
    name: basename(path) || path,
    kind,
    size: st.size,
    mtime: st.mtime.toISOString(),
    ctime: st.ctime.toISOString(),
    birthtime: st.birthtime.toISOString(),
    mode: st.mode,
    readonly: await isReadOnly(path, st.mode),
    isHidden: isHiddenName(basename(path)),
  };

  if (kind === "symlink") {
    result.target = await readlink(path).catch(() => undefined);
  }
  if (kind === "directory") {
    try {
      const counted = await countChildren(path);
      result.childCount = counted.childCount;
      if (counted.truncated) result.truncated = true;
    } catch {
      // Unreadable directory — size info stays absent rather than failing stat.
    }
  }
  return result;
}
