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
