/**
 * The flat file index behind `/files/index` is rebuilt without holding the event loop, and a
 * change keeps a request waiting for the rebuild no longer than a short grace.
 *
 * nxsys-workspace — ~66 ticket checkouts, 181k entries, 22 MB of JSON — took 6.2 s to walk
 * with `readdirSync` on the main thread, measured three times on a scratch server. Every file
 * change dropped the cached list and the explorer refetched it 300 ms later, so a session
 * writing Playwright logs and screenshots into the project kept the server frozen back to back
 * until the supervisor's health check (5 s timeout, three strikes) killed it — and every Claude
 * session running under it (2026-09-24 19:51 and 2026-09-25 12:24).
 */
import "../../test-setup.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildIndex,
  markIndexStale,
  invalidateIndexCache,
  clearIndexCache,
  onIndexRebuilt,
} from "../../../src/services/file-list-index.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { globalWebSocket } from "../../../src/server/ws/global.ts";
import { startWatching, stopWatching, onFileChange } from "../../../src/services/file-watcher.service.ts";

let root: string;
const unsubscribes: Array<() => void> = [];

function makeTree(dirs: number, filesPerDir: number): void {
  for (let d = 0; d < dirs; d++) {
    const dir = join(root, `pkg${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < filesPerDir; f++) writeFileSync(join(dir, `f${f}.ts`), "");
  }
}

/** Every background rebuild of `root` from here on, as `changed` flags. */
function recordRebuilds(): boolean[] {
  const seen: boolean[] = [];
  unsubscribes.push(onIndexRebuilt((projectPath, changed) => {
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

beforeEach(() => {
  clearIndexCache();
  root = mkdtempSync(join(tmpdir(), "ppm-index-"));
});

afterEach(() => {
  for (const off of unsubscribes.splice(0)) off();
  clearIndexCache();
  rmSync(root, { recursive: true, force: true });
});

describe("file index rebuild", () => {
  it("hands the event loop back while it walks", async () => {
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

    const entries = await buildIndex(root);
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
    expect(during.map((e) => e.path)).not.toContain("added.ts");

    expect(await rebuilt).toBe(true);
    expect((await buildIndex(root)).map((e) => e.path)).toContain("added.ts");
  });

  it("answers with the rebuilt list when it lands within the grace", async () => {
    makeTree(3, 2);
    await buildIndex(root);

    writeFileSync(join(root, "added.ts"), "");
    markIndexStale(root);

    // A file just created is in the palette the first time it opens.
    expect((await buildIndex(root)).map((e) => e.path)).toContain("added.ts");
  });

  it("answers with the list it has once the grace runs out", async () => {
    makeTree(80, 30);
    const before = await buildIndex(root);

    writeFileSync(join(root, "added.ts"), "");
    markIndexStale(root);
    const rebuilt = nextRebuild();

    // Ten slices, each ending on a timer: a walk that long cannot land inside a millisecond.
    expect(await buildIndex(root, 1)).toBe(before);
    expect(await rebuilt).toBe(true);
  });

  it("walks again when a request finds a change that landed during the walk", async () => {
    makeTree(40, 30);
    await buildIndex(root);
    const rebuilds = recordRebuilds();

    markIndexStale(root);
    await buildIndex(root, 0);
    // The walk read the root listing when it started, so it cannot see this.
    writeFileSync(join(root, "late.ts"), "");
    markIndexStale(root);
    await buildIndex(root, 0);

    const deadline = Date.now() + 2000;
    while (rebuilds.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(rebuilds).toEqual([false, true]);
    expect((await buildIndex(root, 0)).map((e) => e.path)).toContain("late.ts");
  });

  it("does not walk again for a change nobody asked about", async () => {
    makeTree(40, 30);
    await buildIndex(root);
    const rebuilds = recordRebuilds();

    markIndexStale(root);
    const landed = nextRebuild();
    await buildIndex(root, 0);
    writeFileSync(join(root, "late.ts"), "");
    markIndexStale(root);
    await landed;
    await Bun.sleep(200);

    expect(rebuilds).toEqual([false]);
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

  it("starts one rebuild however many requests arrive while it runs", async () => {
    makeTree(40, 30);
    await buildIndex(root);
    const rebuilds = recordRebuilds();

    writeFileSync(join(root, "added.ts"), "");
    markIndexStale(root);
    const landed = nextRebuild();
    await Promise.all([buildIndex(root), buildIndex(root), buildIndex(root)]);
    await landed;
    // Nothing changed after that walk began, so the list it produced is current.
    await buildIndex(root);
    // Room for any second walk to land, so leaving coalescing out cannot pass by being early.
    await Bun.sleep(200);

    expect(rebuilds).toEqual([true]);
  });

  it("shares one walk between concurrent first requests", async () => {
    makeTree(40, 30);
    const [a, b] = await Promise.all([buildIndex(root), buildIndex(root)]);
    expect(a).toBe(b);
  });

  it("does not answer a hard invalidation with a walk that began before it", async () => {
    makeTree(40, 30);
    const orphan = buildIndex(root);
    // Filters changed mid-walk: that walk applied the old ones.
    invalidateIndexCache(root);
    const fresh = buildIndex(root);
    expect(await fresh).not.toBe(await orphan);
  });
});

describe("files:index-changed", () => {
  it("reaches browsers when a rebuild lists other paths, and not for content churn", async () => {
    makeTree(3, 2);
    const projects = configService.get("projects");
    configService.set("projects", [...projects, { name: "index-broadcast", path: root, addedAt: new Date().toISOString() }]);
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
    configService.set("projects", [...projects, { name, path: root, addedAt: new Date().toISOString() }]);
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
      expect((await buildIndex(root)).map((e) => e.path)).toContain("added.ts");
    } finally {
      stopWatching(name);
      configService.set("projects", projects);
    }
  });
});
