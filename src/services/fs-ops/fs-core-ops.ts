import { cpSync, renameSync, rmSync, lstatSync } from "node:fs";
import { cp, lstat, rename, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Shared copy/move/rename/remove core used by both the project-scoped file
 * service and the out-of-project explorer routes. The interesting rules —
 * collision detection, self-nesting refusal, case-only rename, cross-device
 * fallback — live here once so the two doors cannot drift apart. Everything
 * inspects the link itself (`lstat`), never the symlink target, so operating
 * on a link never touches the file it points at.
 */

function fsError(message: string, code: string, status: number): Error {
  return Object.assign(new Error(message), { code, status });
}

export function eexist(path: string): Error {
  return fsError(`Already exists: ${path}`, "EEXIST", 409);
}

/** Path-level equality on a case-insensitive filesystem. */
function sameNameIgnoringCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * A rename that only changes letter case (`Foo` → `foo`) hits a false
 * collision on Windows/macOS, where the destination "exists" because it is
 * the source. Allowed when the platform is case-insensitive or the two paths
 * resolve to the same inode.
 */
export function isCaseOnlyRename(src: string, dst: string): boolean {
  const a = resolve(src);
  const b = resolve(dst);
  if (a === b || !sameNameIgnoringCase(a, b)) return false;
  if (process.platform === "win32" || process.platform === "darwin") return true;
  try {
    return lstatSync(a).ino === lstatSync(b).ino;
  } catch {
    return false;
  }
}

/** Copying or moving a directory into its own subtree would recurse forever. */
export function assertNotNested(src: string, dst: string): void {
  const a = resolve(src);
  const b = resolve(dst);
  if (b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)) {
    throw fsError(`Cannot place ${a} inside itself`, "EINVAL", 400);
  }
}

async function existsAsLink(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function existsAsLinkSync(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reject an occupied destination before any bytes move. `allowCaseOnly` is
 * set for rename/move, where the "existing" destination is the source itself
 * under different casing; a copy in that situation would target one file with
 * itself and must still fail.
 */
async function assertFreeDestination(src: string, dst: string, allowCaseOnly: boolean): Promise<void> {
  if (!(await existsAsLink(dst))) return;
  if (allowCaseOnly && isCaseOnlyRename(src, dst)) return;
  throw eexist(dst);
}

// ── Async ops (explorer routes; never block the event loop) ─────────

export async function copyEntry(src: string, dst: string): Promise<void> {
  assertNotNested(src, dst);
  await assertFreeDestination(src, dst, false);
  await cp(src, dst, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
}

export async function renameEntry(src: string, dst: string): Promise<void> {
  assertNotNested(src, dst);
  await assertFreeDestination(src, dst, true);
  await rename(src, dst);
}

export async function removeEntry(path: string): Promise<void> {
  await rm(path, { recursive: true, force: false });
}

/**
 * Move with a cross-device fallback: `rename` fails with EXDEV between two
 * volumes (C: → D:, /home → /mnt), where a copy followed by a delete is the
 * only way to keep the operation looking atomic to the caller.
 */
export async function moveEntry(src: string, dst: string): Promise<{ crossDevice: boolean }> {
  assertNotNested(src, dst);
  await assertFreeDestination(src, dst, true);
  try {
    await rename(src, dst);
    return { crossDevice: false };
  } catch (e) {
    if ((e as { code?: string }).code !== "EXDEV") throw e;
    await cp(src, dst, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    await rm(src, { recursive: true, force: false });
    return { crossDevice: true };
  }
}

// ── Sync ops (project-scoped file service keeps its sync contract) ──

export function copyEntrySync(src: string, dst: string): void {
  assertNotNested(src, dst);
  if (existsAsLinkSync(dst)) throw eexist(dst);
  cpSync(src, dst, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
}

export function renameEntrySync(src: string, dst: string): void {
  assertNotNested(src, dst);
  if (existsAsLinkSync(dst) && !isCaseOnlyRename(src, dst)) throw eexist(dst);
  renameSync(src, dst);
}

export function removeEntrySync(path: string): void {
  rmSync(path, { recursive: true, force: false });
}
