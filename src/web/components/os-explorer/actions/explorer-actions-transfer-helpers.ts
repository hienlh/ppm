/**
 * Pure helpers shared by `transfer()`: finding a free "name (n)" for Keep-both/same-folder
 * copy, running one copy/move call, and turning a failure into a toast description. Split
 * out of `explorer-actions-clipboard.ts` to keep that file under the line cap.
 */

import { fsApi, FsError } from "@/lib/fs-api";
import { joinPath, suffixName } from "../format-file-meta";

/** Highest "name (n)" suffix tried before giving up on a free name. */
const MAX_KEEP_BOTH_ATTEMPTS = 99;

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsApi.stat(path);
    return true;
  } catch (e) {
    if (e instanceof FsError && e.code === "ENOENT") return false;
    // Anything else (permission, protected root) is not a free name either.
    return true;
  }
}

export async function freeName(dir: string, name: string, sep: string): Promise<string | null> {
  for (let n = 2; n <= MAX_KEEP_BOTH_ATTEMPTS; n++) {
    const candidate = suffixName(name, n);
    if (!(await pathExists(joinPath(dir, candidate, sep)))) return candidate;
  }
  return null;
}

export async function runOne(source: string, destination: string, op: "copy" | "move"): Promise<void> {
  if (op === "copy") await fsApi.copy(source, destination);
  else await fsApi.move(source, destination);
}
