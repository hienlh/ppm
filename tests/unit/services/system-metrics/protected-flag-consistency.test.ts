import { describe, test, expect } from "bun:test";
import { buildProcessRows } from "../../../../src/services/system-metrics/process-rows-builder.ts";
import { checkKillAllowed } from "../../../../src/services/system-metrics/kill-guard.ts";
import { raw } from "./fixtures/process-fixtures.ts";

// The disabled button (ProcessInfo.protected) and the 403 (checkKillAllowed)
// must come from ONE rule source. This fixture crosses every rule: kernel,
// critical names, the PPM server, its ancestors, its descendants, siblings.
const ROWS = [
  raw(4, 0, "System", { startedAt: 1 }),
  raw(700, 4, "wininit", { startedAt: 3 }),
  raw(800, 700, "services", { startedAt: 4 }),
  raw(900, 800, "svchost", { startedAt: 5 }),
  raw(1000, 700, "explorer", { startedAt: 7 }),
  raw(2000, 1000, "WindowsTerminal", { startedAt: 8 }),
  raw(3000, 2000, "bun", { startedAt: 10 }),
  raw(3100, 3000, "bun", { startedAt: 11, command: "bun src/server/index.ts --token=abc" }),
  raw(3200, 3100, "node", { startedAt: 12, cpuMs: 500 }),
  raw(4000, 1000, "chrome", { startedAt: 20 }),
  raw(5000, -1, "Orphan"),
];

describe("protected flag ↔ kill guard consistency", () => {
  const built = buildProcessRows({
    rows: ROWS,
    platform: "win32",
    coreCount: 8,
    now: 10_000,
    prevCpu: null,
    prevIo: null,
    resolveProtected: () => ({ pids: new Set([3100, 3000]), roots: new Set([3100, 3000]), selfPid: 3100 }),
  });

  test("every ProcessInfo.protected equals !checkKillAllowed(pid, name, tree:false).allowed for the same context", () => {
    for (const p of built.processes) {
      const verdict = checkKillAllowed({ pid: p.pid, name: p.name }, false, built.guardCtx);
      expect(p.protected).toBe(!verdict.allowed);
    }
  });

  test("the expected split: OS + PPM + ancestors protected, descendants and siblings not", () => {
    const protectedPids = built.processes.filter((p) => p.protected).map((p) => p.pid).sort((a, b) => a - b);
    expect(protectedPids).toEqual([4, 700, 800, 900, 1000, 2000, 3000, 3100]);
  });

  test("ppm flag covers roots + descendants only, and the command is redacted", () => {
    const ppm = built.processes.filter((p) => p.ppm).map((p) => p.pid).sort((a, b) => a - b);
    expect(ppm).toEqual([3000, 3100, 3200]);
    expect(built.processes.find((p) => p.pid === 3100)!.command).not.toContain("abc");
    expect(built.processes.find((p) => p.pid === 900)!.command).toBe("svchost");
  });

  test("first tick CPU is 0 everywhere and the next state carries the baseline", () => {
    expect(built.processes.every((p) => p.cpu === 0)).toBe(true);
    expect(built.nextCpu.byKey.get("3200:12")).toBe(500);
  });
});
