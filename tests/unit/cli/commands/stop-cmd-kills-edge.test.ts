/**
 * `ppm stop --kill` / `ppm down` stops the edge forwarder too. The edge is spawned detached so it
 * outlives an upgrade's self-replace, which also means the supervisor's death never takes it down:
 * measured on 23/11/2026, `ppm stop --kill` reported the supervisor and tunnel stopped while the
 * edge kept the public port, and the next `ppm start` retried four times before reclaiming it.
 *
 * Same harness as `stop-cmd-ordered-stop-note.test.ts`: a scratch PPM_HOME and stand-in processes
 * this test spawned, whose PIDs are the only ones in status.json.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { _resetPpmDir, getPpmDir, isIsolatedPpmHome } from "../../../../src/services/ppm-dir.ts";
import { stopServer } from "../../../../src/cli/commands/stop.ts";

const originalHome = process.env.PPM_HOME;
const dirs: string[] = [];
const children: Subprocess[] = [];
const quiet = { log: console.log, error: console.error };

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-stop-edge-"));
  dirs.push(home);
  process.env.PPM_HOME = home;
  _resetPpmDir();
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = quiet.log;
  console.error = quiet.error;
  for (const c of children.splice(0)) { try { c.kill(); } catch { /* already gone */ } }
});

afterAll(() => {
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
});

function standIn(): Subprocess {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}

describe("ppm stop --kill", () => {
  it("stops the edge forwarder named in status.json", async () => {
    expect(isIsolatedPpmHome()).toBe(true);
    const server = standIn();
    const edge = standIn();
    writeFileSync(join(getPpmDir(), "status.json"), JSON.stringify({ pid: server.pid, edgePid: edge.pid }));

    await stopServer({ kill: true });

    // Killed, not left running (each await would time the test out otherwise).
    await edge.exited;
    await server.exited;
  }, 30_000);

  it("stops an edge left on its own after the rest of PPM died", async () => {
    const edge = standIn();
    writeFileSync(join(getPpmDir(), "status.json"), JSON.stringify({ edgePid: edge.pid }));

    await stopServer({ kill: true });

    await edge.exited;
  }, 30_000);
});
