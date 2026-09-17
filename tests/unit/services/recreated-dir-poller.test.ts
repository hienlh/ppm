import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecreatedDirPoller } from "../../../src/services/file-watcher/recreated-dir-poller.ts";

const pollers: RecreatedDirPoller[] = [];
const roots: string[] = [];

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ppm-poller-"));
  roots.push(d);
  return d;
}

function open(intervalMs = 40, maxDirs = 64): { poller: RecreatedDirPoller; seen: string[] } {
  const seen: string[] = [];
  const poller = new RecreatedDirPoller({ onChange: (p) => seen.push(p), intervalMs, maxDirs });
  pollers.push(poller);
  return { poller, seen };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

afterEach(() => {
  for (const p of pollers) p.close();
  pollers.length = 0;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe("RecreatedDirPoller", () => {
  it("reports a created file", async () => {
    const dir = makeDir();
    const { poller, seen } = open();
    poller.add(dir);

    writeFileSync(join(dir, "new.ts"), "a");
    expect(await waitFor(() => seen.some((p) => p.endsWith("new.ts")))).toBe(true);
  });

  it("does not report files that already existed when polling started", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "old.ts"), "a");
    const { poller, seen } = open();
    poller.add(dir);

    // Give several ticks a chance to misfire before concluding silence.
    writeFileSync(join(dir, "trigger.ts"), "a");
    expect(await waitFor(() => seen.some((p) => p.endsWith("trigger.ts")))).toBe(true);
    expect(seen.some((p) => p.endsWith("old.ts"))).toBe(false);
  });

  it("reports a modified file and a deleted file", async () => {
    const dir = makeDir();
    const target = join(dir, "edit.ts");
    writeFileSync(target, "a");
    const doomed = join(dir, "doomed.ts");
    writeFileSync(doomed, "a");
    const { poller, seen } = open();
    poller.add(dir);

    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(target, "changed content");
    expect(await waitFor(() => seen.some((p) => p.endsWith("edit.ts")))).toBe(true);

    unlinkSync(doomed);
    expect(await waitFor(() => seen.some((p) => p.endsWith("doomed.ts")))).toBe(true);
  });

  it("stops reporting after remove, including nested directories", async () => {
    const dir = makeDir();
    const nested = join(dir, "inner");
    mkdirSync(nested, { recursive: true });
    const { poller, seen } = open();
    poller.add(dir);
    poller.add(nested);
    expect(poller.size).toBe(2);

    poller.remove(dir); // must take `inner` with it
    expect(poller.size).toBe(0);

    writeFileSync(join(nested, "after.ts"), "a");
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.some((p) => p.endsWith("after.ts"))).toBe(false);
  });

  /** Big enough that one sweep spans several turns of the loop, which is the whole question. */
  const BUSY_DIR_ENTRIES = 6000;

  function makeBusyDir(): string {
    const dir = makeDir();
    for (let i = 0; i < BUSY_DIR_ENTRIES; i++) writeFileSync(join(dir, `f${i}.ts`), "a");
    return dir;
  }

  it("does not start a sweep while one is still running", async () => {
    // Two sweeps over the same directory read the same snapshot before either writes it back,
    // so both see the change and both report it. Measured here at 6000 entries on a 2ms
    // interval: without the guard the one new file arrives three times, and the slower the
    // host the more copies — the opposite of what a poller should do under load.
    const dir = makeBusyDir();
    const { poller, seen } = open(2);
    poller.add(dir);

    writeFileSync(join(dir, "once.ts"), "a");
    expect(await waitFor(() => seen.some((p) => p.endsWith("once.ts")))).toBe(true);
    await new Promise((r) => setTimeout(r, 200)); // let any stacked sweeps report too

    expect(seen.filter((p) => p.endsWith("once.ts"))).toHaveLength(1);
  });

  it("hands the loop back while it sweeps, rather than statting a directory in one go", async () => {
    // A `dist` or `node_modules` recreated by a checkout holds thousands of files, and statting
    // them synchronously stalled the loop once a second for as long as the directory stayed
    // polled — in the release whose subject is an event loop that answers.
    //
    // The baseline `add()` takes is deliberately excluded: it is one read per directory, not
    // one per second, and measuring it here would drown out what this is about. Measured at
    // 6000 entries: 26-27ms of worst-case delay this way, 126-127ms statting synchronously.
    const dir = makeBusyDir();
    const { poller } = open(20);
    poller.add(dir);
    await new Promise((r) => setTimeout(r, 300)); // let the baseline finish

    let worst = 0;
    let previous = Date.now();
    const beat = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - previous);
      previous = now;
    }, 5);
    writeFileSync(join(dir, "once.ts"), "a");
    await new Promise((r) => setTimeout(r, 800));
    clearInterval(beat);

    expect(worst).toBeLessThan(70);
  });

  it("refuses to grow past the budget and says so", () => {
    const { poller } = open(40, 2);
    for (let i = 0; i < 5; i++) {
      const d = makeDir();
      poller.add(d);
    }
    expect(poller.size).toBe(2);
    expect(poller.truncated).toBe(true);
  });

  it("tolerates a directory that disappears while polled", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "x.ts"), "a");
    const { poller, seen } = open();
    poller.add(dir);

    rmSync(dir, { recursive: true, force: true });
    // The entries vanishing is a legitimate change; the poller must report it
    // and keep running rather than throwing out of the interval callback.
    expect(await waitFor(() => seen.some((p) => p.endsWith("x.ts")))).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(poller.size).toBe(1);
  });
});
