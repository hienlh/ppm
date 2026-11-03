/**
 * The mode belongs to the running PPM. Two commands act on a PPM already running, and both run
 * here for real against a PPM directory of their own:
 *
 * - `ppm restart` with no supervisor in status.json starts the replacement server itself, from a
 *   worker it writes out. status.json keeps saying `minimalMode: true` whatever that server is,
 *   so one brought back full is reported as minimal by `ppm status` and `/api/info` while every
 *   hidden feature is live again.
 * - `ppm start` in the other mode must refuse, say how to switch, and exit: it once printed
 *   the refusal and then never returned.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RESTART = resolve(import.meta.dir, "../../../src/cli/commands/restart.ts");
const SERVER = resolve(import.meta.dir, "../../../src/server/index.ts");

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** A PPM directory and environment of its own; never the service manager's variables. */
function scratchPpm(): { home: string; env: Record<string, string | undefined> } {
  const home = mkdtempSync(join(tmpdir(), "ppm-mode-lifecycle-"));
  const { INVOCATION_ID: _invocation, NOTIFY_SOCKET: _socket, ...inherited } = process.env;
  return {
    home,
    env: { ...inherited, PPM_HOME: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") },
  };
}

/** Runs `code` in a child; one still running after `deadlineMs` is killed and answers exit 137. */
async function run(code: string, env: Record<string, string | undefined>, deadlineMs = 25_000) {
  const proc = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => proc.kill("SIGKILL"), deadlineMs);
  const [exit, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(deadline);
  return { exit, out, err };
}

/** Restarts a "running" PPM whose status.json says `minimalMode`; answers the new server's argv. */
async function restartArgs(minimalMode: boolean): Promise<string[]> {
  const { home, env } = scratchPpm();
  const startedFile = join(home, "started.json");
  const port = await freePort();
  const standIn = join(home, "stand-in-server.ts");
  writeFileSync(standIn, [
    `require("node:fs").writeFileSync(${JSON.stringify(startedFile)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }));`,
    `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) });`,
  ].join("\n"));
  const running = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)"]);
  writeFileSync(join(home, "status.json"), JSON.stringify({ pid: running.pid, port, host: "127.0.0.1", serverScript: standIn, minimalMode }));
  try {
    const result = await run(`await (await import(${JSON.stringify(RESTART)})).restartServer({});`, env);
    expect(result).toMatchObject({ exit: 0, out: expect.stringContaining("Restart complete") });
    return (JSON.parse(readFileSync(startedFile, "utf-8")) as { argv: string[] }).argv;
  } finally {
    running.kill();
    // Its own record, not status.json's: the worker's status rewrite never lands (it calls a
    // `renameSync` it does not import, inside a `catch {}`).
    try { process.kill((JSON.parse(readFileSync(startedFile, "utf-8")) as { pid: number }).pid); } catch { /* never started */ }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** `ppm start` (in `minimal` mode or not) while a supervisor runs PPM in the other mode. */
async function startAgainst(runningMinimal: boolean, minimal: boolean) {
  const { home, env } = scratchPpm();
  const supervisor = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)"]);
  writeFileSync(join(home, "status.json"), JSON.stringify({ supervisorPid: supervisor.pid, minimalMode: runningMinimal, state: "running" }));
  try {
    const result = await run(`await (await import(${JSON.stringify(SERVER)})).startServer({ minimal: ${minimal} });`, env);
    return { ...result, supervisorAlive: supervisor.exitCode === null && !supervisor.killed };
  } finally {
    supervisor.kill();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

describe("the mode belongs to the running PPM", () => {
  it("a legacy ppm restart brings a minimal PPM back minimal, and a full one back full", async () => {
    expect(await restartArgs(true)).toEqual(["__serve__", "0", "127.0.0.1", "--minimal"]);
    expect(await restartArgs(false)).toEqual(["__serve__", "0", "127.0.0.1"]);
  }, 60_000);

  it("ppm start in the other mode refuses, says how to switch, and exits without touching the supervisor", async () => {
    const toMinimal = await startAgainst(false, true);
    expect(toMinimal).toMatchObject({ exit: 1, supervisorAlive: true });
    expect(toMinimal.err).toContain("PPM is already running in full mode.");
    expect(toMinimal.err).toContain("ppm down && ppm start --minimal");

    const toFull = await startAgainst(true, false);
    expect(toFull).toMatchObject({ exit: 1, supervisorAlive: true });
    expect(toFull.err).toContain("PPM is already running in minimal mode.");
    expect(toFull.err).toMatch(/ppm down && ppm start$/m);
  }, 60_000);
});
