/**
 * Polling fallback for directories `fs.watch` can no longer report on.
 *
 * Bun (verified on 1.3.13, Linux) keys its `fs.watch` registry by the literal
 * path string, so once a directory has been watched, deleted and recreated, a
 * new watcher on that same path reuses the dead inotify watch and is silent
 * forever. Closing the old handle first or waiting does not help, and there is
 * no usable alternative spelling: a trailing separator is a distinct key that
 * works exactly once, while `//` and `///` normalise back to the same one.
 *
 * The poisoning is per-path and permanent, but it does NOT spread: a directory
 * Bun has never watched works normally even when it sits inside a recreated
 * parent. So this poller only ever covers the handful of paths that were
 * actually re-attached, one directory level each, and real watchers keep
 * covering everything else.
 *
 * Reproducers: `spike-bun-recursive-watch-probe.mjs` (the defect, and that
 * Windows is unaffected) and `spike-bun-watch-poison-scope-probe.mjs` (that it
 * is confined to previously-watched paths, which is what bounds this poller).
 *
 * Windows and macOS re-watch such directories correctly, so nothing here runs
 * there.
 */
import { lstatSync, readdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Slow enough to be invisible next to inotify, fast enough for a save-and-see loop. */
const POLL_INTERVAL_MS = 1000;
/**
 * Hard cap on polled directories. Churn is bounded in practice (a `git checkout`
 * recreates a few directories), and refusing to grow without limit matters more
 * than perfect coverage in a watcher that has already caused a watch-count
 * blowup once.
 */
const MAX_POLLED_DIRS = 64;
/**
 * Entries stat'ed per turn of the loop.
 *
 * A recreated `dist` or `node_modules` holds tens of thousands of files, and statting them in
 * one go is the stall this whole release is about — once a second, forever, for as long as the
 * directory stays polled. The reads are async so they run off the loop thread anyway; the batch
 * is what stops their *completions* arriving as one unbroken run of callbacks.
 */
const STAT_BATCH = 256;

export interface RecreatedDirPollerOptions {
  /** Absolute path of every entry that appeared, vanished or changed. */
  onChange: (absPath: string) => void;
  intervalMs?: number;
  maxDirs?: number;
}

/** name → mtimeMs for the direct entries of one directory. */
type DirSnapshot = Map<string, number>;

export class RecreatedDirPoller {
  private readonly snapshots = new Map<string, DirSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly maxDirs: number;
  private droppedForBudget = false;
  /** True while a sweep is in flight, so the interval cannot stack them. */
  private sweeping = false;

  constructor(private readonly options: RecreatedDirPollerOptions) {
    this.intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    this.maxDirs = options.maxDirs ?? MAX_POLLED_DIRS;
  }

  get size(): number {
    return this.snapshots.size;
  }

  /** True when a directory had to be refused because the cap was reached. */
  get truncated(): boolean {
    return this.droppedForBudget;
  }

  /**
   * Start polling `absDir`'s direct entries. The current contents become the
   * baseline, so pre-existing files are not reported as new.
   */
  add(absDir: string): void {
    if (this.snapshots.has(absDir)) return;
    if (this.snapshots.size >= this.maxDirs) {
      this.droppedForBudget = true;
      return;
    }
    this.snapshots.set(absDir, this.readDir(absDir));
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      // Never hold the process open just to poll.
      this.timer.unref?.();
    }
  }

  /** Stop polling `absDir` and anything beneath it. */
  remove(absDir: string): void {
    const prefix = absDir + "/";
    for (const dir of this.snapshots.keys()) {
      // Compare on both separators: callers pass native paths.
      if (dir === absDir || dir.startsWith(prefix) || dir.startsWith(absDir + "\\")) {
        this.snapshots.delete(dir);
      }
    }
    if (this.snapshots.size === 0) this.stopTimer();
  }

  close(): void {
    this.snapshots.clear();
    this.droppedForBudget = false;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    // A sweep that outlasts the interval must not be joined by the next one: two sweeps over
    // the same directories would double the syscalls and race each other's snapshot writes,
    // and the slower the host the worse it would get — the opposite of what polling is for.
    if (this.sweeping) return;
    this.sweeping = true;
    void this.sweep().finally(() => {
      this.sweeping = false;
    });
  }

  private async sweep(): Promise<void> {
    // Copied, because a directory can be added or removed while this awaits.
    let first = true;
    for (const dir of [...this.snapshots.keys()]) {
      if (!first) await new Promise((resolve) => setImmediate(resolve));
      first = false;
      const previous = this.snapshots.get(dir);
      if (!previous) continue; // removed while we were reading something else
      const current = await this.readDirAsync(dir);
      // Identity, not presence. A directory can be removed *and added back* while this reads,
      // which is the ordinary rebuild path on Linux — `scheduleRebuild` calls `closeSubtree`
      // (which removes) and then `cover` (which adds), and the new `add` installs a fresh
      // baseline synchronously. Diffing against the baseline that has since been replaced
      // reports changes the new one already accounts for.
      //
      // Reasoned rather than measured: the window is inside the await above, and no test here
      // reaches it. The severe half of the same hazard — storing the stale read over the new
      // baseline, which makes the *next* sweep report the whole directory — is the check below,
      // and that one is covered.
      if (this.snapshots.get(dir) !== previous) continue;

      for (const [name, mtime] of current) {
        const before = previous.get(name);
        if (before === undefined || before !== mtime) {
          this.report(join(dir, name));
        }
      }
      for (const name of previous.keys()) {
        if (!current.has(name)) this.report(join(dir, name));
      }

      // Checked again: `onChange` runs synchronously between the two, and this class is
      // exported with a caller-supplied callback that may close or re-register the directory.
      if (this.snapshots.get(dir) === previous) this.snapshots.set(dir, current);
    }
  }

  /**
   * One change, reported without letting a bad listener take the process down.
   *
   * The sweep runs from a `void`ed promise, so a throwing `onChange` becomes an unhandled
   * rejection — and the server treats three of those in a minute as fatal, which a poller
   * ticking once a second reaches in three. Swallowing is right here: the listener's failure
   * is the listener's business, and the alternative is that one bad path stops the directory
   * being watched at all.
   */
  private report(absPath: string): void {
    try {
      this.options.onChange(absPath);
    } catch {
      // The caller's problem, not a reason to stop polling.
    }
  }

  /**
   * Direct entries of `absDir` with their mtimes, without holding the loop.
   *
   * Empty when unreadable — deleted again, or permissions.
   */
  private async readDirAsync(absDir: string): Promise<DirSnapshot> {
    const snapshot: DirSnapshot = new Map();
    let names: string[];
    try {
      names = await readdir(absDir);
    } catch {
      return snapshot;
    }
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      // Measured, not assumed: on 10k entries, async reads alone took the worst loop gap from
      // 341ms to 194ms, because the completions still arrived as one unbroken run. Handing the
      // loop a turn between batches is what takes it to single digits.
      if (i > 0) await new Promise((resolve) => setImmediate(resolve));
      const batch = names.slice(i, i + STAT_BATCH);
      const stats = await Promise.all(
        batch.map(async (name) => {
          try {
            // lstat, not stat: a symlink's own mtime, never its target's, matching
            // the scan that decides coverage.
            return [name, (await lstat(join(absDir, name))).mtimeMs] as const;
          } catch {
            // Vanished between readdir and lstat; the next tick reports it.
            return null;
          }
        }),
      );
      for (const entry of stats) if (entry) snapshot.set(entry[0], entry[1]);
    }
    return snapshot;
  }

  /**
   * The same read, synchronously, for the baseline taken at registration.
   *
   * It stays sync so the baseline is the directory as it was at the moment `add` was called:
   * a `git checkout` writes into a recreated directory immediately, and those writes are
   * exactly what the poller exists to report. Taking the baseline a turn later would fold them
   * into it and report nothing. It is one read per directory, not one per second.
   */
  private readDir(absDir: string): DirSnapshot {
    const snapshot: DirSnapshot = new Map();
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch {
      return snapshot; // deleted again, or permissions — treat as empty
    }
    for (const name of names) {
      try {
        // lstat, not stat: a symlink's own mtime, never its target's, matching
        // the scan that decides coverage.
        snapshot.set(name, lstatSync(join(absDir, name)).mtimeMs);
      } catch {
        // Vanished between readdir and lstat; the next tick reports it.
      }
    }
    return snapshot;
  }
}
