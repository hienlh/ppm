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
    for (const [dir, previous] of this.snapshots) {
      const current = this.readDir(dir);

      for (const [name, mtime] of current) {
        const before = previous.get(name);
        if (before === undefined || before !== mtime) {
          this.options.onChange(join(dir, name));
        }
      }
      for (const name of previous.keys()) {
        if (!current.has(name)) this.options.onChange(join(dir, name));
      }

      this.snapshots.set(dir, current);
    }
  }

  /** Direct entries of `absDir` with their mtimes. Empty when it is unreadable. */
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
