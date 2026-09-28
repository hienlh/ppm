import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dotDesignDir, lstatOrNull } from "./design-paths.ts";

/** Contents of `designs/<slug>/.design/.gitignore`: nothing in there is ever tracked. */
export const DOT_DESIGN_GITIGNORE = "*\n";

/** mkdir that tolerates an existing directory without going recursive (see resolveDesignsRoot). */
export async function mkdirIfMissing(path: string): Promise<void> {
  if (await lstatOrNull(path)) return;
  try {
    await mkdir(path);
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
  }
}

/**
 * Write a file so readers see either the old or the new contents, never a torn one.
 *
 * `rename` over an existing file replaces it on POSIX and (through MoveFileEx) on Windows,
 * but a Windows reader holding the target open can still make it fail with EPERM/EACCES.
 * The fallback then removes the target first: for the files written here (manifest,
 * journal, snapshot meta) a moment with no file is recoverable, a half-written one is not.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = join(dirname(path), `.tmp-${randomBytes(4).toString("hex")}-${Date.now()}`);
  await writeFile(tmp, data);
  try {
    await rename(tmp, path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES" && code !== "EEXIST")) {
      await rm(tmp, { force: true });
      throw e;
    }
    try {
      await unlink(path).catch((err: { code?: string }) => {
        if (err.code !== "ENOENT") throw err;
      });
      await rename(tmp, path);
    } catch (retry) {
      await rm(tmp, { force: true });
      throw retry;
    }
  }
}

/**
 * Make sure `designs/<slug>/.design/` exists and carries its `.gitignore`.
 *
 * Checked on every write into `.design/`, not only at creation: a design folder the agent
 * made itself, or one whose `.gitignore` was deleted, must not start leaking snapshots into
 * `git status` the first time a turn is snapshotted.
 */
export async function ensureDotDesign(designDir: string): Promise<string> {
  const dir = dotDesignDir(designDir);
  const st = await lstatOrNull(dir);
  if (st && (st.isSymbolicLink() || !st.isDirectory())) {
    throw Object.assign(new Error(".design must be a real directory"), { status: 403, code: "EDESIGNPATH" });
  }
  if (!st) await mkdirIfMissing(dir);
  const ignore = join(dir, ".gitignore");
  if (!(await lstatOrNull(ignore))) await writeFile(ignore, DOT_DESIGN_GITIGNORE);
  return dir;
}
