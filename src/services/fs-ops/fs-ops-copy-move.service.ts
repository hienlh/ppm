import { lstat } from "node:fs/promises";
import {
  assertAllowed,
  assertNotProtected,
  resolvePath,
} from "../fs-path-guard.service.ts";
import { copyEntry, moveEntry } from "./fs-core-ops.ts";

export interface CopyMoveResult {
  source: string;
  destination: string;
  crossDevice?: boolean;
}

/** Resolve and whitelist both sides of a two-path operation. */
async function resolvePair(source: string, destination: string): Promise<[string, string]> {
  const src = resolvePath(source);
  const dst = resolvePath(destination);
  assertAllowed(src);
  assertAllowed(dst);
  // Fail early with 404 instead of a confusing copy error.
  await lstat(src);
  return [src, dst];
}

/** Copy a file or directory tree; an occupied destination surfaces as EEXIST. */
export async function copyPath(source: string, destination: string): Promise<CopyMoveResult> {
  const [src, dst] = await resolvePair(source, destination);
  await copyEntry(src, dst);
  return { source: src, destination: dst };
}

/**
 * Move a file or directory. The source is a protected-root candidate because
 * moving `$HOME` or a drive root away is as destructive as deleting it.
 */
export async function movePath(source: string, destination: string): Promise<CopyMoveResult> {
  const [src, dst] = await resolvePair(source, destination);
  await assertNotProtected(src);
  const { crossDevice } = await moveEntry(src, dst);
  return { source: src, destination: dst, crossDevice };
}
