import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("covers a clean subtree with a single recursive watcher", () => {
    const root = makeRoot();
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(root, "src", `mod-${i}`, "nested"), { recursive: true });
    }

    const { tree } = open(root);
    // root + src + 5 mods + 5 nested, all under one recursive watch on the root.
    expect(tree.stats()).toEqual({ dirs: 12, watchers: 1, truncated: false });
  });

  it("splits into per-directory watchers only where an ignored directory sits", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src", "deep", "deeper"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });

    const { tree } = open(root);
    // root must be non-recursive (it holds node_modules); src is clean so it takes one recursive watch.
    expect(tree.stats()).toEqual({ dirs: 4, watchers: 2, truncated: false });
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
    expect(tree.stats()).toEqual({ dirs: 0, watchers: 0, truncated: false });
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
