import { lstatSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import { hasIgnoredDirSegment, isIgnoredDirName, isIgnoredPath } from "./ignore-rules.ts";

/**
 * Watches a project directory while keeping the number of watched directories
 * near the number of *interesting* ones.
 *
 * `fs.watch(root, { recursive: true })` is a single call, but on Linux the runtime
 * expands it into one inotify watch per subdirectory — dependency trees included.
 * Filtering those events on arrival (what this service used to do) still pays the
 * full cost, which is how a handful of projects reached ~360k watches and pushed
 * the machine against `fs.inotify.max_user_watches`.
 *
 * So coverage is chosen up front: a subtree with no ignored directory anywhere
 * inside it gets one native recursive watch (cheap, and the runtime tracks new
 * directories for us); any subtree that contains an ignored directory gets a
 * non-recursive watch plus per-child recursion, so the ignored branch is never
 * handed to the runtime. That keeps the watcher count small — which also keeps
 * `fs.inotify.max_user_instances` out of play — while pruning ~92% of the
 * directories in a typical repo.
 */

/** Coalesce a burst of directory churn into a single subtree rebuild. */
const REBUILD_DEBOUNCE_MS = 500;

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
  /** Coverage was cut short by `maxDirs`, so part of the tree is unwatched. */
  truncated: boolean;
}

export class WatchTree {
  private readonly attached = new Map<string, AttachedWatcher>();
  private readonly rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private covered = 0;
  private truncated = false;
  private closed = false;

  constructor(private readonly options: WatchTreeOptions) {}

  start(): void {
    this.cover(this.options.root);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.rebuildTimers.values()) clearTimeout(timer);
    this.rebuildTimers.clear();
    for (const { watcher } of this.attached.values()) {
      try { watcher.close(); } catch { /* already gone */ }
    }
    this.attached.clear();
    this.covered = 0;
    this.truncated = false;
  }

  stats(): WatchTreeStats {
    return { dirs: this.covered, watchers: this.attached.size, truncated: this.truncated };
  }

  /** Walk `absDir` and attach the fewest watchers that cover it without touching ignored dirs. */
  private cover(absDir: string): void {
    const budget = { left: this.options.maxDirs - this.covered };
    if (budget.left <= 0) {
      this.truncated = true;
      return;
    }
    this.attach(this.scan(absDir, budget));
  }

  private scan(absDir: string, budget: { left: number }): ScanNode {
    const node: ScanNode = { path: absDir, dirs: [], hasIgnored: false, size: 1 };
    budget.left--;

    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return node; // unreadable or raced with a delete
    }

    for (const entry of entries) {
      // isDirectory() is false for symlinks, which keeps link cycles and
      // duplicate coverage (pnpm stores, workspace links) out of the walk.
      if (!entry.isDirectory()) continue;
      if (isIgnoredDirName(entry.name)) {
        node.hasIgnored = true;
        continue;
      }
      if (budget.left <= 0) {
        // Unscanned directories remain: mark the node so no ancestor covers them
        // recursively, since we cannot know what they hold.
        node.hasIgnored = true;
        this.truncated = true;
        break;
      }
      const child = this.scan(join(absDir, entry.name), budget);
      node.dirs.push(child);
      node.size += child.size;
      if (child.hasIgnored) node.hasIgnored = true;
    }

    return node;
  }

  private attach(node: ScanNode): void {
    const fitsWholeSubtree = this.covered + node.size <= this.options.maxDirs;
    // One recursive watch for a subtree the runtime can safely expand on its own.
    if (!node.hasIgnored && fitsWholeSubtree && this.addWatcher(node.path, true, node.size)) return;

    // Otherwise cover this directory alone and recurse — a failed recursive attach
    // falls through to here too, so one unwatchable directory cannot silently drop
    // everything beneath it.
    if (this.covered + 1 > this.options.maxDirs) {
      this.truncated = true;
      return;
    }
    this.addWatcher(node.path, false, 1);
    for (const child of node.dirs) this.attach(child);
  }

  private addWatcher(absDir: string, recursive: boolean, covers: number): boolean {
    if (this.attached.has(absDir)) return true;
    try {
      const watcher = watch(absDir, { recursive }, (event, filename) => {
        this.handleEvent(absDir, recursive, event, typeof filename === "string" ? filename : null);
      });
      // An FSWatcher with no error listener throws on failure, which would take the
      // server down; drop the handle instead and record the lost coverage.
      watcher.on("error", () => this.dropWatcher(absDir));
      this.attached.set(absDir, { watcher, covers, recursive });
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
    else this.cover(abs);
  }

  private scheduleRebuild(absDir: string): void {
    if (this.rebuildTimers.has(absDir)) return;
    this.rebuildTimers.set(absDir, setTimeout(() => {
      this.rebuildTimers.delete(absDir);
      if (this.closed) return;
      this.closeSubtree(absDir);
      this.cover(absDir);
    }, REBUILD_DEBOUNCE_MS));
  }

  private closeSubtree(absPath: string): void {
    const prefix = absPath + sep;
    for (const [dir, entry] of this.attached) {
      if (dir !== absPath && !dir.startsWith(prefix)) continue;
      try { entry.watcher.close(); } catch { /* already gone */ }
      this.attached.delete(dir);
      this.covered -= entry.covers;
    }
  }
}
