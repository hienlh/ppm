/**
 * The server-descendant tracker walks parent PIDs, and Windows keeps a process's parent PID
 * after the parent dies. The 0.25.6 → 0.25.7 upgrade (14/11/2026) is the case pinned here:
 * the edge, the tunnel and the running supervisor all named an earlier supervisor (51116)
 * as their parent; a process under the server then got PID 51116; the snapshot listed all
 * three as server descendants, and stopping the server for the upgrade killed them.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  descendantsByLineage,
  lineageKillTargets,
  selfAndAncestors,
  startedNoEarlierThan,
  reapTrackedDescendants,
} from "../../../src/services/windows-process-tree.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";

type Info = { ppid: number; ticks: string };
const map = (rows: Array<[number, number, number | string]>) =>
  new Map<number, Info>(rows.map(([pid, ppid, ticks]) => [pid, { ppid, ticks: String(ticks) }]));

/** The process table at 21:20Z, reduced to what matters. 51116 itself had exited at 17:56. */
const incident = map([
  [50360, 51116, 100],  // edge, started by supervisor 51116 at 17:09
  [24628, 51116, 101],  // tunnel, same
  [50000, 51116, 200],  // the running supervisor, started by 51116's self-replace at 17:56
  [47144, 50000, 210],  // share host, under the running supervisor
  [23860, 50000, 220],  // the server
  [12001, 23860, 300],  // a claude CLI under the server
  [51116, 12001, 400],  // a shell under that CLI, which got the dead supervisor's PID
  [12002, 51116, 410],  // a git under that shell
]);

describe("descendantsByLineage", () => {
  it("does not reach the edge, tunnel or supervisor through a reused PID", () => {
    const tree = descendantsByLineage(23860, incident);
    expect(tree.sort()).toEqual([12001, 12002, 51116].sort());
    for (const pid of [50360, 24628, 50000, 47144]) expect(tree).not.toContain(pid);
  });

  it("is what parent PIDs alone would have got wrong", () => {
    // The children of 51116 by parent PID alone: exactly what the old snapshot tracked.
    const byPpidOnly = [...incident].filter(([, i]) => i.ppid === 51116).map(([p]) => p).sort();
    expect(byPpidOnly).toEqual([12002, 24628, 50000, 50360].sort());
  });

  it("keeps a whole ordinary tree, parents first", () => {
    const procs = map([[10, 1, 10], [11, 10, 20], [12, 11, 30], [13, 10, 25]]);
    expect(descendantsByLineage(10, procs)).toEqual([11, 13, 12]);
  });

  it("keeps a link when a creation time is unknown", () => {
    expect(startedNoEarlierThan({ ppid: 1, ticks: "" }, { ppid: 0, ticks: "5" })).toBe(true);
    expect(descendantsByLineage(10, map([[10, 1, 10], [11, 10, ""]]))).toEqual([11]);
  });

  it("survives a parent cycle", () => {
    expect(descendantsByLineage(10, map([[10, 11, 5], [11, 10, 5]]))).toEqual([11]);
  });
});

describe("lineageKillTargets", () => {
  it("stopping the server reaches its own tree and nothing the old supervisor started", () => {
    const targets = lineageKillTargets(23860, incident, [50360, 24628], 50000);
    expect(targets.sort()).toEqual([12001, 12002, 23860, 51116].sort());
  });

  it("still kills the root when the process list could not be read, came back empty, or lost it", () => {
    expect(lineageKillTargets(23860, null)).toEqual([23860]);
    expect(lineageKillTargets(23860, new Map())).toEqual([23860]);
    expect(lineageKillTargets(23860, map([[1, 0, 1]]))).toEqual([23860]);
  });

  it("never names the caller, its ancestors or a protected process", () => {
    expect(lineageKillTargets(50000, incident, [], 50000)).toEqual([]);
    expect(lineageKillTargets(23860, incident, [23860], 50000)).toEqual([]);
    // The caller sits under the root (a CLI run from a chat's shell): it and its chain stay.
    const t = lineageKillTargets(23860, incident, [], 12002);
    for (const pid of [12002, 51116, 12001, 23860]) expect(t).not.toContain(pid);
  });
});

describe("descendantsByLineage without its root", () => {
  it("lists nothing, since no creation time can be checked against", () => {
    expect(descendantsByLineage(99999, map([[5, 99999, 1]]))).toEqual([]);
  });
});

describe("selfAndAncestors", () => {
  it("climbs the real chain and stops where a parent PID has been reused", () => {
    // The running supervisor's own chain stops at 50000: its recorded parent 51116 is now a
    // younger process, not its parent.
    expect(selfAndAncestors(50000, incident)).toEqual([50000]);
    expect(selfAndAncestors(12002, incident)).toEqual([12002, 51116, 12001, 23860, 50000]);
  });
});

describe.if(process.platform === "win32")("reapTrackedDescendants (real processes)", () => {
  const originalHome = process.env.PPM_HOME;
  let home: string;
  const spawned: number[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ppm-reap-"));
    process.env.PPM_HOME = home;
    _resetPpmDir();
  });
  afterEach(() => {
    for (const pid of spawned.splice(0)) { try { process.kill(pid); } catch {} }
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });
  afterAll(() => {
    if (originalHome === undefined) delete process.env.PPM_HOME; else process.env.PPM_HOME = originalHome;
    _resetPpmDir();
  });

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const sleeper = () => {
    const p = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdout: "ignore", stderr: "ignore" });
    spawned.push(p.pid);
    return p.pid;
  };
  /** The creation ticks the tracker records, read the way it reads them. */
  function ticksOf(pids: number[]): Map<number, string> {
    const filter = pids.map((p) => `ProcessId=${p}`).join(" or ");
    const out = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.Ticks)" }`]).stdout.toString();
    return new Map(out.trim().split(/\r?\n/).map((l) => l.split("|")).map(([p, t]) => [Number(p), t!.trim()]));
  }
  const writeTracked = (pids: number[]) => {
    const ticks = ticksOf(pids);
    writeFileSync(join(home, "tracked-descendants.json"), JSON.stringify(pids.map((pid) => ({ pid, ticks: ticks.get(pid) }))));
  };

  it("kills a tracked orphan but never a protected process or itself", async () => {
    const orphan = sleeper();
    const edgeLike = sleeper();
    writeTracked([orphan, edgeLike, process.pid]);
    const lines: string[] = [];

    const reaped = await reapTrackedDescendants((m) => lines.push(m), [edgeLike]);

    expect(reaped).toBe(1);
    await Bun.sleep(300);
    expect(alive(orphan)).toBe(false);
    expect(alive(edgeLike)).toBe(true);
    expect(alive(process.pid)).toBe(true);
    expect(lines.some((l) => l.includes(`Not reaping PID ${process.pid}`))).toBe(true);
    expect(existsSync(join(home, "tracked-descendants.json"))).toBe(false);
  }, 30_000);
});
