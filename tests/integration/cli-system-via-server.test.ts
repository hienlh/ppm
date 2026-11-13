/**
 * `ppm system` through a running PPM: the real Task Manager and Services routes, the real metrics
 * service and kill chain, over a stand-in process table and service manager — the executors only
 * record, so no real process or service on the machine is ever touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { rmSync } from "node:fs";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
const target = () => `→ PPM default (ppm.db) at 127.0.0.1:${server.port}`;
const streams = () => server.scratch<number>("streams");
const kills = () => server.scratch<Array<Record<string, unknown>>>("kills");

async function cli(args: string[], env: Record<string, string> = {}) {
  const r = await runCli(home, args, env);
  // Whatever the command did, it left no subscriber on the metrics stream.
  expect({ args, streams: await streams() }).toEqual({ args, streams: 0 });
  return r;
}

async function ok(args: string[], env: Record<string, string> = {}) {
  const r = await cli(args, env);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ args, code: 0 });
  return r;
}

async function refused(args: string[], message: string, env: Record<string, string> = {}) {
  const r = await cli(args, env);
  expect({ args, code: r.code }).toEqual({ args, code: 1 });
  expect(r.stderr).toContain(message);
  return r;
}

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null, undefined, "cli-system-scratch-server-main.ts");
}, 60_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm system processes and resources", () => {
  it("lists processes by memory from one sample, without a CPU column", async () => {
    const r = await ok(["system", "processes"]);
    expect(r.stderr).toContain(target());
    expect(r.stdout).toContain("stand-in-server.js");
    expect(r.stdout).not.toContain("CPU %");
    const json = JSON.parse((await ok(["system", "processes", "--json", "-n", "2"])).stdout) as { cpuMeasured: boolean; processes: Array<{ pid: number }> };
    expect(json.cpuMeasured).toBe(false);
    expect(json.processes.map((p) => p.pid)).toEqual([4242, 4444]);
  }, 60_000);

  it("sorts by CPU only from a second sample, where the busy process has a figure", async () => {
    const json = JSON.parse((await ok(["system", "processes", "--sort", "cpu", "--json"])).stdout) as { cpuMeasured: boolean; processes: Array<{ pid: number; cpu: number }> };
    expect(json.cpuMeasured).toBe(true);
    expect(json.processes[0]!.pid).toBe(4343);
    expect(json.processes[0]!.cpu).toBeGreaterThan(0);
    const filtered = JSON.parse((await ok(["system", "processes", "--filter", "stand-in", "--json"])).stdout) as { processes: Array<{ pid: number }> };
    expect(filtered.processes.map((p) => p.pid)).toEqual([4242]);
  }, 60_000);

  it("shows one process's details and the machine's summary", async () => {
    expect((await ok(["system", "process", "4242"])).stdout).toContain("/srv/app");
    await refused(["system", "process", "9999"], "PID 9999 is no longer running");
    const summary = JSON.parse((await ok(["system", "resources", "--json"])).stdout) as { cpu: { cores: number[] }; mem: { totalMB: number } };
    expect(summary.cpu.cores.length).toBeGreaterThan(0);
    expect(summary.mem.totalMB).toBeGreaterThan(0);
  }, 60_000);
});

describe("ppm system kill and signal", () => {
  it("a wrong --expect-name kills nothing; the right one goes through the guard", async () => {
    const before = (await kills()).length;
    await refused(["system", "kill", "4242", "--expect-name", "vim"], 'PID 4242 is "node", not "vim"');
    expect((await kills()).length).toBe(before);
    const r = await ok(["system", "kill", "4242", "--expect-name", "node"]);
    expect(r.stdout).toContain("Ended node (PID 4242)");
    expect((await kills()).slice(before)).toEqual([{ kind: "kill", pid: 4242, tree: false }]);
  }, 60_000);

  it("--force sends KILL, signal sends the named one, and PPM's own process is refused verbatim", async () => {
    const before = (await kills()).length;
    await ok(["system", "kill", "4242", "--force"]);
    await ok(["system", "signal", "4343", "sigstop", "--tree"]);
    expect((await kills()).slice(before)).toEqual([
      { kind: "signal", pid: 4242, signal: "KILL", tree: false },
      { kind: "signal", pid: 4343, signal: "STOP", tree: true },
    ]);
    await refused(["system", "kill", "4100"], "is a PPM process and cannot be ended");
    await refused(["system", "signal", "4242", "BOGUS"], "Signal must be one of");
  }, 60_000);

  it("from an AI chat: --expect-name is required, and a chat's provider is refused with 'use chat_stop'", async () => {
    const ai = { PPM_AI_CHAT: "1" };
    const before = (await kills()).length;
    await refused(["system", "kill", "4242"], "--expect-name", ai);
    await server.scratch("register-provider", { pid: 4444 });
    await refused(["system", "kill", "4444", "--expect-name", "claude"], "use chat_stop", ai);
    await refused(["system", "signal", "4444", "STOP", "--expect-name", "claude"], "use chat_stop", ai);
    expect((await kills()).length).toBe(before);
    // A person in a terminal can still end it, as from the Task Manager.
    await ok(["system", "kill", "4444"]);
    expect((await kills()).slice(before)).toEqual([{ kind: "kill", pid: 4444, tree: false }]);
  }, 60_000);
});

describe("ppm system services", () => {
  it("lists, filters by scope, and shows a unit with its log", async () => {
    const all = JSON.parse((await ok(["system", "services", "--json"])).stdout) as { services: Array<{ unit: string }> };
    expect(all.services.map((s) => s.unit)).toEqual(["demo.service", "ppm.service", "sync.service"]);
    const user = JSON.parse((await ok(["system", "services", "--user", "--json"])).stdout) as { services: Array<{ unit: string }> };
    expect(user.services.map((s) => s.unit)).toEqual(["sync.service"]);
    const shown = await ok(["system", "service", "demo.service", "--log"]);
    expect(shown.stdout).toContain("/etc/systemd/system/demo.service");
    expect(shown.stdout).toContain("demo.service started");
    await refused(["system", "service", "nope.service"], "No unit named nope.service");
  }, 60_000);

  it("runs an action through the route, and prints a refusal verbatim", async () => {
    await ok(["system", "service", "restart", "demo.service"]);
    await ok(["system", "service", "enable", "sync.service", "--user"]);
    expect(await server.scratch("service-actions")).toEqual([
      { unit: "demo.service", scope: "system", action: "restart" },
      { unit: "sync.service", scope: "user", action: "enable" },
    ]);
    await refused(["system", "service", "stop", "ppm.service"], "PPM's own unit cannot be stopped from here");
    await refused(["system", "service", "explode", "demo.service"], "Action must be one of");
  }, 60_000);
});

describe("without a running PPM", () => {
  it("says the Task Manager needs one instead of reading the process table itself", async () => {
    const empty = scratchHome();
    try {
      const r = await runCli(empty, ["system", "processes"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("The Task Manager and the Services page live in the running PPM");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 60_000);
});
