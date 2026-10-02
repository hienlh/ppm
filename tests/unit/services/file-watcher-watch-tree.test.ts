import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchTree } from "../../../src/services/file-watcher/watch-tree.ts";
import { onInotifyOverflow } from "../../../src/services/file-watcher/linux-inotify.ts";
import { hasIgnoredDirSegment, isIgnoredPath } from "../../../src/services/file-watcher/ignore-rules.ts";
import { onFileChange, startWatching, stopWatching } from "../../../src/services/file-watcher.service.ts";

const trees: WatchTree[] = [];
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ppm-watch-"));
  roots.push(root);
  return root;
}

/**
 * Linux watches through raw inotify where it can and falls back to `fs.watch`, so both run
 * there; elsewhere `fs.watch` is the only backend. `undefined` means "whatever this host picks".
 */
const BACKENDS: { name: string; inotify: boolean | undefined }[] = process.platform === "linux"
  ? [{ name: "inotify", inotify: true }, { name: "fs.watch", inotify: false }]
  : [{ name: "fs.watch", inotify: undefined }];
let backend: boolean | undefined;

async function open(root: string, maxDirs = 1000): Promise<{ tree: WatchTree; changes: string[] }> {
  const changes: string[] = [];
  const tree = new WatchTree({ root, maxDirs, onChange: (p) => changes.push(p), inotify: backend });
  trees.push(tree);
  // Covering hands the event loop back as it walks, so coverage is only
  // complete once this resolves — every assertion on `stats()` needs it.
  await tree.start();
  return { tree, changes };
}

/** fs.watch delivery is asynchronous and platform-dependent, so poll instead of sleeping once. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mirrors NATIVE_RECURSIVE in watch-tree.ts: a clean subtree costs one handle there. */
const NATIVE_RECURSIVE = process.platform === "win32" || process.platform === "darwin";

afterEach(() => {
  for (const tree of trees) tree.close();
  trees.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("ignore rules", () => {
  it("matches ignored directories at any depth", () => {
    expect(isIgnoredPath("node_modules/foo/index.js")).toBe(true);
    expect(isIgnoredPath("packages/app/node_modules/foo")).toBe(true);
    expect(isIgnoredPath("src/.git/HEAD")).toBe(true);
    expect(isIgnoredPath("src/app/main.ts")).toBe(false);
  });

  it("separates ignored directories from merely noisy files", () => {
    // Only a directory match forces a coverage rebuild, so the two must not be conflated.
    expect(isIgnoredPath("bun.lock")).toBe(true);
    expect(hasIgnoredDirSegment("bun.lock")).toBe(false);
    expect(hasIgnoredDirSegment("src/node_modules/x")).toBe(true);
  });
});

for (const { name, inotify } of BACKENDS) {
  describe(`WatchTree coverage (${name})`, () => {
    beforeEach(() => { backend = inotify; });
    it("never covers ignored directories", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "src", "components"), { recursive: true });
      mkdirSync(join(root, "docs"), { recursive: true });
      for (let i = 0; i < 40; i++) {
        mkdirSync(join(root, "node_modules", `pkg-${i}`, "dist"), { recursive: true });
      }
      mkdirSync(join(root, ".git", "objects"), { recursive: true });

      const { tree } = await open(root);
      // root + src + src/components + docs — the 82 dirs under node_modules/.git are pruned.
      expect(tree.stats().dirs).toBe(4);
      expect(tree.stats().truncated).toBe(false);
    });

    it("covers a clean subtree with one handle, or one per directory on Linux", async () => {
      const root = makeRoot();
      for (let i = 0; i < 5; i++) {
        mkdirSync(join(root, "src", `mod-${i}`, "nested"), { recursive: true });
      }

      // root + src + 5 mods + 5 nested, covered either way. Where the runtime's recursive
      // watch is kernel-side the whole clean tree costs one handle; on Linux it is emulated
      // per directory, which buys nothing and misses directories created later, so coverage
      // is attached here and the handle count tracks the directory count.
      const { tree } = await open(root);
      expect(tree.stats()).toEqual({
        dirs: 12,
        watchers: NATIVE_RECURSIVE ? 1 : 12,
        truncated: false,
        polledDirs: 0,
      });
    });

    it("leaves an ignored directory and everything under it unwatched", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "src", "deep", "deeper"), { recursive: true });
      mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });

      // root + src + deep + deeper: node_modules and its package are never covered. The
      // ignored entry forces root itself to be watched alone on every platform; the clean
      // src subtree below it can still be one recursive handle where that is native.
      const { tree } = await open(root);
      expect(tree.stats()).toEqual({
        dirs: 4,
        watchers: NATIVE_RECURSIVE ? 2 : 4,
        truncated: false,
        polledDirs: 0,
      });
    });

    it("reports nothing from a store reached through a symlinked node_modules", async () => {
      const root = makeRoot();
      const store = makeRoot();
      mkdirSync(join(store, "pkg", "lib"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      // "junction" is ignored off Windows and avoids needing the symlink privilege on it.
      symlinkSync(store, join(root, "node_modules"), "junction");

      // A pnpm workspace links node_modules elsewhere, and the store must not be watched:
      // on Bun/Linux every watched file costs an open descriptor, and a store reached this
      // way is what exhausted the process.
      const { tree, changes } = await open(root);
      expect(tree.stats().dirs).toBe(2); // root + src
      // Two handles is the assertion that fails against a build without the symlink mark:
      // there the root looks clean and takes a single recursive watch. `dirs` and the
      // silence below are both the same on either build — on Linux because the events are
      // dropped on arrival instead, on Windows because the subtree watch never follows the
      // reparse point. Only the shape distinguishes them, on both platforms.
      expect(tree.stats().watchers).toBe(2); // non-recursive root + src

      writeFileSync(join(store, "pkg", "lib", "index.js"), "module.exports = 1;");
      writeFileSync(join(root, "src", "app.ts"), "export const a = 1;");

      // The sibling write is the control: once it lands, delivery has happened and a
      // report from the store would have arrived with it.
      expect(await waitFor(() => changes.some((p) => p.endsWith("src/app.ts")))).toBe(true);
      expect(changes.some((p) => p.includes("node_modules") || p.includes("pkg"))).toBe(false);
    });

    it("reports a file created in a directory that appeared after the watch started", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "src"), { recursive: true });
      const { tree, changes } = await open(root);

      mkdirSync(join(root, "src", "feature"));
      // On Linux the new directory needs its own handle before the file lands, so wait for
      // the coverage itself rather than a fixed delay. A native recursive watch covers it
      // without ever calling syncChildDir, so `dirs` stays 2 there and waiting for 3 would
      // just time out — the file arriving below is the assertion that holds on both.
      if (!NATIVE_RECURSIVE) expect(await waitFor(() => tree.stats().dirs === 3)).toBe(true);

      writeFileSync(join(root, "src", "feature", "index.ts"), "export const a = 1;");
      expect(await waitFor(() => changes.some((p) => p.endsWith("feature/index.ts")))).toBe(true);
    });

    it("stops at the directory budget and reports truncation", async () => {
      const root = makeRoot();
      for (let i = 0; i < 30; i++) mkdirSync(join(root, `dir-${i}`), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });

      const { tree } = await open(root, 5);
      expect(tree.stats().dirs).toBeLessThanOrEqual(5);
      expect(tree.stats().truncated).toBe(true);
    });

    it("releases every watcher on close", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });

      const { tree } = await open(root);
      expect(tree.stats().watchers).toBeGreaterThan(0);
      tree.close();
      expect(tree.stats()).toEqual({ dirs: 0, watchers: 0, truncated: false, polledDirs: 0 });
    });
  });

  describe(`WatchTree events (${name})`, () => {
    beforeEach(() => { backend = inotify; });
    it("reports changes to watched files as root-relative posix paths", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      const { changes } = await open(root);

      writeFileSync(join(root, "src", "main.ts"), "export const a = 1;");
      expect(await waitFor(() => changes.includes("src/main.ts"))).toBe(true);
    });

    it("stays silent for changes inside an ignored directory", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
      const { changes } = await open(root);

      writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;");
      // Prove the watcher is alive first, otherwise silence would prove nothing.
      writeFileSync(join(root, "src", "main.ts"), "export const a = 1;");
      expect(await waitFor(() => changes.includes("src/main.ts"))).toBe(true);
      expect(changes.some((p) => p.includes("node_modules"))).toBe(false);
    });

    it("extends coverage to a directory created after start", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      const { tree, changes } = await open(root);
      const before = tree.stats().dirs;

      mkdirSync(join(root, "extra", "inner"), { recursive: true });
      expect(await waitFor(() => tree.stats().dirs > before)).toBe(true);

      writeFileSync(join(root, "extra", "inner", "late.ts"), "export const b = 2;");
      expect(await waitFor(() => changes.some((p) => p.endsWith("late.ts")))).toBe(true);
    });

    it("releases coverage when a watched directory is deleted", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "gone", "inner"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      const { tree } = await open(root);
      const before = tree.stats().dirs;

      rmSync(join(root, "gone"), { recursive: true, force: true });
      expect(await waitFor(() => tree.stats().dirs < before)).toBe(true);
    });

    // With Bun's fs.watch on Linux the re-attached watcher is silent forever (the runtime
    // keys fs.watch by path string and reuses the dead inotify watch), so that backend
    // passes only because RecreatedDirPoller stands in. Raw inotify watches the new inode
    // directly, and Windows and macOS re-watch correctly; neither reaches the poller.
    it("re-attaches after a watched directory is deleted and recreated", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "swap"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      const { changes } = await open(root);

      rmSync(join(root, "swap"), { recursive: true, force: true });
      await settle(300);
      mkdirSync(join(root, "swap"), { recursive: true });
      await settle(1500); // rebuild debounce

      writeFileSync(join(root, "swap", "fresh.ts"), "export const c = 3;");
      expect(await waitFor(() => changes.some((p) => p.endsWith("fresh.ts")))).toBe(true);
    });

    it("prunes an ignored directory that appears inside a recursive subtree", async () => {
      const root = makeRoot();
      mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      const { tree, changes } = await open(root);
      const before = tree.stats().dirs;

      for (let i = 0; i < 20; i++) {
        mkdirSync(join(root, "packages", "app", "node_modules", `pkg-${i}`), { recursive: true });
      }
      await settle(1500); // rebuild debounce

      expect(tree.stats().dirs).toBe(before);
      expect(changes.some((p) => p.includes("node_modules"))).toBe(false);
    });
  });
}

describe("file watcher service", () => {
  it("shares one tree per project, filters ignored paths and stops on the last release", async () => {
    const seen: string[] = [];
    onFileChange((project, path) => seen.push(`${project}:${path}`));

    const root = makeRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });

    await startWatching("proj", root);
    await startWatching("proj", root); // second client shares the same tree

    writeFileSync(join(root, "src", "a.ts"), "1");
    expect(await waitFor(() => seen.includes("proj:src/a.ts"))).toBe(true);

    writeFileSync(join(root, "node_modules", "pkg", "b.js"), "1");
    await settle(1200);
    expect(seen.some((s) => s.includes("node_modules"))).toBe(false);

    stopWatching("proj"); // one client left, still watching
    writeFileSync(join(root, "src", "c.ts"), "1");
    expect(await waitFor(() => seen.includes("proj:src/c.ts"))).toBe(true);

    stopWatching("proj"); // last client, released
    const afterStop = seen.length;
    writeFileSync(join(root, "src", "d.ts"), "1");
    await settle(1200);
    expect(seen.length).toBe(afterStop);
  });
});

for (const { name, inotify } of BACKENDS) {
  describe(`a directory created while the walk is running (${name})`, () => {
    beforeEach(() => { backend = inotify; });
    it("is watched by the time start() resolves", async () => {
      const root = makeRoot();
      // `node_modules` forces the per-directory branch on every platform: with a clean tree,
      // Windows and macOS would take one recursive handle over the root and cover anything that
      // appears under it for free, so the window below would only exist on Linux.
      mkdirSync(join(root, "node_modules"));
      // Enough directories that the walk reaches a real `setImmediate` yield (it yields every 64)
      // and suspends there, which is the whole point: before the walk yielded at all, the gap
      // between reading the root and attaching its watcher was too small to lose anything in.
      for (let i = 0; i < 200; i++) mkdirSync(join(root, `d${i}`));

      const changes: string[] = [];
      const tree = new WatchTree({ root, maxDirs: 1000, onChange: (p) => changes.push(p), inotify });
      trees.push(tree);

      const started = tree.start();
      // A macrotask, so it runs during that yield: the root's entries have been read into the
      // snapshot and nothing has a watcher yet. `late` is therefore in neither — and with no
      // watcher on its parent, no later event announces it.
      const late = join(root, "late");
      await new Promise<void>((resolve) => setImmediate(() => { mkdirSync(late); resolve(); }));
      await started;

      writeFileSync(join(late, "f.txt"), "hi");
      expect(await waitFor(() => changes.some((c) => c.startsWith("late/")))).toBe(true);
    });
  });

  describe(`covering a tree does not hold the event loop (${name})`, () => {
    beforeEach(() => { backend = inotify; });
    it("hands the thread back while it walks and attaches", async () => {
      // The measured symptom this exists for: starting a 12,000-directory project
      // held the loop for 2.95s, and the lag monitor billed it to us at ratio 1.38
      // across two independent restarts. Nothing else in PPM could run for that
      // whole time — not a request, not a WebSocket frame.
      const root = makeRoot();
      for (let i = 0; i < 1200; i++) mkdirSync(join(root, `d${i}`));

      let fires = 0;
      const probe = setInterval(() => { fires++; }, 1);
      try {
        // Prove the probe is alive before the measurement, or "0 fires during"
        // means nothing.
        await new Promise((r) => setTimeout(r, 20));
        const before = fires;
        expect(before).toBeGreaterThan(0);

        const tree = new WatchTree({ root, maxDirs: 2000, onChange: () => {}, inotify });
        trees.push(tree);
        await tree.start();

        expect(fires - before).toBeGreaterThan(0);
        expect(tree.stats().dirs).toBeGreaterThan(1000); // it really did the work
      } finally {
        clearInterval(probe);
      }
    });
  });
}

describe.skipIf(process.platform !== "linux")("raw inotify on Linux", () => {
  const openInotify = async (root: string) => {
    const changes: string[] = [];
    const tree = new WatchTree({ root, maxDirs: 1000, onChange: (p) => changes.push(p), inotify: true });
    trees.push(tree);
    await tree.start();
    return { tree, changes };
  };
  const openDescriptors = () => readdirSync("/proc/self/fd").length;

  it("holds one descriptor for the whole process, however many files are watched", async () => {
    // Bun's fs.watch opens one per file in each watched directory: 76,565 on the live server,
    // which made every spawn stop the event loop ~5.6 ms.
    const root = makeRoot();
    for (let d = 0; d < 3; d++) {
      mkdirSync(join(root, `dir-${d}`));
      for (let f = 0; f < 300; f++) writeFileSync(join(root, `dir-${d}`, `file-${f}.txt`), "");
    }
    const before = openDescriptors();
    const { tree, changes } = await openInotify(root);
    expect(tree.stats().dirs).toBe(4);
    expect(openDescriptors() - before).toBeLessThanOrEqual(1); // the shared inotify instance, if not yet open

    writeFileSync(join(root, "dir-2", "file-7.txt"), "changed");
    expect(await waitFor(() => changes.includes("dir-2/file-7.txt"))).toBe(true);
  });

  it("keeps a directory two trees share watched until the last of them closes", async () => {
    // A project nested inside another: the kernel hands both the same watch descriptor.
    const root = makeRoot();
    mkdirSync(join(root, "inner", "src"), { recursive: true });
    const outer = await openInotify(root);
    const inner = await openInotify(join(root, "inner"));

    writeFileSync(join(root, "inner", "src", "a.ts"), "1");
    expect(await waitFor(() => outer.changes.includes("inner/src/a.ts") && inner.changes.includes("src/a.ts"))).toBe(true);

    inner.tree.close();
    writeFileSync(join(root, "inner", "src", "b.ts"), "1");
    expect(await waitFor(() => outer.changes.includes("inner/src/b.ts"))).toBe(true);
    expect(inner.changes).not.toContain("src/b.ts");
  });

  it("watches a deleted and recreated directory again without falling back to polling", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "swap"));
    const { tree, changes } = await openInotify(root);

    rmSync(join(root, "swap"), { recursive: true, force: true });
    await settle(300);
    mkdirSync(join(root, "swap"));
    await settle(1500); // rebuild debounce

    writeFileSync(join(root, "swap", "fresh.ts"), "1");
    expect(await waitFor(() => changes.includes("swap/fresh.ts"))).toBe(true);
    expect(tree.stats().polledDirs).toBe(0);
  });

  // A host tuned far past the default 16384 would take too long to fill.
  const limit = process.platform === "linux" ? Number(readFileSync("/proc/sys/fs/inotify/max_queued_events", "utf8")) : 0;
  it.skipIf(!(limit > 0 && limit <= 100_000))("rebuilds its coverage when the kernel's event queue overflows", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "flood"));
    const { tree, changes } = await openInotify(root);
    expect(tree.stats().dirs).toBe(2);

    // All synchronous, so nothing drains the queue: it fills, then `late` is created with its
    // event already lost. Only a rebuild can find it now.
    for (let i = 0; i < limit + 2000; i++) writeFileSync(join(root, "flood", `f${i}`), "");
    mkdirSync(join(root, "late"));

    expect(await waitFor(() => tree.stats().dirs === 3, 10_000)).toBe(true);
    writeFileSync(join(root, "late", "after.ts"), "1");
    expect(await waitFor(() => changes.includes("late/after.ts"))).toBe(true);
  }, 30_000);

  /** More directories than the queue holds events, 100 to a parent. */
  const makeDirsPastQueue = (root: string) => {
    for (let i = 0; i * 100 < limit + 1000; i++) {
      for (let j = 0; j < 100; j++) mkdirSync(join(root, `d${i}`, `e${j}`), { recursive: true });
    }
  };
  const stops: (() => void)[] = [];
  const countOverflows = () => {
    let count = 0;
    stops.push(onInotifyOverflow(() => { count++; }));
    return () => count;
  };
  afterEach(() => {
    for (const stop of stops) stop();
    stops.length = 0;
  });

  it.skipIf(!(limit > 0 && limit <= 100_000))("takes down a tree bigger than the event queue without overflowing it", async () => {
    // Every inotify_rm_watch queues an IN_IGNORED, and a tree takes all of its watches down in
    // one synchronous loop.
    const big = makeRoot();
    makeDirsPastQueue(big);
    const bigTree = new WatchTree({ root: big, maxDirs: limit * 2, onChange: () => {}, inotify: true });
    trees.push(bigTree);
    await bigTree.start();
    expect(bigTree.stats().dirs).toBeGreaterThan(limit);
    // The queue is read only while something is watched, so without this the overflow would
    // never be seen and the test could not fail.
    await openInotify(makeRoot());
    const overflows = countOverflows();

    bigTree.close();
    await settle(300);

    expect(overflows()).toBe(0);
  }, 60_000);

  it.skipIf(!(limit > 0 && limit <= 100_000))("answers an overflow with one rebuild, not one that overflows the queue again", async () => {
    // The rebuild takes the tree's watches down before covering it again, so with more
    // directories than the queue holds, each rebuild overflowed it and asked for the next:
    // 33 overflows in 20 s on 20,000 directories, for as long as the tree stayed open.
    const root = makeRoot();
    makeDirsPastQueue(root);
    mkdirSync(join(root, "flood"));
    const tree = new WatchTree({ root, maxDirs: limit * 2, onChange: () => {}, inotify: true });
    trees.push(tree);
    await tree.start();
    const covered = tree.stats().dirs;
    const overflows = countOverflows();

    for (let i = 0; i < limit + 2000; i++) writeFileSync(join(root, "flood", `f${i}`), "");
    expect(await waitFor(() => overflows() >= 1, 10_000)).toBe(true);
    await settle(1500); // the rebuild debounce, then its walk
    expect(await waitFor(() => tree.stats().dirs === covered, 20_000)).toBe(true);
    await settle(1500); // long enough for a second rebuild's overflow to be read

    expect(overflows()).toBe(1);
    expect(tree.stats().dirs).toBe(covered);
  }, 60_000);
});
