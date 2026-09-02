import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertAllowed,
  assertNotPpmSubtreeDeep,
  assertNotProtected,
  resolvePath,
} from "../fs-path-guard.service.ts";
import { removeEntry, renameEntry } from "./fs-core-ops.ts";

/** Rename in place: the new name is joined onto the source's own directory. */
export async function renamePath(path: string, newName: string): Promise<{ from: string; to: string }> {
  if (!newName || /[\\/]/.test(newName)) {
    throw Object.assign(new Error("newName must be a bare file name"), { status: 400, code: "EINVAL" });
  }
  const src = resolvePath(path);
  assertAllowed(src);
  // Renaming inside the PPM directory would break the running server's own state.
  await assertNotPpmSubtreeDeep(src);
  await assertNotProtected(src);
  await lstat(src);
  const dst = join(dirname(src), newName);
  assertAllowed(dst);
  await assertNotPpmSubtreeDeep(dst);
  await renameEntry(src, dst);
  return { from: src, to: dst };
}

/** Permanent delete of a file, directory tree or symlink (link only). */
export async function deletePath(path: string): Promise<{ removed: string }> {
  const target = resolvePath(path);
  assertAllowed(target);
  await assertNotProtected(target);
  await lstat(target);
  await removeEntry(target);
  return { removed: target };
}

/** Create an empty file; refuses to clobber an existing entry. */
export async function touchFile(path: string): Promise<{ path: string }> {
  const target = resolvePath(path);
  assertAllowed(target);
  await assertNotPpmSubtreeDeep(target);
  // `wx` makes the create-or-fail decision atomic at the syscall level.
  await writeFile(target, "", { flag: "wx" });
  return { path: target };
}

/** Create a directory; `recursive:false` keeps EEXIST visible to the client. */
export async function makeDir(path: string): Promise<{ path: string }> {
  const target = resolvePath(path);
  assertAllowed(target);
  await assertNotPpmSubtreeDeep(target);
  await mkdir(target, { recursive: false });
  return { path: target };
}
