import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchTree } from "../../../src/services/file-watcher/watch-tree.ts";
import { hasIgnoredDirSegment, isIgnoredPath } from "../../../src/services/file-watcher/ignore-rules.ts";
import { onFileChange, startWatching, stopWatching } from "../../../src/services/file-watcher.service.ts";

const trees: WatchTree[] = [];
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ppm-watch-"));
  roots.push(root);
  return root;
}

function open(root: string, maxDirs = 1000): { tree: WatchTree; changes: string[] } {
  const changes: string[] = [];
  const tree = new WatchTree({ root, maxDirs, onChange: (p) => changes.push(p) });
  trees.push(tree);
  tree.start();
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

describe("WatchTree coverage", () => {
  it("never covers ignored directories", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src", "components"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(root, "node_modules", `pkg-${i}`, "dist"), { recursive: true });
    }
    mkdirSync(join(root, ".git", "objects"), { recursive: true });

    const { tree } = open(root);
    // root + src + src/components + docs — the 82 dirs under node_modules/.git are pruned.
    expect(tree.stats().dirs).toBe(4);
    expect(tree.stats().truncated).toBe(false);
  });

  it("covers a clean subtree with one handle, or one per directory on Linux", () => {
    const root = makeRoot();
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(root, "src", `mod-${i}`, "nested"), { recursive: true });
    }

    // root + src + 5 mods + 5 nested, covered either way. Where the runtime's recursive
    // watch is kernel-side the whole clean tree costs one handle; on Linux it is emulated
    // per directory, which buys nothing and misses directories created later, so coverage
    // is attached here and the handle count tracks the directory count.
    const { tree } = open(root);
    expect(tree.stats()).toEqual({
      dirs: 12,
      watchers: NATIVE_RECURSIVE ? 1 : 12,
      truncated: false,
      polledDirs: 0,
    });
  });

  it("leaves an ignored directory and everything under it unwatched", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src", "deep", "deeper"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });

    // root + src + deep + deeper: node_modules and its package are never covered. The
    // ignored entry forces root itself to be watched alone on every platform; the clean
    // src subtree below it can still be one recursive handle where that is native.
    const { tree } = open(root);
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
    const { tree, changes } = open(root);
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
    const { tree, changes } = open(root);

    mkdirSync(join(root, "src", "feature"));
    // On Linux the new directory needs its own handle before the file lands, so wait for
    // the coverage itself rather than a fixed delay. A native recursive watch covers it
    // without ever calling syncChildDir, so `dirs` stays 2 there and waiting for 3 would
    // just time out — the file arriving below is the assertion that holds on both.
    if (!NATIVE_RECURSIVE) expect(await waitFor(() => tree.stats().dirs === 3)).toBe(true);

    writeFileSync(join(root, "src", "feature", "index.ts"), "export const a = 1;");
    expect(await waitFor(() => changes.some((p) => p.endsWith("feature/index.ts")))).toBe(true);
  });

  it("stops at the directory budget and reports truncation", () => {
    const root = makeRoot();
    for (let i = 0; i < 30; i++) mkdirSync(join(root, `dir-${i}`), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });

    const { tree } = open(root, 5);
    expect(tree.stats().dirs).toBeLessThanOrEqual(5);
    expect(tree.stats().truncated).toBe(true);
  });

  it("releases every watcher on close", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });

    const { tree } = open(root);
    expect(tree.stats().watchers).toBeGreaterThan(0);
    tree.close();
    expect(tree.stats()).toEqual({ dirs: 0, watchers: 0, truncated: false, polledDirs: 0 });
  });
});

describe("WatchTree events", () => {
  it("reports changes to watched files as root-relative posix paths", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const { changes } = open(root);

    writeFileSync(join(root, "src", "main.ts"), "export const a = 1;");
    expect(await waitFor(() => changes.includes("src/main.ts"))).toBe(true);
  });

  it("stays silent for changes inside an ignored directory", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    const { changes } = open(root);

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
    const { tree, changes } = open(root);
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
    const { tree } = open(root);
    const before = tree.stats().dirs;

    rmSync(join(root, "gone"), { recursive: true, force: true });
    expect(await waitFor(() => tree.stats().dirs < before)).toBe(true);
  });

  // On Bun + Linux the re-attached watcher is silent forever (the runtime keys
  // fs.watch by path string and reuses the dead inotify watch), so this passes
  // there only because RecreatedDirPoller stands in. Windows and macOS re-watch
  // correctly and never reach the poller.
  it("re-attaches after a watched directory is deleted and recreated", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "swap"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const { changes } = open(root);

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
    const { tree, changes } = open(root);
    const before = tree.stats().dirs;

    for (let i = 0; i < 20; i++) {
      mkdirSync(join(root, "packages", "app", "node_modules", `pkg-${i}`), { recursive: true });
    }
    await settle(1500); // rebuild debounce

    expect(tree.stats().dirs).toBe(before);
    expect(changes.some((p) => p.includes("node_modules"))).toBe(false);
  });
});

describe("file watcher service", () => {
  it("shares one tree per project, filters ignored paths and stops on the last release", async () => {
    const seen: string[] = [];
    onFileChange((project, path) => seen.push(`${project}:${path}`));

    const root = makeRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });

    startWatching("proj", root);
    startWatching("proj", root); // second client shares the same tree

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
