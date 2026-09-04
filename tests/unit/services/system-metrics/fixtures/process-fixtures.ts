/** Builders for ProcessInfo / RawProcessRow fixtures shared by the grouping,
 *  guard and ownership tests. Names are extension-free per the contract. */
import type { ProcessInfo } from "../../../../../src/types/system-metrics.ts";
import type { RawProcessRow } from "../../../../../src/services/system-metrics/process-collector-types.ts";

export function proc(pid: number, ppid: number, name: string, extra: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid, ppid, name, command: name, cpu: 0, ramMB: 10, startedAt: 1_000_000 + pid, ppm: false, protected: false, ...extra,
  };
}

export function raw(pid: number, ppid: number, name: string, extra: Partial<RawProcessRow> = {}): RawProcessRow {
  return { pid, ppid, name, command: null, cpuMs: 0, ramMB: 10, startedAt: 1_000_000 + pid, ...extra };
}

/** Dev-host Windows chain: explorer → WindowsTerminal → bun(run) → bun(server) → node → bash.
 *  Plus a Chrome tree parented by explorer, `services` → `svchost` → RuntimeBroker, and the kernel. */
export const WIN_DEV_HOST: ProcessInfo[] = [
  proc(4, 0, "System", { startedAt: 1 }),
  proc(600, 4, "smss", { startedAt: 2 }),
  proc(700, 600, "wininit", { startedAt: 3 }),
  proc(800, 700, "services", { startedAt: 4 }),
  proc(900, 800, "svchost", { startedAt: 5 }),
  proc(950, 900, "RuntimeBroker", { startedAt: 6 }),
  proc(1000, 700, "explorer", { startedAt: 7 }),
  proc(2000, 1000, "WindowsTerminal", { startedAt: 8 }),
  proc(2100, 2000, "pwsh", { startedAt: 9 }),
  proc(3000, 2000, "bun", { startedAt: 10, command: "bun run dev:server" }),
  proc(3100, 3000, "bun", { startedAt: 11, command: "bun src/server/index.ts" }),
  proc(3200, 3100, "node", { startedAt: 12, cpu: 5 }),
  proc(3300, 3200, "bash", { startedAt: 13, cpu: 1 }),
  proc(4000, 1000, "chrome", { startedAt: 20, cpu: 2, ramMB: 300 }),
  proc(4001, 4000, "chrome", { startedAt: 21, cpu: 3, ramMB: 200 }),
  proc(4002, 4000, "chrome", { startedAt: 22, cpu: 1, ramMB: 100 }),
  proc(5000, -1, "OrphanApp"),
];

export const WIN_SERVER_PID = 3100;
export const WIN_RUN_PID = 3000;
