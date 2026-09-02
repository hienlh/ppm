import { lstat } from "node:fs/promises";
import {
  assertAllowed,
  assertNotPpmSubtreeDeep,
  assertNotProtected,
  resolvePath,
} from "../fs-path-guard.service.ts";
import { copyEntry, moveEntry } from "./fs-core-ops.ts";

export interface CopyMoveResult {
  source: string;
  destination: string;
  crossDevice?: boolean;
  /** False when a cross-device move copied the data but could not delete the source. */
  sourceRemoved?: boolean;
}

/**
 * Resolve and whitelist both sides of a two-path operation. Neither side may
 * touch the PPM directory: reading that subtree is blocked, so copying out of
 * it would work around the shield, and writing into it could overwrite the
 * running server's own state. Real paths are checked too, so a symlink cannot
 * stand in for either end.
 */
async function resolvePair(source: string, destination: string): Promise<[string, string]> {
  const src = resolvePath(source);
  const dst = resolvePath(destination);
  assertAllowed(src);
  assertAllowed(dst);
  await assertNotPpmSubtreeDeep(src);
  await assertNotPpmSubtreeDeep(dst);
  // Fail early with 404 instead of a confusing copy error.
  await lstat(src);
  return [src, dst];
}

/**
 * Copy a file or directory tree. `destination` is the FULL target path, not a
 * containing folder: copying `a.txt` onto folder `docs` must be requested as
 * `docs/a.txt`. An already-occupied destination — including an existing
 * directory — surfaces as EEXIST so the caller can prompt instead of merging
 * two trees by accident.
 */
export async function copyPath(source: string, destination: string): Promise<CopyMoveResult> {
  const [src, dst] = await resolvePair(source, destination);
  await copyEntry(src, dst);
  return { source: src, destination: dst };
}

/**
 * Move a file or directory. `destination` is the FULL target path, same
 * contract as `copyPath`. The source is a protected-root candidate because
 * moving `$HOME` or a drive root away is as destructive as deleting it.
 */
export async function movePath(source: string, destination: string): Promise<CopyMoveResult> {
  const [src, dst] = await resolvePair(source, destination);
  await assertNotProtected(src);
  const { crossDevice, sourceRemoved } = await moveEntry(src, dst);
  return { source: src, destination: dst, crossDevice, sourceRemoved };
}
