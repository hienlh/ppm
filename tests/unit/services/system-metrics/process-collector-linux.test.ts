import { describe, test, expect } from "bun:test";
import { createLinuxProcessCollector, procEntriesToRows } from "../../../../src/services/system-metrics/process-collector-linux.ts";
import type { ProcEntry } from "../../../../src/services/proc-table-linux.ts";

// Shape of readProcTable() output captured from the Docker test container.
const TABLE: ProcEntry[] = [
  { pid: 1, ppid: 0, cpuPercent: 0.1, cpuMs: 1230, rssKB: 10240, elapsedSec: 5000, startedAtMs: 1700000000000, comm: "systemd", args: "/sbin/init" },
  { pid: 2, ppid: 0, cpuPercent: 0, cpuMs: 0, rssKB: 0, elapsedSec: 5000, startedAtMs: 1700000000000, comm: "kthreadd", args: "" },
  { pid: 345, ppid: 1, cpuPercent: 12.5, cpuMs: 98765, rssKB: 204800, elapsedSec: 100, startedAtMs: 1700004900000.7, comm: "bun", args: "bun run src/server/index.ts --token=abc" },
];

describe("procEntriesToRows", () => {
  test("maps /proc fields onto raw rows: comm as name, args as command, rss KB → MB", () => {
    const rows = procEntriesToRows(TABLE);
    expect(rows).toHaveLength(3);
    const bun = rows.find((r) => r.pid === 345)!;
    expect(bun).toEqual({
      pid: 345, ppid: 1, name: "bun", command: "bun run src/server/index.ts --token=abc",
      cpuMs: 98765, ramMB: 200, startedAt: 1700004900001,
    });
  });

  test("kernel threads have no cmdline → command null (the tick falls back to the name)", () => {
    const kthreadd = procEntriesToRows(TABLE).find((r) => r.pid === 2)!;
    expect(kthreadd.command).toBeNull();
    expect(kthreadd.name).toBe("kthreadd");
  });

  test("cpuMs is the cumulative counter the delta needs, not the lifetime average", () => {
    const init = procEntriesToRows(TABLE).find((r) => r.pid === 1)!;
    expect(init.cpuMs).toBe(1230);
  });
});

describe("createLinuxProcessCollector", () => {
  test("wraps the injected reader and never spawns", async () => {
    const c = createLinuxProcessCollector(() => TABLE);
    const r = await c.collect();
    expect(r.rows.map((x) => x.pid)).toEqual([1, 2, 345]);
    expect(r.warnings).toEqual([]);
    expect(r.disk).toBeUndefined();
  });

  test("unreadable /proc → empty rows plus a warning, not a throw", async () => {
    const r = await createLinuxProcessCollector(() => null).collect();
    expect(r.rows).toEqual([]);
    expect(r.warnings[0]).toContain("/proc");
    expect(r.columns).toEqual({ disk: false, gpu: false, net: false });
  });

  test("no /proc/<pid>/io reader and no GPU query → the disk and gpu columns are simply not offered", async () => {
    const r = await createLinuxProcessCollector(() => TABLE, { readIo: () => null }).collect();
    expect(r.columns).toEqual({ disk: false, gpu: false, net: false });
    expect(r.rows[0]!.diskReadBytes).toBeUndefined();
    expect(r.rows[0]!.gpuMemMB).toBeUndefined();
  });

  test("/proc/<pid>/io fills CUMULATIVE bytes; an EACCES pid stays unmeasured beside readable ones", async () => {
    const r = await createLinuxProcessCollector(() => TABLE, {
      // Reading another user's process is EACCES — the normal case unprivileged.
      readIo: (pid) => (pid === 345 ? { readBytes: 4096000, writeBytes: 2093056 } : null),
    }).collect();
    const bun = r.rows.find((x) => x.pid === 345)!;
    expect(bun.diskReadBytes).toBe(4096000);
    expect(bun.diskWriteBytes).toBe(2093056);
    const denied = r.rows.find((x) => x.pid === 1)!;
    expect(denied.diskReadBytes).toBeUndefined();
    expect(denied.diskWriteBytes).toBeUndefined();
    // One readable row is enough to offer the column.
    expect(r.columns).toEqual({ disk: true, gpu: false, net: false });
  });

  test("nvidia compute-apps fills VRAM only; per-process GPU busy has no unprivileged source on Linux", async () => {
    const r = await createLinuxProcessCollector(() => TABLE, {
      readIo: () => null,
      gpuMemory: { isDisabled: () => false, collect: async () => new Map([[345, 512]]) },
    }).collect();
    expect(r.rows.find((x) => x.pid === 345)!.gpuMemMB).toBe(512);
    // A pid the query did not list holds no VRAM — measured, not unknown.
    expect(r.rows.find((x) => x.pid === 1)!.gpuMemMB).toBe(0);
    expect(r.rows.find((x) => x.pid === 345)!.gpuPct).toBeUndefined();
    expect(r.columns).toEqual({ disk: false, gpu: true, net: false });
  });

  test("a failed nvidia query leaves VRAM unmeasured instead of publishing zeros", async () => {
    const r = await createLinuxProcessCollector(() => TABLE, {
      readIo: () => null,
      gpuMemory: { isDisabled: () => true, collect: async () => null },
    }).collect();
    expect(r.rows[0]!.gpuMemMB).toBeUndefined();
    expect(r.columns.gpu).toBe(false);
  });

  test("column availability is sticky: one bad tick must not make the UI drop a column", async () => {
    let readable = true;
    const c = createLinuxProcessCollector(() => TABLE, {
      readIo: () => (readable ? { readBytes: 1, writeBytes: 2 } : null),
    });
    expect((await c.collect()).columns!.disk).toBe(true);
    readable = false;
    const second = await c.collect();
    expect(second.columns!.disk).toBe(true);
    expect(second.rows[0]!.diskReadBytes).toBeUndefined();
  });
});
