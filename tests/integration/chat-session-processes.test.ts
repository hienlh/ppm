/**
 * Against the real systemd user manager: commands of a chat land in its session slice, and the
 * sweeps stop what they should and nothing else. Skipped where `systemd-run --user --scope` does
 * not work (macOS, Windows, a CI runner with no user manager).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPpmDir } from "../../src/services/ppm-dir.ts";
import {
  chatSessionCliEnv, initChatSessionProcesses, registerLeftoverSweeper, stopChatSessionProcesses, stopCommandScopesSync,
  sweepLeftovers, type SweepDeps,
} from "../../src/services/chat-session-processes/session-processes.service.ts";
import { instanceSliceName, instanceTag, sessionSliceName } from "../../src/services/chat-session-processes/session-slice.ts";

function userScopesWork(): boolean {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return false;
  try {
    return Bun.spawnSync(["systemd-run", "--user", "--scope", "--quiet", "--collect", "--", "true"]).exitCode === 0;
  } catch {
    return false;
  }
}

const MIN = 60_000;

describe.skipIf(!userScopesWork())("chat session processes under systemd", () => {
  let idleMinutes = 30;
  let instance = "";
  const busy = new Set<string>();
  const stopped: { sessionId: string; summary: string }[] = [];
  const deps: SweepDeps = {
    activity: (sessionId) => ({ busy: busy.has(sessionId) }),
    onStopped: (sessionId, summary) => stopped.push({ sessionId, summary }),
  };
  const held: ReturnType<typeof Bun.spawn>[] = [];
  const otherSlices: string[] = [];
  let unregister = () => {};

  beforeAll(async () => {
    const dbPath = join(getPpmDir(), `ppm-${crypto.randomUUID()}.db`);
    instance = instanceTag(dbPath);
    expect(await initChatSessionProcesses({ dbPath, idleMinutes: () => idleMinutes })).toBe(true);
    unregister = registerLeftoverSweeper(deps);
  });

  afterAll(() => {
    // Routing off for whatever runs next in this process, then nothing of ours left behind.
    idleMinutes = 0;
    unregister();
    for (const p of held) p.kill("SIGKILL");
    Bun.spawnSync(["systemctl", "--user", "stop", instanceSliceName(instance), ...otherSlices]);
  });

  const envOf = (sessionId: string) => ({ ...chatSessionCliEnv(sessionId, process.env), CLAUDE_CODE_SHELL: "/bin/bash" });

  /** Runs `command` the way the CLI runs a Bash tool call: one argument to the shell prefix. */
  function runAsCli(sessionId: string, command: string): string {
    const env = envOf(sessionId);
    expect(env.CLAUDE_CODE_SHELL_PREFIX).toBeDefined();
    const res = Bun.spawnSync([env.CLAUDE_CODE_SHELL_PREFIX!, command], { env });
    expect(res.exitCode).toBe(0);
    return res.stdout.toString().trim();
  }

  /** A command that leaves a process running after it returns, like `npm run dev &`. */
  const leave = (sessionId: string) => Number(runAsCli(sessionId, "sleep 300 >/dev/null 2>&1 </dev/null & echo $!"));

  /** A command still running, held by "the CLI" (this process). */
  async function hold(sessionId: string): Promise<number> {
    const env = envOf(sessionId);
    const proc = Bun.spawn([env.CLAUDE_CODE_SHELL_PREFIX!, "sleep 300"], { env, stdout: "ignore", stderr: "ignore" });
    held.push(proc);
    const slice = sessionSliceName(instance, sessionId)!;
    expect(await until(() => cgroupOf(proc.pid).includes(`/${slice}/`))).toBe(true);
    return proc.pid;
  }

  /** A unit the agent made itself, through the `systemd-run` it finds on PATH. */
  function agentUnit(sessionId: string): string {
    const unit = `ppm-test-agent-${crypto.randomUUID().slice(0, 8)}.service`;
    runAsCli(sessionId, `systemd-run --user --quiet --unit=${unit} -- sleep 300`);
    return unit;
  }

  const unitActive = (unit: string) =>
    Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", unit]).exitCode === 0;

  it("runs each command in a scope of its own under its session's slice", () => {
    const sessionId = crypto.randomUUID();
    const pid = leave(sessionId);
    expect(cgroupOf(pid)).toMatch(new RegExp(
      `/app-ppmchat\\.slice/${instanceSliceName(instance)}/${sessionSliceName(instance, sessionId)}/ppmcmd-[0-9a-f-]{36}\\.scope$`,
    ));
  });

  it("puts a unit the agent starts itself into the session's slice, unless it names a slice", () => {
    const sessionId = crypto.randomUUID();
    const unit = agentUnit(sessionId);
    const slice = Bun.spawnSync(["systemctl", "--user", "show", "-p", "Slice", "--value", unit]).stdout.toString().trim();
    expect(slice).toBe(sessionSliceName(instance, sessionId)!);

    const kept = `ppm-test-kept-${crypto.randomUUID().slice(0, 8)}.service`;
    runAsCli(sessionId, `systemd-run --user --quiet --slice=app.slice --unit=${kept} -- sleep 300`);
    otherSlices.push(kept);
    expect(Bun.spawnSync(["systemctl", "--user", "show", "-p", "Slice", "--value", kept]).stdout.toString().trim()).toBe("app.slice");
  });

  it("an idle sweep stops what the session left running, never a command still running", async () => {
    const sessionId = crypto.randomUUID();
    const leftover = leave(sessionId);
    const unit = agentUnit(sessionId);
    const live = await hold(sessionId);

    const t0 = Date.now();
    sweepLeftovers(deps, "idle", t0);
    sweepLeftovers(deps, "idle", t0 + 29 * MIN);
    await Bun.sleep(300);
    expect(running(leftover)).toBe(true);

    sweepLeftovers(deps, "idle", t0 + 30 * MIN);
    expect(await until(() => !running(leftover) && !unitActive(unit))).toBe(true);
    expect(running(live)).toBe(true);
    const note = stopped.find((s) => s.sessionId === sessionId)!;
    expect(note.summary).toContain("after 30 idle minutes");
    expect(note.summary).toContain(unit);
  });

  it("leaves a busy session's processes alone however long it has been", async () => {
    const sessionId = crypto.randomUUID();
    busy.add(sessionId);
    const leftover = leave(sessionId);
    const t0 = Date.now();
    sweepLeftovers(deps, "idle", t0);
    sweepLeftovers(deps, "idle", t0 + 600 * MIN);
    await Bun.sleep(300);
    expect(running(leftover)).toBe(true);
  });

  it("never touches the sessions of another PPM", async () => {
    const other = instanceTag(`/elsewhere/${crypto.randomUUID()}.db`);
    const slice = sessionSliceName(other, crypto.randomUUID())!;
    otherSlices.push(instanceSliceName(other));
    const res = Bun.spawnSync([
      "systemd-run", "--user", "--scope", "--quiet", "--collect", `--slice=${slice}`, "--",
      "sh", "-c", "sleep 300 >/dev/null 2>&1 </dev/null & echo $!",
    ]);
    const pid = Number(res.stdout.toString().trim());
    expect(cgroupOf(pid)).toContain(`/${slice}/`);

    const t0 = Date.now();
    sweepLeftovers(deps, "idle", t0);
    sweepLeftovers(deps, "idle", t0 + 600 * MIN);
    sweepLeftovers(deps, "startup");
    stopCommandScopesSync();
    await Bun.sleep(300);
    expect(running(pid)).toBe(true);
  });

  it("after a restart stops only what commands left, as a restart always did", async () => {
    const sessionId = crypto.randomUUID();
    const leftover = leave(sessionId);
    const unit = agentUnit(sessionId);
    sweepLeftovers(deps, "startup");
    expect(await until(() => !running(leftover))).toBe(true);
    expect(unitActive(unit)).toBe(true);
  });

  it("on shutdown stops the chats' commands, running or left, and keeps the agents' own units", async () => {
    const sessionId = crypto.randomUUID();
    const leftover = leave(sessionId);
    const live = await hold(sessionId);
    const unit = agentUnit(sessionId);
    stopCommandScopesSync();
    expect(await until(() => !running(leftover) && !running(live))).toBe(true);
    expect(unitActive(unit)).toBe(true);
  });

  it("on shutdown stops every other command when one scope it listed is gone already", async () => {
    const sessionId = crypto.randomUUID();
    const leftover = leave(sessionId);
    const live = await hold(sessionId);
    const gone = goneScope(live);
    try {
      stopCommandScopesSync();
      expect(await until(() => !running(leftover) && !running(live), 3_000)).toBe(true);
    } finally {
      rmdirSync(gone);
    }
  });

  it("an idle sweep stops every other leftover when one unit it saw is gone already", async () => {
    const sessionId = crypto.randomUUID();
    const leftover = leave(sessionId);
    const orphan = leave(sessionId);
    const gone = goneScope(orphan);
    writeFileSync(join(gone, "cgroup.procs"), String(orphan));
    try {
      const t0 = Date.now();
      sweepLeftovers(deps, "idle", t0);
      sweepLeftovers(deps, "idle", t0 + 30 * MIN);
      expect(await until(() => !running(leftover), 3_000)).toBe(true);
    } finally {
      process.kill(orphan, "SIGKILL");
      await until(() => !running(orphan));
      rmdirSync(gone);
    }
  });

  it("deleting a session stops everything it started, running or not", async () => {
    const sessionId = crypto.randomUUID();
    const leftover = leave(sessionId);
    const unit = agentUnit(sessionId);
    const live = await hold(sessionId);
    stopChatSessionProcesses(sessionId);
    expect(await until(() => !running(leftover) && !running(live) && !unitActive(unit))).toBe(true);
    expect(stopped.find((s) => s.sessionId === sessionId)?.summary).toContain("as it was deleted");
  });
});

function cgroupOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::"))?.slice(3) ?? "";
  } catch {
    return "";
  }
}

/**
 * A command scope that cgroupfs still lists but systemd has no unit for, which is what a command
 * ending between a listing and the stop leaves: made beside `pid`'s scope, in its session slice.
 */
function goneScope(pid: number): string {
  const dir = join(`/sys/fs/cgroup${dirname(cgroupOf(pid))}`, `ppmcmd-${crypto.randomUUID()}.scope`);
  mkdirSync(dir);
  return dir;
}

/** Alive and not a zombie waiting to be reaped. */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(50);
  }
  return cond();
}
