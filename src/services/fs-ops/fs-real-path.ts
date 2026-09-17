import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Resolve a path through symlinks. A path that does not exist yet is resolved
 * through its deepest existing ancestor, which is what makes a symlinked
 * parent directory visible to the guards: without it, creating a *new* file
 * behind such a link would slip past a check on the literal path.
 *
 * Imports nothing from the guard, so the guard can build on it freely.
 */
export async function realPathOrSelf(target: string): Promise<string> {
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** Blocking twin, for the synchronous read path. */
export function realPathOrSelfSync(target: string): string {
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Is `child` the same directory as `parent`, or somewhere inside it?
 *
 * Case-folded on Windows, where `C:\Users\PC\ppm` and `c:\users\pc\ppm` are
 * one directory under two spellings: a case-sensitive prefix test refuses the
 * second, which reads to the caller as "outside the project" for a path the
 * server itself handed out. Nowhere else — on Linux two spellings really are
 * two directories.
 *
 * The separator follows the platform rather than `sep`, and `platform` is a
 * parameter, so win32 semantics can be asserted from a Linux test run the way
 * `assertSafeFilePaths` takes its `PathApi`. A backslash is a separator only on
 * Windows: on Linux `/home/x\evil` is a file *beside* `/home/x`, not inside it.
 */
export function isInsideDir(child: string, parent: string, platform: string = process.platform): boolean {
  const separators = platform === "win32" ? ["\\", "/"] : ["/"];
  const fold = (path: string) => (platform === "win32" ? path.toLowerCase() : path);
  const from = fold(parent).replace(/[\\/]+$/, "");
  const to = fold(child);
  if (to === from) return true;
  return to.startsWith(from) && separators.includes(to.charAt(from.length));
}
