import { describe, test, expect } from "bun:test";
import { groupProcesses } from "../../../../src/services/system-metrics/process-grouping.ts";
import { proc, WIN_DEV_HOST, WIN_RUN_PID, WIN_SERVER_PID } from "./fixtures/process-fixtures.ts";

const byKey = (groups: ReturnType<typeof groupProcesses>) => new Map(groups.map((g) => [g.key, g]));

describe("groupProcesses — win32", () => {
  const groups = groupProcesses(WIN_DEV_HOST, "win32", new Set([WIN_SERVER_PID, WIN_RUN_PID]), WIN_SERVER_PID);
  const g = byKey(groups);

  test("a multi-process app parented by explorer is exactly one group with a stable root key", () => {
    const chrome = g.get("root:4000")!;
    expect(chrome.label).toBe("chrome");
    expect(chrome.count).toBe(3);
    expect(chrome.cpu).toBe(6);
    expect(chrome.ramMB).toBe(600);
    expect(chrome.pids).toEqual([4001, 4000, 4002]); // cpu-desc
  });

  test("the PPM subtree splits out of the terminal chain and is labelled as this server, with ppm roll-up", () => {
    const ppm = g.get(`root:${WIN_RUN_PID}`)!;
    expect(ppm.label).toBe("PPM (this server)");
    expect(ppm.pids.sort()).toEqual([3000, 3100, 3200, 3300].sort());
    expect(groups.filter((x) => x.label.startsWith("PPM"))).toHaveLength(1);
    // WindowsTerminal keeps only its non-PPM children.
    expect(g.get("root:2000")!.pids.sort()).toEqual([2000, 2100]);
  });

  test("a second PPM instance on the machine (prod beside dev) is labelled by its root pid, not confused with this server", () => {
    // Prod supervisor 9000 → server 9100, both roots via status.json; dev server 3100 is `self`.
    const procs = [...WIN_DEV_HOST, proc(9000, 1000, "bun", { startedAt: 30 }), proc(9100, 9000, "bun", { startedAt: 31 })];
    const gg = byKey(groupProcesses(procs, "win32", new Set([WIN_SERVER_PID, WIN_RUN_PID, 9000, 9100]), WIN_SERVER_PID));
    expect(gg.get(`root:${WIN_RUN_PID}`)!.label).toBe("PPM (this server)");
    expect(gg.get("root:9000")!.label).toBe("PPM (pid 9000)");
    expect(gg.get("root:9000")!.pids.sort()).toEqual([9000, 9100]);
  });

  test("children of svchost/services/explorer boundaries become their own roots", () => {
    expect(g.get("root:950")!.pids).toEqual([950]);
    expect(g.get("root:900")!.pids).toEqual([900]);
    expect(g.get("root:1000")!.pids).toEqual([1000]);
  });

  test("ppid -1 goes to the exe bucket; a single process is still a group", () => {
    const orphan = g.get("exe:orphanapp")!;
    expect(orphan.rootPid).toBeNull();
    expect(orphan.count).toBe(1);
    expect(orphan.label).toBe("OrphanApp");
  });

  test("groups are sorted cpu-desc", () => {
    for (let i = 1; i < groups.length; i++) expect(groups[i - 1]!.cpu).toBeGreaterThanOrEqual(groups[i]!.cpu);
  });

  test("ppm flag is true when any member is ppm", () => {
    const procs = WIN_DEV_HOST.map((p) => (p.pid === 3300 ? { ...p, ppm: true } : p));
    const ppm = byKey(groupProcesses(procs, "win32", new Set([WIN_SERVER_PID, WIN_RUN_PID]))).get(`root:${WIN_RUN_PID}`)!;
    expect(ppm.ppm).toBe(true);
  });
});

describe("groupProcesses — optional column roll-ups", () => {
  test("a column no member can measure stays undefined, so the UI shows '—' not a confident 0", () => {
    const g = byKey(groupProcesses(WIN_DEV_HOST, "win32"));
    const chrome = g.get("root:4000")!;
    expect(chrome.diskReadBps).toBeUndefined();
    expect(chrome.gpuPct).toBeUndefined();
    expect(chrome.netInBps).toBeUndefined();
    // …and therefore never reaches the client as null.
    expect(JSON.stringify(chrome)).not.toContain("diskReadBps");
  });

  test("measured zeros DO roll up as 0 — 'idle' and 'unmeasurable' are different answers", () => {
    const procs = WIN_DEV_HOST.map((p) =>
      p.pid === 4000 || p.pid === 4001 || p.pid === 4002 ? { ...p, diskReadBps: 0, gpuPct: 0 } : p);
    const chrome = byKey(groupProcesses(procs, "win32")).get("root:4000")!;
    expect(chrome.diskReadBps).toBe(0);
    expect(chrome.gpuPct).toBe(0);
    expect(chrome.diskWriteBps).toBeUndefined();
  });

  test("members that have a value are summed; members that do not are skipped, not treated as 0-and-fine", () => {
    const procs = WIN_DEV_HOST.map((p) => {
      if (p.pid === 4000) return { ...p, diskReadBps: 1000, diskWriteBps: 10, gpuMemMB: 100.5, netInBps: 7, netOutBps: 8 };
      if (p.pid === 4001) return { ...p, diskReadBps: 2500, gpuMemMB: 200.25 };
      return p; // 4002 measured nothing at all
    });
    const chrome = byKey(groupProcesses(procs, "win32")).get("root:4000")!;
    expect(chrome.diskReadBps).toBe(3500);
    expect(chrome.diskWriteBps).toBe(10);
    expect(chrome.gpuMemMB).toBe(300.8); // rounded to 1 dp like ramMB
    expect(chrome.netInBps).toBe(7);
    expect(chrome.netOutBps).toBe(8);
  });

  test("a group's GPU busy is still a share of one GPU, so the sum is clamped to 100 %", () => {
    const procs = WIN_DEV_HOST.map((p) =>
      p.pid === 4000 || p.pid === 4001 || p.pid === 4002 ? { ...p, gpuPct: 60 } : p);
    expect(byKey(groupProcesses(procs, "win32")).get("root:4000")!.gpuPct).toBe(100);
  });

  test("a NaN or infinite figure is ignored rather than poisoning the whole roll-up", () => {
    const procs = WIN_DEV_HOST.map((p) => {
      if (p.pid === 4000) return { ...p, diskReadBps: Number.NaN };
      if (p.pid === 4001) return { ...p, diskReadBps: 42 };
      return p;
    });
    expect(byKey(groupProcesses(procs, "win32")).get("root:4000")!.diskReadBps).toBe(42);
  });
});

describe("groupProcesses — guards", () => {
  test("a recycled-pid parent (started after the child) stops the climb", () => {
    const procs = [
      proc(10, 1, "newparent", { startedAt: 5000 }),
      proc(20, 10, "child", { startedAt: 1000 }),
    ];
    const g = byKey(groupProcesses(procs, "linux"));
    expect(g.has("root:20")).toBe(true);
    expect(g.get("root:20")!.pids).toEqual([20]);
  });

  test("a parent cycle makes each process its own root instead of looping", () => {
    const procs = [proc(10, 20, "a", { startedAt: 0 }), proc(20, 10, "b", { startedAt: 0 })];
    const groups = groupProcesses(procs, "linux");
    expect(groups).toHaveLength(2);
    expect(groups.map((x) => x.count)).toEqual([1, 1]);
  });

  test("linux: systemd is a boundary, so each service is a root and its workers roll up", () => {
    const procs = [
      proc(1, 0, "systemd", { startedAt: 1 }),
      proc(500, 1, "nginx", { startedAt: 2 }),
      proc(501, 500, "nginx", { startedAt: 3 }),
      proc(600, 1, "sshd", { startedAt: 2 }),
    ];
    const g = byKey(groupProcesses(procs, "linux"));
    expect(g.get("root:500")!.count).toBe(2);
    expect(g.get("root:600")!.count).toBe(1);
    expect(g.get("root:1")!.count).toBe(1);
  });

  test("darwin: launchd boundary + a PPM root labelled PPM even when it is the only member", () => {
    const procs = [proc(1, 0, "launchd", { startedAt: 1 }), proc(300, 1, "bun", { startedAt: 2 })];
    expect(byKey(groupProcesses(procs, "darwin", new Set([300]), 300)).get("root:300")!.label).toBe("PPM (this server)");
    // Without a known self pid the group is still recognisably PPM.
    expect(byKey(groupProcesses(procs, "darwin", new Set([300]))).get("root:300")!.label).toBe("PPM (pid 300)");
  });
});
