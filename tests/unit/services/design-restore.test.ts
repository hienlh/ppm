import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { listSnapshots, snapshotDesign } from "../../../src/services/design/design-snapshots.service.ts";
import { recoverRestoreJournal, restoreSnapshot } from "../../../src/services/design/design-restore.service.ts";
import { restoreCrashPoints, RESTORE_JOURNAL } from "../../../src/services/design/design-restore-journal.ts";
import { snapshotFilesDir } from "../../../src/services/design/design-snapshot-history.ts";
import { onDesignEvent } from "../../../src/services/design/design-events.ts";

/** rel path → contents, for a tree, leaving `.design/` out at the top. */
function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, name.name);
      if (dir === root && name.name === ".design") continue;
      if (name.isDirectory()) walk(abs);
      else out[relative(root, abs).split(sep).join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}

class Crash extends Error {}

describe("journaled restore", () => {
  let project: string;
  let dir: string;
  let stateA: Record<string, string>;
  let stateB: Record<string, string>;
  let idA: string;

  const write = (rel: string, text: string) => {
    const path = join(dir, ...rel.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-restore-")));
    await createDesign(project, { title: "Home", kind: "page" });
    dir = join(project, "designs", "home");
    write("index.html", "state A");
    write("styles/a.css", "a{}");
    write("only-a.txt", "gone in B");
    stateA = readTree(dir);
    idA = ((await snapshotDesign(project, "home", "turn")) as { id: string }).id;
    write("index.html", "state B");
    rmSync(join(dir, "only-a.txt"));
    rmSync(join(dir, "styles"), { recursive: true });
    write("only-b/x.txt", "new in B");
    stateB = readTree(dir);
  });
  afterEach(() => {
    restoreCrashPoints.hit = undefined;
    rmSync(project, { recursive: true, force: true });
  });

  it("round-trips the snapshot's bytes and can itself be undone", async () => {
    let events = 0;
    const off = onDesignEvent(() => { events++; });
    const result = await restoreSnapshot(project, "home", idA);
    off();
    expect(events).toBe(1);
    expect(result.restored).toBe(idA);
    expect(readTree(dir)).toEqual(stateA);
    const pre = (await listSnapshots(project, "home")).find((s) => s.id === result.previousStateId)!;
    expect(pre).toMatchObject({ reason: "pre-restore", restoreOf: idA });
    expect(readTree(snapshotFilesDir(dir, pre.id))).toEqual(stateB);
    await restoreSnapshot(project, "home", result.previousStateId);
    expect(readTree(dir)).toEqual(stateB);
    expect(existsSync(join(dir, ".design", RESTORE_JOURNAL))).toBe(false);
    expect(readdirSync(join(dir, ".design")).filter((n) => n.startsWith("tmp-"))).toEqual([]);
  });

  it("validates the id and the snapshot's existence", async () => {
    await expect(restoreSnapshot(project, "home", "../../x")).rejects.toMatchObject({ status: 400 });
    await expect(restoreSnapshot(project, "home", "20260101-000000-abcd")).rejects.toMatchObject({ status: 404 });
    expect(readTree(dir)).toEqual(stateB);
  });

  it("protects the target from the pre-restore snapshot's pruning", async () => {
    for (let i = 0; i < 100; i++) {
      write("index.html", `filler ${i}`);
      await snapshotDesign(project, "home", "turn");
    }
    expect((await listSnapshots(project, "home")).some((s) => s.id === idA)).toBe(false);
    const oldest = (await listSnapshots(project, "home")).at(-1)!;
    write("index.html", "current");
    await restoreSnapshot(project, "home", oldest.id);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("filler 0");
  });

  it("a crash while staged leaves the working tree alone, and recovery discards the copy", async () => {
    restoreCrashPoints.hit = (step) => { if (step === "staged") throw new Crash(step); };
    await expect(restoreSnapshot(project, "home", idA)).rejects.toBeInstanceOf(Crash);
    restoreCrashPoints.hit = undefined;
    expect(readTree(dir)).toEqual(stateB);
    expect(JSON.parse(readFileSync(join(dir, ".design", RESTORE_JOURNAL), "utf8")).phase).toBe("staged");
    expect(await recoverRestoreJournal(dir)).toBe("discarded");
    expect(readTree(dir)).toEqual(stateB);
    expect(existsSync(join(dir, ".design", `tmp-${idA}`))).toBe(false);
    expect(existsSync(join(dir, ".design", RESTORE_JOURNAL))).toBe(false);
  });

  it("finishes the swap from tmp after a crash at every step once swapping began", async () => {
    // Dry run to learn every crash point this restore passes through.
    const steps: string[] = [];
    restoreCrashPoints.hit = (step) => { steps.push(step); };
    await restoreSnapshot(project, "home", idA);
    restoreCrashPoints.hit = undefined;
    const afterSwapping = steps.slice(steps.indexOf("swapping"));
    expect(afterSwapping.some((s) => s.startsWith("cleared:"))).toBe(true);
    expect(afterSwapping.some((s) => s.startsWith("moved:"))).toBe(true);

    for (const crashAt of afterSwapping) {
      // Reset the working tree to B so every round starts from the same place.
      for (const name of readdirSync(dir)) if (name !== ".design") rmSync(join(dir, name), { recursive: true, force: true });
      for (const [rel, text] of Object.entries(stateB)) write(rel, text);

      restoreCrashPoints.hit = (step) => { if (step === crashAt) throw new Crash(step); };
      await expect(restoreSnapshot(project, "home", idA)).rejects.toBeInstanceOf(Crash);
      restoreCrashPoints.hit = undefined;
      // The next locked operation on the design repairs it before doing its own work.
      await snapshotDesign(project, "home", "manual");
      expect(readTree(dir)).toEqual(stateA);
      expect(existsSync(join(dir, ".design", RESTORE_JOURNAL))).toBe(false);
      expect(readdirSync(join(dir, ".design")).filter((n) => n.startsWith("tmp-"))).toEqual([]);
      // The state from before the interrupted restore is still in history.
      const pre = (await listSnapshots(project, "home")).find((s) => s.reason === "pre-restore")!;
      expect(readTree(snapshotFilesDir(dir, pre.id))).toEqual(stateB);
    }
  });

  it("survives a second crash during recovery itself", async () => {
    restoreCrashPoints.hit = (step) => { if (step.startsWith("moved:")) throw new Crash(step); };
    await expect(restoreSnapshot(project, "home", idA)).rejects.toBeInstanceOf(Crash);
    await expect(recoverRestoreJournal(dir)).rejects.toBeInstanceOf(Crash);
    restoreCrashPoints.hit = undefined;
    expect(await recoverRestoreJournal(dir)).toBe("completed");
    expect(readTree(dir)).toEqual(stateA);
  });

  it("keeps the pre-restore snapshot equal to the state it replaced", async () => {
    restoreCrashPoints.hit = (step) => { if (step === "swapping") throw new Crash(step); };
    await expect(restoreSnapshot(project, "home", idA)).rejects.toBeInstanceOf(Crash);
    restoreCrashPoints.hit = undefined;
    await recoverRestoreJournal(dir);
    const pre = (await listSnapshots(project, "home")).find((s) => s.reason === "pre-restore")!;
    expect(readTree(snapshotFilesDir(dir, pre.id))).toEqual(stateB);
    expect(readTree(dir)).toEqual(stateA);
  });

  it("ignores an unreadable journal instead of acting on it", async () => {
    writeFileSync(join(dir, ".design", RESTORE_JOURNAL), JSON.stringify({ id: idA, tmp: "../../..", phase: "swapping", names: [] }));
    expect(await recoverRestoreJournal(dir)).toBe("none");
    expect(readTree(dir)).toEqual(stateB);
    expect(existsSync(join(dir, ".design", RESTORE_JOURNAL))).toBe(false);
  });
});
