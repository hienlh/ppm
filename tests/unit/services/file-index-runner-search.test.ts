/**
 * A walk runs on a worker that is ended once it answers, and a list searched on the server lives
 * on a search worker of its own, one per project, seeded with the build the caller serves. What
 * the runner has to get right is which list that is, and that no worker outlives its job: a
 * long-lived walking worker kept 1-3 GB of a 1.17M-entry walk for the life of the server.
 */
import "../../test-setup.ts";
import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileIndexRunner } from "../../../src/services/file-index/file-index-runner.ts";
import { buildEntries, decodeCompact, encodeCompact, INDEX_SAMPLE_ENTRIES, walkIndex } from "../../../src/services/file-index/index-walk.ts";
import { REMOTE_FILE_SEARCH_FROM_ENTRIES } from "../../../src/shared/file-index-limits.ts";
import type { FileEntry } from "../../../src/types/project.ts";

const filter = { exclude: [], useIgnoreFiles: false };
const noWorker = new URL("./no-such-worker.ts", import.meta.url).href;
const cleanups: Array<() => void> = [];

// Long, because the first test's tree is 50,000 files and removing it is part of the cleanup.
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
}, 120_000);

function tree(dirs: number, filesPerDir: number): string {
  const root = mkdtempSync(join(tmpdir(), "ppm-index-search-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (let d = 0; d < dirs; d++) {
    const dir = join(root, `pkg${d}`);
    mkdirSync(dir);
    for (let f = 0; f < filesPerDir; f++) writeFileSync(join(dir, `f${f}.ts`), "");
  }
  return root;
}

function runner(spec?: string): FileIndexRunner {
  const r = spec ? new FileIndexRunner(spec) : new FileIndexRunner();
  cleanups.push(() => r.close());
  return r;
}

/** The projects whose lists are handed to a worker from here on. */
function seeds(): () => string[] {
  const posted = spyOn(Worker.prototype, "postMessage");
  cleanups.push(() => posted.mockRestore());
  return () => posted.mock.calls
    .map(([message]) => message as { type?: string; rootPath?: string })
    .filter((m) => m.type === "seed")
    .map((m) => m.rootPath!);
}

const paths = (files: FileEntry[]) => files.map((f) => f.path);

describe("searching the file index on the worker", () => {
  it("searches a long list where it walked it, without being handed it back", async () => {
    // Past the real threshold, the one the route and the browser use, so it is 50,000 files on
    // disk: 0.1 s on Linux's tmpfs, and far longer where every file create is scanned (NTFS
    // under Defender) — hence the timeouts here and on the cleanup, rather than a smaller tree.
    const perDir = 50;
    const root = tree(Math.ceil(REMOTE_FILE_SEARCH_FROM_ENTRIES / perDir), perDir);
    const r = runner();
    const build = await r.run(root, filter);
    expect(build.count).toBeGreaterThanOrEqual(REMOTE_FILE_SEARCH_FROM_ENTRIES);
    // Never sent, so neither serialised whole nor gzipped: the list travels compact.
    expect(build.large).toBe(true);
    expect(build.gzip.length).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(build.json)).data).toHaveLength(INDEX_SAMPLE_ENTRIES);
    expect(buildEntries(build)).toHaveLength(build.count);
    // The worker that walked is gone.
    expect(r.workerCount).toBe(0);

    const seeded = seeds();
    const files = await r.search(root, build, "pkg7/f4", "file", 3);

    expect(paths(files)[0]).toBe("pkg7/f4.ts");
    expect(files).toHaveLength(3);
    expect(seeded()).toHaveLength(1);
    expect(r.workerCount).toBe(1);
  }, 120_000);

  it("seeds a search worker once per build, and replaces it for a newer build", async () => {
    const root = tree(3, 2);
    const r = runner();
    const first = await r.run(root, filter);
    const seeded = seeds();

    expect(paths(await r.search(root, first, "f1", "file", 10)).sort()).toEqual(["pkg0/f1.ts", "pkg1/f1.ts", "pkg2/f1.ts"]);
    await r.search(root, first, "f0", "file", 10);
    expect(seeded()).toHaveLength(1);
    writeFileSync(join(root, "pkg0", "added.ts"), "");
    const second = await r.run(root, filter);
    expect(paths(await r.search(root, second, "added", "file", 10))).toEqual(["pkg0/added.ts"]);
    expect(seeded()).toHaveLength(2);
    // One project, one search worker: the first build's was ended.
    expect(r.workerCount).toBe(1);
  });

  it("searches the list the caller serves, not a later walk the caller did not take", async () => {
    const root = tree(3, 2);
    const r = runner();
    const served = await r.run(root, filter);
    await r.search(root, served, "f1", "file", 10); // from here the worker keeps this project's walks
    writeFileSync(join(root, "pkg0", "added.ts"), "");
    // A walk begun under filters that have changed since, say: the caller drops it.
    const dropped = await r.run(root, filter);

    expect(await r.search(root, served, "added", "file", 10)).toEqual([]);
    expect(paths(await r.search(root, dropped, "added", "file", 10))).toEqual(["pkg0/added.ts"]);
  });

  it("searches directories too when asked", async () => {
    const root = tree(3, 2);
    const r = runner();
    const build = await r.run(root, filter);
    expect(paths(await r.search(root, build, "pkg1", "all", 1))).toEqual(["pkg1"]);
    expect(paths(await r.search(root, build, "pkg1", "file", 1))).not.toEqual(["pkg1"]);
  });

  it("searches on this thread when the worker cannot be started", async () => {
    const root = tree(3, 2);
    const r = runner(noWorker);
    const build = await r.run(root, filter);

    expect(r.onMainThread).toBe(true);
    expect(paths(await r.search(root, build, "pkg2/f1", "file", 10))).toEqual(["pkg2/f1.ts"]);
    writeFileSync(join(root, "pkg0", "added.ts"), "");
    const next = await r.run(root, filter);
    expect(paths(await r.search(root, next, "added", "file", 10))).toEqual(["pkg0/added.ts"]);
  });

  it("answers a search the worker died holding", async () => {
    const root = tree(3, 2);
    const build = await runner(noWorker).run(root, filter);
    const r = runner(new URL("../../fixtures/file-index-worker-that-dies.ts", import.meta.url).href);

    expect(paths(await r.search(root, build, "pkg1/f0", "file", 10))).toEqual(["pkg1/f0.ts"]);
    expect(r.onMainThread).toBe(true);
  });

  it("answers a walk the worker died running, on this thread", async () => {
    const root = tree(3, 2);
    const r = runner(new URL("../../fixtures/file-index-worker-that-dies.ts", import.meta.url).href);
    const build = await r.run(root, filter);

    expect(build.count).toBe(3 + 3 * 2);
    expect(r.onMainThread).toBe(true);
    expect(r.workerCount).toBe(0);
  });

  it("ends every walking worker, however many walks ran", async () => {
    const root = tree(3, 2);
    const r = runner();
    await Promise.all([r.run(root, filter), r.run(root, filter), r.run(root, filter)]);
    await r.run(root, filter);

    expect(r.onMainThread).toBe(false);
    expect(r.workerCount).toBe(0);
  });
});

describe("the walk's limits", () => {
  it("stops at the most entries it may list, and says so", async () => {
    const root = tree(10, 10);
    const capped = await walkIndex(root, filter, 256, 25);
    const whole = await walkIndex(root, filter, 256, 1_000);

    expect(capped.entries).toHaveLength(25);
    expect(capped.truncated).toBe(true);
    expect(whole.entries).toHaveLength(10 + 10 * 10);
    expect(whole.truncated).toBe(false);
    expect(capped.entries).toEqual(whole.entries.slice(0, 25));
  });

  it("keeps every path, kind and ignore flag through the compact encoding", () => {
    const entries: FileEntry[] = [
      { path: "src", name: "src", type: "directory" },
      { path: "src/a b.ts", name: "a b.ts", type: "file" },
      { path: "src/dist/out.js", name: "out.js", type: "file", isIgnored: true },
      { path: "Tiếng Việt/ghi chú.md", name: "ghi chú.md", type: "file" },
      { path: ".env", name: ".env", type: "file" },
    ];
    expect(decodeCompact(encodeCompact(entries))).toEqual(entries);
    expect(decodeCompact(encodeCompact([]))).toEqual([]);
  });
});
