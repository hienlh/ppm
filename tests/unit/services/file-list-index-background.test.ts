/**
 * The flat file index behind `/files/index` is walked on the index worker, kept fresh in the
 * background, and a change keeps a request waiting for the rebuild no longer than a short grace.
 *
 * nxsys-workspace — ~66 ticket checkouts, 181k entries, 22 MB of JSON — took 6.2 s to walk
 * with `readdirSync` on the main thread, measured three times on a scratch server. Every file
 * change dropped the cached list and the explorer refetched it 300 ms later, so a session
 * writing Playwright logs and screenshots into the project kept the server frozen back to back
 * until the supervisor's health check (5 s timeout, three strikes) killed it — and every Claude
 * session running under it (2026-09-24 19:51 and 2026-09-25 12:24).
 */
import "../../test-setup.ts";
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildIndex,
  markIndexStale,
  invalidateIndexCache,
  clearIndexCache,
  onIndexRebuilt,
  refreshDelay,
  warmIndex,
} from "../../../src/services/file-list-index.service.ts";
import { FileIndexRunner, fileIndexRunner, fileIndexWorkerSpec } from "../../../src/services/file-index/file-index-runner.ts";
import { walkIndex, type IndexBuild } from "../../../src/services/file-index/index-walk.ts";
import type { FileEntry } from "../../../src/types/project.ts";
import { configService } from "../../../src/services/config.service.ts";
import { globalWebSocket } from "../../../src/server/ws/global.ts";
import { startWatching, stopWatching, onFileChange } from "../../../src/services/file-watcher.service.ts";

let root: string;
const cleanups: Array<() => void> = [];

function makeTree(dirs: number, filesPerDir: number, under = root): void {
  for (let d = 0; d < dirs; d++) {
    const dir = join(under, `pkg${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < filesPerDir; f++) writeFileSync(join(dir, `f${f}.ts`), "");
  }
}

const entriesOf = (build: IndexBuild): FileEntry[] => JSON.parse(new TextDecoder().decode(build.json)).data;
const pathsOf = (build: IndexBuild): string[] => entriesOf(build).map((e) => e.path);

/** Every background rebuild of `root` from here on, as `changed` flags. */
function recordRebuilds(): boolean[] {
  const seen: boolean[] = [];
  cleanups.push(onIndexRebuilt((projectPath, changed) => {
    if (projectPath === root) seen.push(changed);
  }));
  return seen;
}

/** Resolves when the next background rebuild of `root` lands. */
function nextRebuild(): Promise<boolean> {
  return new Promise((resolve) => {
    const off = onIndexRebuilt((projectPath, changed) => {
      if (projectPath !== root) return;
      off();
      resolve(changed);
    });
  });
}

/**
 * Takes the walks over: each call to the runner waits until the test settles it, so what the
 * index does *while* a walk runs can be pinned down instead of raced against the worker.
 */
function controlWalks(): { rootPath: string; resolve: (b: IndexBuild) => void; reject: (e: Error) => void }[] {
  const walks: { rootPath: string; resolve: (b: IndexBuild) => void; reject: (e: Error) => void }[] = [];
  const spy = spyOn(fileIndexRunner, "run").mockImplementation((rootPath: string) =>
    new Promise<IndexBuild>((resolve, reject) => { walks.push({ rootPath, resolve, reject }); }));
  cleanups.push(() => spy.mockRestore());
  return walks;
}

function fakeBuild(hash: string, walkMs = 5): IndexBuild {
  const json = new TextEncoder().encode(JSON.stringify({ ok: true, data: [] }));
  return { json, gzip: Bun.gzipSync(json), hash, count: 0, walkMs };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  clearIndexCache();
  root = mkdtempSync(join(tmpdir(), "ppm-index-"));
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  clearIndexCache();
  rmSync(root, { recursive: true, force: true });
});

describe("the index worker", () => {
  it("walks on a thread of its own, so a stopped event loop does not stop the walk", async () => {
    makeTree(200, 40);
    const filter = { exclude: [], useIgnoreFiles: false };
    // Calibrate: how long this machine takes over the walk on each thread.
    const fallback = new FileIndexRunner(new URL("./no-such-worker.ts", import.meta.url).href);
    cleanups.push(() => fallback.close());
    await fallback.run(root, filter); // finds out the worker is missing
    let started = performance.now();
    await fallback.run(root, filter);
    const mainThreadMs = performance.now() - started;
    started = performance.now();
    await fileIndexRunner.run(root, filter);
    const workerMs = performance.now() - started;

    const pending = fileIndexRunner.run(root, filter);
    // Hold this thread for longer than a whole walk. A walk on it could not even start until
    // this ends, and would then take its full length; on the worker it is already done.
    const until = performance.now() + workerMs * 2 + 200;
    while (performance.now() < until) { /* busy */ }
    const released = performance.now();
    const build = await pending;

    expect(fileIndexRunner.onMainThread).toBe(false);
    expect(build.count).toBe(200 + 200 * 40);
    expect(performance.now() - released).toBeLessThan(mainThreadMs / 4);
  }, 30_000);

  it("walks on the main thread instead when the worker cannot be started", async () => {
    makeTree(3, 2);
    const runner = new FileIndexRunner(new URL("./no-such-worker.ts", import.meta.url).href);
    cleanups.push(() => runner.close());
    const build = await runner.run(root, { exclude: [], useIgnoreFiles: false });

    expect(runner.onMainThread).toBe(true);
    expect(pathsOf(build)).toContain("pkg2/f1.ts");
    expect(new TextDecoder().decode(Bun.gunzipSync(build.gzip))).toBe(new TextDecoder().decode(build.json));
  });

  it("gives the same answer on either thread", async () => {
    makeTree(4, 3);
    writeFileSync(join(root, ".gitignore"), "pkg1/\n");
    const filter = { exclude: ["**/pkg3"], useIgnoreFiles: true };
    const onWorker = await fileIndexRunner.run(root, filter);
    const fallback = new FileIndexRunner(new URL("./no-such-worker.ts", import.meta.url).href);
    cleanups.push(() => fallback.close());
    const onMain = await fallback.run(root, filter);

    expect(onWorker.hash).toBe(onMain.hash);
    expect(entriesOf(onWorker).find((e) => e.path === "pkg1/f0.ts")?.isIgnored).toBe(true);
    expect(pathsOf(onWorker).some((p) => p.startsWith("pkg3"))).toBe(false);
  });

  it("is named so that both a compiled build and the source tree can load it", async () => {
    expect(fileIndexWorkerSpec(true)).toBe("./services/file-index/file-index-worker.ts");
    expect(fileIndexWorkerSpec(false)).toEndWith("/src/services/file-index/file-index-worker.ts");
    // The compiled spelling resolves only because the worker is an entry point of the build.
    const pkg = await Bun.file(join(import.meta.dir, "../../../package.json")).json();
    expect(pkg.scripts.build).toContain("src/services/file-index/file-index-worker.ts");
  });
});

describe("file index rebuild", () => {
  it("hands the event loop back while it walks on the main thread", async () => {
    // The walk the runner falls back to without a worker, at its 256 entries a slice. Timed
    // through `buildIndex` this could not fail: that walks on the worker, and this thread ticks
    // whether or not the walk ever yields.
    // 1240 entries: several slices on any machine, since slicing goes by entry count.
    makeTree(40, 30);
    let done = false;
    let ticks = 0;
    const tick = () => {
      if (done) return;
      ticks++;
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);

    const entries = await walkIndex(root, { exclude: [], useIgnoreFiles: false }, 256);
    done = true;

    expect(entries.length).toBe(40 + 40 * 30);
    // A walk that never yields settles before the first timer runs, leaving this at 0.
    expect(ticks).toBeGreaterThanOrEqual(2);
  });

  it("serves the list it has while a change is being picked up", async () => {
    makeTree(3, 2);
    const before = await buildIndex(root);

    writeFileSync(join(root, "added.ts"), "");
    markIndexStale(root);
    const rebuilt = nextRebuild();
    const during = await buildIndex(root, 0);

    // The old list, straight away — not a wait for the walk.
    expect(during).toBe(before);
    expect(pathsOf(during)).not.toContain("added.ts");

    expect(await rebuilt).toBe(true);
    expect(pathsOf(await buildIndex(root))).toContain("added.ts");
  });

  it("answers with the rebuilt list when it lands within the grace", async () => {
    makeTree(3, 2);
    await buildIndex(root);

    writeFileSync(join(root, "added.ts"), "");
    markIndexStale(root);

    // A file just created is in the palette the first time it opens.
    expect(pathsOf(await buildIndex(root))).toContain("added.ts");
  });

  it("answers with the list it has once the grace runs out", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a"));
    const before = await first;

    markIndexStale(root);
    // The rebuild is still running when the grace ends.
    expect(await buildIndex(root, 1)).toBe(before);
    expect(walks).toHaveLength(2);
  });

  it("reports whether a rebuild changed the list", async () => {
    makeTree(3, 2);
    await buildIndex(root);
    const rebuilds = recordRebuilds();

    // Content churn — a log being appended to — lists the same paths.
    writeFileSync(join(root, "pkg0", "f0.ts"), "appended");
    markIndexStale(root);
    let landed = nextRebuild();
    await buildIndex(root);
    await landed;

    writeFileSync(join(root, "pkg0", "new.ts"), "");
    markIndexStale(root);
    landed = nextRebuild();
    await buildIndex(root);
    await landed;

    expect(rebuilds).toEqual([false, true]);
  });

  it("shares one walk between concurrent first requests", async () => {
    const walks = controlWalks();
    const a = buildIndex(root);
    const b = buildIndex(root);
    expect(walks).toHaveLength(1);
    walks[0]!.resolve(fakeBuild("a"));
    expect(await a).toBe(await b);
  });

  it("starts one rebuild however many requests arrive while it runs", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a"));
    await first;

    markIndexStale(root);
    await Promise.all([buildIndex(root, 0), buildIndex(root, 0), buildIndex(root, 0)]);
    expect(walks).toHaveLength(2);
    walks[1]!.resolve(fakeBuild("b"));
    await flush();
    // Nothing changed after that walk began, so the list it produced is current.
    await buildIndex(root, 0);
    expect(walks).toHaveLength(2);
  });

  it("walks again as soon as a walk ends when a request found a change that landed during it", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a"));
    await first;

    markIndexStale(root);
    await buildIndex(root, 0);
    expect(walks).toHaveLength(2);
    // The walk read the root listing when it started, so it cannot see this.
    markIndexStale(root);
    await buildIndex(root, 0);
    expect(walks).toHaveLength(2);

    walks[1]!.resolve(fakeBuild("b"));
    await flush();
    // Straight away, not after the background delay: someone is waiting for this list.
    expect(walks).toHaveLength(3);
  });

  it("answers a slow project at once, and leaves its rebuild to the schedule", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a", 6000)); // nxsys-workspace: ~6 s a walk
    const before = await first;

    markIndexStale(root);
    let answered = false;
    const during = buildIndex(root).then((b) => { answered = true; return b; });
    await Bun.sleep(20);
    // Not a wait for the grace: every palette open would take that long while a session writes.
    expect(answered).toBe(true);
    expect(await during).toBe(before);
    // Nor a walk ahead of the schedule, which would keep the worker walking back to back.
    expect(walks).toHaveLength(1);
  });

  it("answers a slow project at once while its rebuild runs, too", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a", 300));
    const before = await first;

    markIndexStale(root);
    await Bun.sleep(1100);
    expect(walks).toHaveLength(2); // the scheduled rebuild is running
    let answered = false;
    const during = buildIndex(root).then((b) => { answered = true; return b; });
    await Bun.sleep(20);
    expect(answered).toBe(true);
    expect(await during).toBe(before);
  });

  it("re-arms a slow project's refresh when a failed rebuild left none scheduled", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a", 300));
    await first;

    markIndexStale(root);
    await Bun.sleep(1100);
    walks[1]!.reject(new Error("EACCES"));
    await flush();
    await buildIndex(root);
    await Bun.sleep(1100);
    expect(walks).toHaveLength(3);
  });

  it("does not answer a hard invalidation with a walk that began before it", async () => {
    const walks = controlWalks();
    const orphan = buildIndex(root);
    // Filters changed mid-walk: that walk applied the old ones.
    invalidateIndexCache(root);
    const fresh = buildIndex(root);
    walks[0]!.resolve(fakeBuild("old filters"));
    walks[1]!.resolve(fakeBuild("new filters"));
    expect((await fresh).hash).toBe("new filters");
    expect((await orphan).hash).toBe("old filters");
  });

  it("keeps the list it had when a rebuild fails", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a"));
    const before = await first;

    markIndexStale(root);
    const during = buildIndex(root);
    walks[1]!.reject(new Error("EACCES"));
    expect(await during).toBe(before);
    // Still stale, so the next request tries again.
    await buildIndex(root, 0);
    expect(walks).toHaveLength(3);
  });
});

describe("keeping the index fresh without being asked", () => {
  it("walks again a second after a change, with no request", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a"));
    await first;

    markIndexStale(root);
    await Bun.sleep(700);
    expect(walks).toHaveLength(1); // a burst of writes is still landing
    await Bun.sleep(600);
    expect(walks).toHaveLength(2);
  });

  it("costs one walk for a burst of changes", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a"));
    await first;

    for (let i = 0; i < 10; i++) {
      markIndexStale(root);
      await Bun.sleep(40);
    }
    await Bun.sleep(1200);
    expect(walks).toHaveLength(2);
  });

  it("does not start a second walk while one runs, and picks the change up after it", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a"));
    await first;

    markIndexStale(root);
    await Bun.sleep(1100);
    expect(walks).toHaveLength(2);
    markIndexStale(root); // lands while walk 2 runs
    await Bun.sleep(1100);
    expect(walks).toHaveLength(2);

    walks[1]!.resolve(fakeBuild("b"));
    await Bun.sleep(1100);
    expect(walks).toHaveLength(3);
  }, 10_000);

  it("keeps a slow project's worker busy at most half the time", () => {
    // One second after a change, but never sooner after the last walk than that walk took.
    expect(refreshDelay(10_000, 0, 80)).toBe(1000);
    expect(refreshDelay(10_000, 9_900, 80)).toBe(1000);
    expect(refreshDelay(10_000, 9_000, 7_000)).toBe(6_000);
  });

  it("gives up a scheduled walk when the index is dropped", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a"));
    await first;

    markIndexStale(root);
    invalidateIndexCache(root);
    await Bun.sleep(1200);
    expect(walks).toHaveLength(1);
  });

  it("warms a project before its first request, once, and the request shares that walk", async () => {
    const walks = controlWalks();
    warmIndex(root);
    warmIndex(root);
    expect(walks.map((w) => w.rootPath)).toEqual([root]);

    const request = buildIndex(root);
    walks[0]!.resolve(fakeBuild("warm"));
    expect((await request).hash).toBe("warm");
    expect(walks).toHaveLength(1);
  });

  it("does not walk ahead of the refresh when warming a project it already holds", async () => {
    const walks = controlWalks();
    const first = buildIndex(root);
    walks[0]!.resolve(fakeBuild("a"));
    await first;

    // A phone waking up reconnects and sends `watch` again; nxsys-workspace takes 7 s a walk.
    markIndexStale(root);
    warmIndex(root);
    expect(walks).toHaveLength(1);
  });

  it("lets a process that read an index exit while a refresh is pending", async () => {
    makeTree(3, 2);
    const service = new URL("../../../src/services/file-list-index.service.ts", import.meta.url).href;
    const script = `
      const { buildIndex, markIndexStale } = await import(${JSON.stringify(service)});
      await buildIndex(${JSON.stringify(root)});
      markIndexStale(${JSON.stringify(root)});
      console.log(Date.now());
    `;
    const home = mkdtempSync(join(tmpdir(), "ppm-index-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PPM_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const kill = setTimeout(() => child.kill(), 10_000);
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const exitedAt = Date.now();
    clearTimeout(kill);

    expect(code).toBe(0);
    // Neither the refresh timer nor the idle worker keeps it alive.
    expect(exitedAt - Number(out.trim().split("\n").pop())).toBeLessThan(500);
  });

  it("warms the project a client starts watching", async () => {
    const walks = controlWalks();
    const name = "index-warm";
    const projects = configService.get("projects");
    configService.set("projects", [...projects, { name, path: root }]);
    const ws = { data: { type: "global" }, send: () => {} };
    globalWebSocket.open(ws);
    try {
      globalWebSocket.message(ws, JSON.stringify({ type: "watch", projectName: name }));
      expect(walks.map((w) => w.rootPath)).toEqual([root]);
      walks[0]!.resolve(fakeBuild("warm"));
    } finally {
      globalWebSocket.close(ws);
      configService.set("projects", projects);
    }
  });
});

describe("files:index-changed", () => {
  it("reaches browsers when a rebuild lists other paths, and not for content churn", async () => {
    makeTree(3, 2);
    const projects = configService.get("projects");
    configService.set("projects", [...projects, { name: "index-broadcast", path: root }]);
    const sent: string[] = [];
    const ws = { data: { type: "global" }, send: (data: string) => { sent.push(data); } };
    globalWebSocket.open(ws);
    try {
      await buildIndex(root);

      writeFileSync(join(root, "pkg0", "f0.ts"), "appended");
      markIndexStale(root);
      let landed = nextRebuild();
      await buildIndex(root);
      await landed;

      writeFileSync(join(root, "added.ts"), "");
      markIndexStale(root);
      landed = nextRebuild();
      await buildIndex(root);
      await landed;

      const events = sent.map((s) => JSON.parse(s)).filter((e) => e.type === "files:index-changed");
      expect(events).toEqual([{ type: "files:index-changed", projectName: "index-broadcast" }]);
    } finally {
      globalWebSocket.close(ws);
      configService.set("projects", projects);
    }
  });
});

describe("a watched change", () => {
  it("marks the index stale rather than dropping it", async () => {
    makeTree(3, 2);
    const name = "index-watch";
    const projects = configService.get("projects");
    configService.set("projects", [...projects, { name, path: root }]);
    try {
      await startWatching(name, root);
      const before = await buildIndex(root);
      // Registered after the index's own listener, so this fires once that one has run.
      const delivered = new Promise<void>((resolve) => onFileChange((projectName) => {
        if (projectName === name) resolve();
      }));
      writeFileSync(join(root, "added.ts"), "");
      await delivered;

      // Dropped, the next request would wait for a walk — and that walk finds added.ts.
      expect(await buildIndex(root, 0)).toBe(before);
      // Left alone, the list would never pick it up.
      expect(pathsOf(await buildIndex(root))).toContain("added.ts");
    } finally {
      stopWatching(name);
      configService.set("projects", projects);
    }
  });
});
