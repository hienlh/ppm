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
import { FileIndexRunner, parseWalkOutput, WalkError, type FileIndexRunnerOptions } from "../../../src/services/file-index/file-index-runner.ts";
import { buildEntries, decodeCompact, encodeCompact, INDEX_SAMPLE_ENTRIES, walkIndex } from "../../../src/services/file-index/index-walk.ts";
import { REMOTE_FILE_SEARCH_FROM_ENTRIES } from "../../../src/shared/file-index-limits.ts";
import type { FileEntry } from "../../../src/types/project.ts";

const filter = { exclude: [], useIgnoreFiles: false };
const noWalkProcess = ["ppm-test-no-such-walk-binary"];
/** A walk process that dies without answering. */
const dyingWalkProcess = [process.execPath, "-e", "process.exit(3)"];
const noWorker = new URL("./no-such-worker.ts", import.meta.url).href;
const dyingWorker = new URL("../../fixtures/file-index-worker-that-dies.ts", import.meta.url).href;
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

function runner(options?: FileIndexRunnerOptions): FileIndexRunner {
  const r = new FileIndexRunner(options);
  cleanups.push(() => r.close());
  return r;
}

/** How many lists are handed to a search worker from here on. */
function seeds(): () => number {
  const posted = spyOn(Worker.prototype, "postMessage");
  cleanups.push(() => posted.mockRestore());
  return () => posted.mock.calls.filter(([message]) => (message as { type?: string }).type === "seed").length;
}

/** Every Worker started from here on. */
function workersStarted(): () => number {
  let started = 0;
  const RealWorker = globalThis.Worker;
  globalThis.Worker = class extends RealWorker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      started++;
    }
  } as typeof Worker;
  cleanups.push(() => { globalThis.Worker = RealWorker; });
  return () => started;
}

const paths = (files: FileEntry[]) => files.map((f) => f.path);

describe("walking in a process of its own, searching on a worker per project", () => {
  it("walks a long list in a process, and searches it on a worker it seeds compact", async () => {
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
    // Walked in a process that has exited, which reported its own peak.
    expect(r.onMainThread).toBe(false);
    expect(build.peakMB).toBeGreaterThan(0);
    expect(r.liveCount).toEqual({ walks: 0, searchers: 0 });

    const seeded = seeds();
    const files = await r.search(root, build, "pkg7/f4", "file", 3);

    expect(paths(files)[0]).toBe("pkg7/f4.ts");
    expect(files).toHaveLength(3);
    expect(seeded()).toBe(1);
    expect(r.liveCount).toEqual({ walks: 0, searchers: 1 });
  }, 120_000);

  it("keeps one search worker per project and re-seeds it, never starting another", async () => {
    // A terminated Bun Worker leaks ~29 MB on Windows, so a newer build must not cost a worker.
    const root = tree(3, 2);
    const r = runner();
    const started = workersStarted();
    const first = await r.run(root, filter);
    const seeded = seeds();

    expect(paths(await r.search(root, first, "f1", "file", 10)).sort()).toEqual(["pkg0/f1.ts", "pkg1/f1.ts", "pkg2/f1.ts"]);
    await r.search(root, first, "f0", "file", 10);
    expect(seeded()).toBe(1);
    writeFileSync(join(root, "pkg0", "added.ts"), "");
    const second = await r.run(root, filter);
    expect(paths(await r.search(root, second, "added", "file", 10))).toEqual(["pkg0/added.ts"]);
    expect(seeded()).toBe(2);
    expect(started()).toBe(1);
    expect(r.liveCount.searchers).toBe(1);
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

  it("walks and searches on this thread when neither a walk process nor a worker can start", async () => {
    const root = tree(3, 2);
    const r = runner({ walkCommand: noWalkProcess, searchSpec: noWorker });
    const build = await r.run(root, filter);

    expect(r.onMainThread).toBe(true);
    expect(build.peakMB).toBeUndefined();
    expect(paths(await r.search(root, build, "pkg2/f1", "file", 10))).toEqual(["pkg2/f1.ts"]);
    writeFileSync(join(root, "pkg0", "added.ts"), "");
    const next = await r.run(root, filter);
    expect(paths(await r.search(root, next, "added", "file", 10))).toEqual(["pkg0/added.ts"]);
  });

  it("answers a search the worker died holding", async () => {
    const root = tree(3, 2);
    const build = await runner({ walkCommand: noWalkProcess }).run(root, filter);
    const r = runner({ searchSpec: dyingWorker });

    expect(paths(await r.search(root, build, "pkg1/f0", "file", 10))).toEqual(["pkg1/f0.ts"]);
    expect(r.liveCount.searchers).toBe(0);
  });

  it("answers a walk whose process died without answering, on this thread", async () => {
    const root = tree(3, 2);
    const r = runner({ walkCommand: dyingWalkProcess });
    const build = await r.run(root, filter);

    expect(build.count).toBe(3 + 3 * 2);
    expect(r.onMainThread).toBe(true);
    expect(r.liveCount.walks).toBe(0);
  });

  it("leaves no walk process behind, however many walks ran at once", async () => {
    const root = tree(3, 2);
    const r = runner();
    const builds = await Promise.all([r.run(root, filter), r.run(root, filter), r.run(root, filter)]);

    expect(new Set(builds.map((b) => b.hash)).size).toBe(1);
    expect(r.onMainThread).toBe(false);
    expect(r.liveCount.walks).toBe(0);
  });

  it("gives the walk process's answer byte for byte as this thread would", async () => {
    const root = tree(4, 3);
    writeFileSync(join(root, ".gitignore"), "pkg1/\n");
    const ignoring = { exclude: ["**/pkg3"], useIgnoreFiles: true };
    const inProcess = await runner().run(root, ignoring);
    const here = await runner({ walkCommand: noWalkProcess }).run(root, ignoring);

    expect(inProcess.hash).toBe(here.hash);
    expect(new TextDecoder().decode(inProcess.json)).toBe(new TextDecoder().decode(here.json));
    expect(new TextDecoder().decode(Bun.gunzipSync(inProcess.gzip))).toBe(new TextDecoder().decode(inProcess.json));
  });
});

describe("reading a walk process's answer", () => {
  it("refuses an answer whose length does not match its header", () => {
    const header = { ok: true, hash: "h", count: 0, walkMs: 1, large: false, truncated: false, jsonBytes: 4, gzipBytes: 0, compactBytes: 0, peakRssMB: 1 };
    const out = new TextEncoder().encode(JSON.stringify(header) + "\n" + "abc");
    expect(() => parseWalkOutput(out, 0)).toThrow(/promised/);
  });

  it("passes on a walk's own error rather than retrying it here", () => {
    const out = new TextEncoder().encode(JSON.stringify({ ok: false, error: "boom" }) + "\n");
    expect(() => parseWalkOutput(out, 1)).toThrow(WalkError);
    expect(() => parseWalkOutput(new Uint8Array(), 3)).toThrow(/code 3 and no answer/);
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
