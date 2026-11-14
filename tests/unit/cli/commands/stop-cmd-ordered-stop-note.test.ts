/**
 * `ppm stop --kill` / `ppm down` / `ppm stop --all` (and `ppm restart`'s dead-supervisor recovery,
 * which calls the same `stopServer({ kill: true })`) leave the next server start a note that the
 * stop was ordered, before killing anything. On Windows these kills are TerminateProcess, so the
 * supervisor's own shutdown — which writes the note on POSIX — never runs, and the next start used
 * to read the stop as "did not shut down cleanly".
 *
 * Runs against a scratch PPM_HOME with a stand-in "server" process the test spawned itself: the
 * PIDs in status.json are the only ones `stopServer` is handed, and an isolated home skips the
 * service-manager and kill-by-name paths, so nothing outside this test can be touched.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { _resetPpmDir, getPpmDir, isIsolatedPpmHome } from "../../../../src/services/ppm-dir.ts";
import { stopServer } from "../../../../src/cli/commands/stop.ts";
import { takeOrderedStop } from "../../../../src/services/restart-news/ordered-stop-note.ts";

const originalHome = process.env.PPM_HOME;
const dirs: string[] = [];
const children: Subprocess[] = [];
const quiet = { log: console.log, error: console.error };

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-stop-note-"));
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

/** A process standing in for the server: alive until something kills it. */
function standInServer(): Subprocess {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}

const writeStatus = (status: Record<string, unknown>) =>
  writeFileSync(join(getPpmDir(), "status.json"), JSON.stringify(status));
const notePath = (pid: number) => join(getPpmDir(), `.server-stop.${pid}.json`);

describe("ppm stop --kill writes the ordered-stop note", () => {
  it("for the running server, before killing it, where the next start looks", async () => {
    expect(isIsolatedPpmHome()).toBe(true);
    const server = standInServer();
    writeStatus({ pid: server.pid });

    await stopServer({ kill: true });

    await server.exited; // killed, not left running (the test would time out otherwise)
    const note = JSON.parse(readFileSync(notePath(server.pid), "utf8")) as { pid: number; why: string; at: number };
    expect(note).toMatchObject({ pid: server.pid, why: "ppm stop --kill or ppm down" });
    // The next start of this database matches it against its previous run and names the stop.
    expect(takeOrderedStop(getPpmDir(), { pid: server.pid, startedAt: note.at - 60_000 })).toBe("ppm stop --kill or ppm down");
  }, 30_000);

  it("not for a server that had already died: that stop was a crash and must read as one", async () => {
    const server = standInServer();
    server.kill();
    await server.exited;
    writeStatus({ pid: server.pid });

    await stopServer({ kill: true });

    expect(existsSync(notePath(server.pid))).toBe(false);
  }, 30_000);

  it("ppm stop --all writes it too", async () => {
    const server = standInServer();
    writeStatus({ pid: server.pid });

    await stopServer({ all: true });

    await server.exited;
    expect(JSON.parse(readFileSync(notePath(server.pid), "utf8"))).toMatchObject({ pid: server.pid, why: "ppm stop --all" });
  }, 30_000);
});
