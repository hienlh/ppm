import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runEnsureSupervisor } from "../../../src/services/supervisor-watchdog/ensure-supervisor.ts";

/**
 * Real watchdog runs against a scratch PPM folder passed in explicitly (`getPpmDir` caches the
 * first folder a test process asked for, so relying on `PPM_HOME` here once read another file's
 * folder and went down the start path for real). The start and the give-up notice are replaced by
 * recorders: a run may decide to start PPM, it may never actually do it from a test.
 */
describe("runEnsureSupervisor", () => {
  let dir = "";
  const started: string[] = [];
  const opts = () => ({
    ppmDir: dir,
    start: async (_dir: string, _status: unknown, d: { why: string }) => { started.push(d.why); },
    notifyGaveUp: async () => { throw new Error("must not notify from a test"); },
  });
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ensure-run-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("leaves a live supervisor alone and marks the boot handled", async () => {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ supervisorPid: process.pid, state: "running" }));
    const before = Date.now();
    expect(await runEnsureSupervisor(opts())).toEqual({ action: "none", reason: "running" });
    const state = JSON.parse(readFileSync(join(dir, "watchdog-state.json"), "utf-8"));
    expect(state.starts).toEqual([]);
    expect(state.bootHandledAt).toBeGreaterThanOrEqual(before);
    expect(started).toEqual([]);
  });

  it("asks to start PPM when the recorded supervisor is gone, and records the start", async () => {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ supervisorPid: 2 ** 30, state: "running" }));
    const d = await runEnsureSupervisor(opts());
    expect(d.action).toBe("start");
    expect(started).toEqual(["died"]);
    expect(JSON.parse(readFileSync(join(dir, "watchdog-state.json"), "utf-8")).starts.length).toBe(1);
    expect(readFileSync(join(dir, "ppm.log"), "utf-8")).toContain("its last run did not stop");
  });

  it("does nothing once PPM was taken down (no status) and the boot is handled", async () => {
    rmSync(join(dir, "status.json"));
    expect(await runEnsureSupervisor(opts())).toEqual({ action: "none", reason: "not-wanted" });
    expect(started).toEqual(["died"]);
  });
});
