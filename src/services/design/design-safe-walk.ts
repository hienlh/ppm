import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isCredentialPath } from "../fs-path-guard.service.ts";
import { isInsideDir } from "../fs-ops/fs-real-path.ts";
import { DOT_DESIGN, lstatOrNull } from "./design-paths.ts";

/**
 * The one tree walker every design tree operation goes through: snapshot, tree hash,
 * restore staging, and the zip/standalone exports.
 *
 * A design folder is written by an agent, so it can contain anything the agent (or a
 * prompt injected into it) chose to create. The walker therefore:
 *  - uses `lstat` and skips symlinks, so a link to `ppm.db`, a key file or `/` is never
 *    read, copied into a snapshot, or packed into an export;
 *  - skips anything that is not a regular file or a directory — opening a FIFO for reading
 *    blocks until a writer appears, which would hang the tree hash forever;
 *  - checks every entry's real path is inside the walked root (a Windows junction or a
 *    bind mount can pass the symlink test and still point elsewhere);
 *  - refuses credential paths outright, so a design that somehow sits inside the PPM
 *    directory fails loudly instead of being copied around.
 */

export interface SafeWalkEntry {
  /** Path relative to the walked root, `/`-separated on every platform. */
  rel: string;
  abs: string;
  size: number;
}

export type SafeWalkErrorCode = "EROOT" | "EOUTSIDE" | "ECREDENTIAL" | "EDEPTH" | "ENOTREG" | "ETOOBIG";

export class SafeWalkError extends Error {
  readonly status: number;
  constructor(readonly code: SafeWalkErrorCode, message: string) {
    super(message);
    this.name = "SafeWalkError";
    this.status = code === "ETOOBIG" ? 413 : 403;
  }
}

export interface SafeWalkOptions {
  /** Skip the top-level `.design/` directory (the design's own working data). Default true. */
  skipDotDesign?: boolean;
  /** Deepest directory nesting walked before the tree is refused. Default 32. */
  maxDepth?: number;
}

async function assertContained(abs: string, realRoot: string): Promise<void> {
  const real = await realpath(abs);
  if (!isInsideDir(real, realRoot)) throw new SafeWalkError("EOUTSIDE", `Entry resolves outside the design: ${abs}`);
  if (isCredentialPath(abs) || isCredentialPath(real)) {
    throw new SafeWalkError("ECREDENTIAL", "Refusing to read a credential path");
  }
}

/** Yields every regular file under `root` in a stable (sorted) order. */
export async function* safeWalkDesignTree(root: string, opts: SafeWalkOptions = {}): AsyncGenerator<SafeWalkEntry> {
  const skipDotDesign = opts.skipDotDesign ?? true;
  const maxDepth = opts.maxDepth ?? 32;
  const st = await lstat(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SafeWalkError("EROOT", "Walk root must be a real directory");
  const realRoot = await realpath(root);
  if (isCredentialPath(root) || isCredentialPath(realRoot)) {
    throw new SafeWalkError("ECREDENTIAL", "Refusing to walk a credential path");
  }

  async function* walk(dirAbs: string, relDir: string, depth: number): AsyncGenerator<SafeWalkEntry> {
    if (depth > maxDepth) throw new SafeWalkError("EDEPTH", `Design tree nests deeper than ${maxDepth} levels`);
    // Sorted by code unit rather than locale so the tree hash is identical on every host.
    const names = (await readdir(dirAbs)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      if (depth === 0 && skipDotDesign && name === DOT_DESIGN) continue;
      const abs = join(dirAbs, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const entry = await lstatOrNull(abs);
      if (!entry || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await assertContained(abs, realRoot);
        yield* walk(abs, rel, depth + 1);
      } else if (entry.isFile()) {
        await assertContained(abs, realRoot);
        yield { rel, abs, size: entry.size };
      }
      // FIFOs, sockets and devices are skipped: nothing in a design needs one.
    }
  }

  yield* walk(realRoot, "", 0);
}

// Where the platform has them: refuse to open through a symlink swapped in after the
// walk's lstat, and never block opening a FIFO swapped in the same way. Windows has
// neither flag, and there the lstat immediately before is the protection.
const SAFE_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Read one file the walker yielded, re-checking through the open handle that it is still a
 * regular file. Closes the window between the walk's `lstat` and the read, in which the
 * entry could have been replaced by a symlink or a FIFO.
 */
export async function readDesignFileSafe(abs: string, maxBytes?: number): Promise<Buffer> {
  const handle = await open(abs, SAFE_OPEN_FLAGS);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new SafeWalkError("ENOTREG", `Not a regular file: ${abs}`);
    if (maxBytes !== undefined && st.size > maxBytes) {
      throw new SafeWalkError("ETOOBIG", `File exceeds ${maxBytes} bytes: ${abs}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
