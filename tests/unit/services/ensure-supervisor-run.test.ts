import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * One real watchdog run against a scratch PPM folder whose `status.json` names a live supervisor
 * (this test process, a `bun`). Only the "running" path is exercised end to end: every other
 * decision would start PPM, and that is `decideEnsure`'s table to test, not a test's to do.
 */
describe("runEnsureSupervisor", () => {
  const prev = process.env.PPM_HOME;
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ensure-run-"));
    process.env.PPM_HOME = dir;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.PPM_HOME; else process.env.PPM_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a live supervisor alone, opens nothing, and marks the boot handled", async () => {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ supervisorPid: process.pid, state: "running" }));
    const { runEnsureSupervisor } = await import("../../../src/services/supervisor-watchdog/ensure-supervisor.ts");
    const before = Date.now();
    expect(await runEnsureSupervisor()).toEqual({ action: "none", reason: "running" });
    const state = JSON.parse(readFileSync(join(dir, "watchdog-state.json"), "utf-8"));
    expect(state.starts).toEqual([]);
    expect(state.bootHandledAt).toBeGreaterThanOrEqual(before);
  });
});
