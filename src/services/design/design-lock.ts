import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

/**
 * One in-process mutex per design (`projectPath::slug`). Every operation that reads and
 * then rewrites a design's files or its `.design/` data — snapshot, restore, manifest
 * rename, comments, canvas write-backs — runs inside it, so a turn snapshot can never copy
 * a tree a restore is halfway through replacing.
 *
 * Entries are dropped once their chain settles with nobody waiting, so a long-running
 * server holds one entry per design currently in use rather than one per design ever
 * touched.
 *
 * Reentrant within one async call chain: a caller already holding the lock (a canvas
 * write-back taking its `before-edit` snapshot) runs straight through instead of queueing
 * behind itself forever.
 */

interface LockEntry {
  tail: Promise<void>;
  holders: number;
}

const locks = new Map<string, LockEntry>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** Canonical key; case-folded on Windows, where two spellings name one folder. */
export function designLockKey(projectPath: string, slug: string): string {
  const project = resolve(projectPath);
  return `${process.platform === "win32" ? project.toLowerCase() : project}::${slug}`;
}

export async function withDesignLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const current = held.getStore();
  if (current?.has(key)) return fn();

  let entry = locks.get(key);
  if (!entry) {
    entry = { tail: Promise.resolve(), holders: 0 };
    locks.set(key, entry);
  }
  entry.holders++;
  const previous = entry.tail;
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  entry.tail = previous.then(() => mine);

  try {
    await previous;
    const next = new Set(current ?? []);
    next.add(key);
    return await held.run(next, fn);
  } finally {
    release();
    entry.holders--;
    if (entry.holders === 0 && locks.get(key) === entry) locks.delete(key);
  }
}

/**
 * Run `fn` as if no design lock were held. Reentrancy follows the async context, and a
 * timer inherits the context it was created in, so deferred work (a debounced snapshot)
 * scheduled from inside a lock would otherwise skip the queue when it fires later.
 */
export function detachFromDesignLocks<T>(fn: () => T): T {
  return held.exit(fn);
}

/** Number of designs with a live lock entry; exposed for leak tests. */
export function activeDesignLockCount(): number {
  return locks.size;
}
