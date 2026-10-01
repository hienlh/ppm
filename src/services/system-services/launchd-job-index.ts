/**
 * Which launchd job each process belongs to, for the Services page's CPU and Memory
 * columns — the macOS stand-in for reading a process's cgroup.
 *
 * A job owns its main process and everything that process started, which on Linux
 * is exactly the unit's cgroup. launchd offers no per-process answer, so the Services
 * listing records each job's main pid here and the metrics tick walks every row's
 * parents up to one of them. It costs the tick nothing to spawn: the listing it
 * relies on is the one the Services page already polls every few seconds, and a
 * listing older than `STALE_AFTER_MS` is not used at all. Pids are reused, and a
 * page that stopped polling has nobody left to show the figures to.
 *
 * What it cannot see: a process whose parent exited, which launchd adopts and which
 * then belongs to no job, and an app's XPC services, which run in the app's own
 * domain rather than under any listed job.
 */
export const STALE_AFTER_MS = 10_000;

export interface ProcessParent {
  pid: number;
  ppid: number;
}

export function createLaunchdJobIndex(now: () => number = Date.now) {
  let byPid = new Map<number, string>();
  let at = -Infinity;

  return {
    /** A fresh listing's main pids, each with its `"<scope>:<label>"`. */
    update(mainPids: Iterable<readonly [number, string]>): void {
      byPid = new Map(mainPids);
      at = now();
    },

    /** pid → key for every row that is a job's process or descends from one. */
    keysFor(rows: readonly ProcessParent[]): Map<number, string> {
      const keys = new Map<number, string>();
      if (byPid.size === 0 || now() - at > STALE_AFTER_MS) return keys;
      const ppidOf = new Map(rows.map((r) => [r.pid, r.ppid]));
      /** Every pid already walked, with its answer; null = belongs to no job. */
      const memo = new Map<number, string | null>();
      const resolve = (pid: number): string | null => {
        const path: number[] = [];
        let found: string | null = null;
        for (let p: number | undefined = pid; p !== undefined && p > 1; p = ppidOf.get(p)) {
          const known = memo.get(p);
          if (known !== undefined) {
            found = known;
            break;
          }
          const key = byPid.get(p);
          if (key !== undefined) {
            found = key;
            path.push(p);
            break;
          }
          // A pid table from one `ps` run cannot loop, but a malformed one must not hang the tick.
          if (path.includes(p)) break;
          path.push(p);
        }
        for (const p of path) memo.set(p, found);
        return found;
      };
      for (const row of rows) {
        const key = resolve(row.pid);
        if (key !== null) keys.set(row.pid, key);
      }
      return keys;
    },
  };
}

export type LaunchdJobIndex = ReturnType<typeof createLaunchdJobIndex>;

let shared: LaunchdJobIndex | null = null;

/** The one index the Services listing writes and the metrics tick reads. */
export function launchdJobIndex(): LaunchdJobIndex {
  return (shared ??= createLaunchdJobIndex());
}
