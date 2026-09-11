import { lstatSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import { hasIgnoredDirSegment, isIgnoredDirName, isIgnoredPath } from "./ignore-rules.ts";
import { RecreatedDirPoller } from "./recreated-dir-poller.ts";

/**
 * Watches a project directory while keeping the number of watched directories
 * near the number of *interesting* ones.
 *
 * `fs.watch(root, { recursive: true })` is a single call, but on Linux the runtime
 * expands it into one inotify watch per *entry* — every file as well as every
 * directory, dependency trees included. Filtering those events on arrival (what this
 * service used to do) still pays the full cost, which is how a handful of projects
 * reached ~360k watches and pushed the machine against `fs.inotify.max_user_watches`.
 *
 * So coverage is chosen up front, and the shape depends on what the platform's
 * recursive watch actually is.
 *
 * On Windows and macOS it is a kernel-side subtree watch (`ReadDirectoryChangesW`,
 * FSEvents): one handle covers a whole subtree, it tracks directories created later,
 * and it does not traverse reparse points. Measured on Windows 11 / Bun 1.3.10 over a
 * 2,441-directory tree, one recursive handle attaches in 80ms for +7.0MB where one
 * handle per directory takes 965ms for +25.2MB. So a subtree with no ignored directory
 * inside it gets a single recursive watch there.
 *
 * On Linux there is no such call. Bun emulates it by walking the tree and opening a
 * watch per entry, and that cost does not depend on the shape: measured over 4
 * directories holding 600 files, one recursive handle and one non-recursive handle per
 * directory both come to 604 descriptors on a single inotify instance. So this split
 * buys nothing in inotify terms — the handle count was never what `max_user_instances`
 * counts — and it is not why Linux takes a handle per directory.
 *
 * What it buys is coverage. The emulation differs from this scan in two ways: it does
 * not pick up directories created after it attached, and it walks through symlinks this
 * scan deliberately skips — a pnpm workspace with a symlinked `node_modules` had its
 * whole store watched, one open descriptor per file, which exhausted the process at
 * ~724k descriptors.
 *
 * Either way the walk below is what prunes ~92% of the directories in a typical repo,
 * and an ignored branch is never handed to the runtime.
 */

/** Coalesce a burst of directory churn into a single subtree rebuild. */
const REBUILD_DEBOUNCE_MS = 500;

/**
 * Directories walked between two hand-backs of the event loop.
 *
 * Covering a project used to be one synchronous burst: `readdirSync` down the
 * whole tree, then `fs.watch` on every directory it kept. On a 12,000-directory
 * project that held the loop for **2.95 seconds** at startup — measured, and
 * billed to PPM by the lag monitor at ratio 1.38 across two independent
 * restarts (the ratio is over 1 because Bun runs the `readdirSync` calls on its
 * file system thread pool while the main thread walks). Nothing else in the
 * process could run for any of it.
 *
 * Picked by measurement on a 13,321-directory tree, against a 5 ms timer whose
 * fires are counted. The wall time is allowed to get worse — nothing waits on
 * this walk any more — so the number to read is the worst single pause:
 *
 *   sync (before)   2361 ms wall     0 fires    gap = the whole 2361 ms
 *   every 250 dirs  2653 ms wall    63 fires    worst gap 134 ms
 *   every  64 dirs  2812 ms wall   183 fires    worst gap  41 ms
 *   every  32 dirs  4624 ms wall   503 fires    worst gap  23 ms
 *
 * 64 is where the curve bends: halving it again buys 18 ms off the worst pause
 * and costs 1.8 seconds of wall time. The residual ~41 ms is one batch, not
 * scheduling overhead — it is the same with either yield primitive below.
 */
const YIELD_EVERY_DIRS = 64;

/**
 * Whether `{ recursive: true }` is a real subtree watch rather than a per-directory walk.
 * Named platforms rather than `!== "linux"`, so a runtime nobody has measured here —
 * freebsd, say — takes the conservative walk instead of inheriting a promise about
 * `ReadDirectoryChangesW`. `RecreatedDirPoller` is derived from this for the same reason:
 * the emulation is a different mechanism with different defects.
 */
const NATIVE_RECURSIVE = process.platform === "win32" || process.platform === "darwin";

export interface WatchTreeOptions {
  /** Absolute path of the directory to watch. */
  root: string;
  /** Cap on covered directories — on Linux this is the inotify watch budget. */
  maxDirs: number;
  /** Called with a root-relative POSIX path for every change worth reporting. */
  onChange: (relPath: string) => void;
}

interface ScanNode {
  path: string;
  dirs: ScanNode[];
  /** Subtree holds an ignored directory, so a recursive watch here would cover it too. */
  hasIgnored: boolean;
  /** Directory count of this subtree, including itself. */
  size: number;
}

interface AttachedWatcher {
  watcher: FSWatcher;
  /** Directories this watcher accounts for: the subtree when recursive, else itself. */
  covers: number;
  recursive: boolean;
}

export interface WatchTreeStats {
  /** Directories covered ≈ inotify watches held on Linux. */
  dirs: number;
  /** `fs.watch` handles held. */
  watchers: number;
  /** Coverage was cut short by a budget, so part of the tree is unwatched. */
  truncated: boolean;
  /**
   * Directories covered by the polling fallback instead of a watcher, because
   * the runtime cannot re-watch a recreated path. Linux only; 0 elsewhere.
   */
  polledDirs: number;
}

export class WatchTree {
  private readonly attached = new Map<string, AttachedWatcher>();
  private readonly rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Every path we have ever handed to `fs.watch`. On Bun + Linux a second watch
   * on the same path after a delete/recreate is silent forever, so this set is
   * what tells us a watcher cannot be trusted and the poller has to stand in.
   */
  private readonly everAttached = new Set<string>();
  private readonly poller: RecreatedDirPoller | null;
  private covered = 0;
  private truncated = false;
  private closed = false;
  private sinceYield = 0;
  /**
   * Covers run one at a time, as they did when they were synchronous.
   *
   * Each one reads `this.covered` to work out its remaining budget, so two
   * interleaving would each believe the other's watchers were still unspent and
   * together overshoot `maxDirs` — which on Linux is the inotify budget, the one
   * number this class exists to respect.
   */
  private coverChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: WatchTreeOptions) {
    // Only Bun on Linux has the stale-watch defect; elsewhere re-watching works
    // and paying for polling would be pure waste.
    // Tied to NATIVE_RECURSIVE rather than re-testing the platform: the poller stands in
    // for a defect of the same emulation, and `attach()` relies on exactly one of the two
    // being in play. Deriving it here keeps that from drifting apart.
    this.poller = !NATIVE_RECURSIVE
      ? new RecreatedDirPoller({ onChange: (abs) => this.reportAbs(abs) })
      : null;
  }

  start(): Promise<void> {
    return this.cover(this.options.root);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.rebuildTimers.values()) clearTimeout(timer);
    this.rebuildTimers.clear();
    for (const { watcher } of this.attached.values()) {
      try { watcher.close(); } catch { /* already gone */ }
    }
    this.attached.clear();
    this.everAttached.clear();
    this.poller?.close();
    this.covered = 0;
    this.truncated = false;
  }

  stats(): WatchTreeStats {
    return {
      dirs: this.covered,
      watchers: this.attached.size,
      truncated: this.truncated || (this.poller?.truncated ?? false),
      polledDirs: this.poller?.size ?? 0,
    };
  }

  /** Walk `absDir` and attach the fewest watchers that cover it without touching ignored dirs. */
  private cover(absDir: string): Promise<void> {
    const run = this.coverChain.then(() => this.coverNow(absDir));
    // The chain must survive a failure — one unreadable subtree cannot stop
    // every later cover — but the caller still has to be able to see it, so the
    // swallowing copy and the returned promise are deliberately not the same one.
    this.coverChain = run.catch(() => {});
    return run;
  }

  private async coverNow(absDir: string): Promise<void> {
    if (this.closed) return;
    const budget = { left: this.options.maxDirs - this.covered };
    if (budget.left <= 0) {
      this.truncated = true;
      return;
    }
    this.sinceYield = 0;
    await this.attach(await this.scan(absDir, budget));
  }

  /**
   * Hand the event loop back every `YIELD_EVERY_DIRS` directories, and say
   * whether the walk should carry on.
   *
   * A **macrotask**, not `await Promise.resolve()`. A microtask queue drains
   * without ever letting a timer or a socket run, so awaiting one would leave
   * the loop exactly as blocked while looking asynchronous — the same trap
   * measured and documented in `file-lines.ts`.
   *
   * `close()` can now land in one of these pauses, which is why the answer is
   * a boolean rather than void: a walk that carries on past it would attach
   * watchers to a tree nobody is going to close.
   *
   * `setImmediate` rather than `setTimeout(…, 0)`: both let timers run, and
   * both leave the same 41 ms worst pause, but a timer costs a real round trip
   * per yield — at 208 yields that measured 3.4 s of wall time against 2.8 s.
   */
  private async yieldIfDue(): Promise<boolean> {
    if (++this.sinceYield < YIELD_EVERY_DIRS) return !this.closed;
    this.sinceYield = 0;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return !this.closed;
  }

  private async scan(absDir: string, budget: { left: number }): Promise<ScanNode> {
    const node: ScanNode = { path: absDir, dirs: [], hasIgnored: false, size: 1 };
    budget.left--;
    if (!(await this.yieldIfDue())) return node;

    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return node; // unreadable or raced with a delete
    }

    for (const entry of entries) {
      // A symlink named like an ignored directory still has to mark the subtree, or an
      // ancestor takes a recursive watch over a `node_modules` this walk never entered —
      // which is how a pnpm store got watched through the link. Tested before
      // isDirectory(), which is false for symlinks. Plain files are deliberately left out:
      // IGNORED_DIRS holds names like `build`, `out` and `target`, and a compiled binary
      // called `build` is no reason to cost everything around it its recursive coverage.
      // A symlink to a *file* is caught here too, since telling it from a link to a
      // directory needs a stat() the walk would otherwise never make. It holds no subtree,
      // so marking it only forfeits recursive coverage — the safe direction, and it takes
      // a file named exactly `node_modules` or `target` to happen at all.
      if (isIgnoredDirName(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
        node.hasIgnored = true;
        continue;
      }
      // isDirectory() is false for symlinks, which keeps link cycles and
      // duplicate coverage (pnpm stores, workspace links) out of the walk.
      if (!entry.isDirectory()) continue;
      if (budget.left <= 0) {
        // Unscanned directories remain: mark the node so no ancestor covers them
        // recursively, since we cannot know what they hold.
        node.hasIgnored = true;
        this.truncated = true;
        break;
      }
      const child = await this.scan(join(absDir, entry.name), budget);
      node.dirs.push(child);
      node.size += child.size;
      if (child.hasIgnored) node.hasIgnored = true;
    }

    return node;
  }

  private async attach(node: ScanNode): Promise<void> {
    if (this.closed) return;
    const fitsWholeSubtree = this.covered + node.size <= this.options.maxDirs;

    // A path we have watched before is being re-attached, so this directory was deleted
    // and recreated, and on Bun + Linux its watcher will never fire again — poll its own
    // entries instead. It needs no special coverage beyond that: the poller only exists
    // where the recursive branch below is off, so the per-directory walk it falls through
    // to is already the watch-on-a-path-the-runtime-still-honours this case wants.
    if (this.poller && this.everAttached.has(node.path)) this.poller.add(node.path);

    // One recursive watch for a subtree the runtime can safely expand on its own —
    // only where that is a kernel-side subtree watch rather than a per-directory walk.
    if (NATIVE_RECURSIVE && !node.hasIgnored && fitsWholeSubtree
        && this.addWatcher(node.path, true, node.size)) return;

    // Otherwise cover this directory alone and recurse — a failed recursive attach
    // falls through to here too, so one unwatchable directory cannot silently drop
    // everything beneath it.
    if (this.covered + 1 > this.options.maxDirs) {
      this.truncated = true;
      return;
    }
    this.addWatcher(node.path, false, 1);
    if (!(await this.yieldIfDue())) return;
    for (const child of node.dirs) await this.attach(child);
  }

  private addWatcher(absDir: string, recursive: boolean, covers: number): boolean {
    // The tightest guard against a walk that was still running when `close()`
    // ran: a handle opened after it is one nothing will ever close, because
    // `close()` has already emptied the map it would have been recorded in.
    if (this.closed) return false;
    if (this.attached.has(absDir)) return true;
    try {
      const watcher = watch(absDir, { recursive }, (event, filename) => {
        this.handleEvent(absDir, recursive, event, typeof filename === "string" ? filename : null);
      });
      // An FSWatcher with no error listener throws on failure, which would take the
      // server down; drop the handle instead and record the lost coverage.
      watcher.on("error", () => this.dropWatcher(absDir));
      this.attached.set(absDir, { watcher, covers, recursive });
      this.everAttached.add(absDir);
      this.covered += covers;
      return true;
    } catch {
      // Raced with a delete, not permitted, or the kernel watch limit is exhausted.
      this.truncated = true;
      return false;
    }
  }

  private dropWatcher(absDir: string): void {
    const entry = this.attached.get(absDir);
    if (!entry) return;
    try { entry.watcher.close(); } catch { /* already gone */ }
    this.attached.delete(absDir);
    this.covered -= entry.covers;
    this.truncated = true;
  }

  private handleEvent(
    watchDir: string,
    recursive: boolean,
    event: string,
    filename: string | null,
  ): void {
    if (this.closed || !filename) return;

    const abs = join(watchDir, filename);
    const relPath = relative(this.options.root, abs).replaceAll("\\", "/");
    if (!relPath || relPath === ".." || relPath.startsWith("../")) return;

    if (hasIgnoredDirSegment(relPath)) {
      // An ignored directory appeared inside a subtree we cover recursively, so the
      // runtime is now watching it as well. Rebuild that subtree to prune it again.
      if (recursive) this.scheduleRebuild(watchDir);
      return;
    }

    // Directory structure only changes on "rename" (create/delete/move); "change" is
    // content, so this keeps a stat() off the hot path of ordinary file saves.
    // Recursive watchers track their own new directories — non-recursive ones need help.
    if (!recursive && event === "rename") this.syncChildDir(abs);

    if (!isIgnoredPath(relPath)) this.options.onChange(relPath);
  }

  /**
   * Report an absolute path the poller noticed, applying the same root-scoping
   * and ignore rules a watcher event goes through.
   */
  private reportAbs(abs: string): void {
    if (this.closed) return;
    const relPath = relative(this.options.root, abs).replaceAll("\\", "/");
    if (!relPath || relPath === ".." || relPath.startsWith("../")) return;
    if (!isIgnoredPath(relPath)) this.options.onChange(relPath);
  }

  /** Extend or release coverage after a directory under a non-recursive watch appeared or vanished. */
  private syncChildDir(abs: string): void {
    let isDir = false;
    try {
      // lstat, not stat: `scan` skips symlinks, so following one here would cover a
      // subtree twice (or loop) once it appeared after start.
      isDir = lstatSync(abs).isDirectory();
    } catch { /* gone */ }

    if (!isDir) {
      if (this.attached.has(abs)) this.closeSubtree(abs);
      return;
    }
    // A directory we already watch just got created again: the old handle is attached
    // to the deleted inode, so replace the whole subtree rather than trusting it.
    if (this.attached.has(abs)) this.scheduleRebuild(abs);
    else void this.cover(abs);
  }

  private scheduleRebuild(absDir: string): void {
    if (this.rebuildTimers.has(absDir)) return;
    this.rebuildTimers.set(absDir, setTimeout(() => {
      this.rebuildTimers.delete(absDir);
      if (this.closed) return;
      this.closeSubtree(absDir);
      void this.cover(absDir);
    }, REBUILD_DEBOUNCE_MS));
  }

  private closeSubtree(absPath: string): void {
    this.poller?.remove(absPath);
    const prefix = absPath + sep;
    for (const [dir, entry] of this.attached) {
      if (dir !== absPath && !dir.startsWith(prefix)) continue;
      try { entry.watcher.close(); } catch { /* already gone */ }
      this.attached.delete(dir);
      this.covered -= entry.covers;
    }
  }
}
