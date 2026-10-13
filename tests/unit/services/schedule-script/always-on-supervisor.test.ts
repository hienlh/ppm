import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { deleteSchedule, getSchedule, insertSchedule, listScheduleRuns, updateSchedule } from "../../../../src/services/scheduler-db.service.ts";
import { AlwaysOnSupervisor, BACKOFF_MS, HEARTBEAT_TIMEOUT_MS, STABLE_MS, type Clock } from "../../../../src/services/schedule-script/always-on-supervisor.ts";
import { isAlive, liveScript } from "../../../../src/services/schedule-script/instance-guard.ts";
import { removeRunDir } from "../../../../src/services/schedule-script/script-files.ts";
import { launchScript, type Launch, type Launched } from "../../../../src/services/schedule-script/script-launch.ts";
import { LogRing, logRing, RunLog } from "../../../../src/services/schedule-script/script-log.ts";
import type { ScriptExit } from "../../../../src/services/schedule-script/script-process.ts";
import { recordSpawn } from "../../../../src/services/schedule-script/script-runtime-db.ts";
import type { Schedule } from "../../../../src/types/scheduler.ts";

let projectDir = "";
let previousProjects: unknown;
beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ppm-always-on-"));
  previousProjects = configService.get("projects");
  configService.set("projects", [{ name: "demo", path: projectDir }]);
});
afterAll(() => {
  configService.set("projects", previousProjects as never);
  rmSync(projectDir, { recursive: true, force: true });
});

function makeAlwaysOn(script = "export default async (ctx) => { await ctx.sleep(3_600_000); }"): number {
  return insertSchedule({
    name: "daemon", cron_expr: "", provider_id: "mock", project_path: projectDir, prompt: "",
    kind: "script", mode: "always-on", script,
  });
}

async function waitFor(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A clock whose timers run only when the test says so. */
function fakeClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; delay: number; fn: () => void; cancelled: boolean }> = [];
  const clock: Clock = {
    now: () => now,
    after: (ms, fn) => {
      const timer = { at: now + ms, delay: ms, fn, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  };
  return {
    clock,
    delays: () => timers.map((t) => t.delay),
    advance(ms: number) {
      now += ms;
      for (const t of timers) if (!t.cancelled && t.at <= now) { t.cancelled = true; t.fn(); }
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
  };
}

/** Processes that do nothing, and exit when the test (or a stop) says so. */
function fakeLaunch() {
  const launched: Array<{ schedule: Schedule; opts: unknown; exit: (e: Partial<ScriptExit>) => void; stops: string[] }> = [];
  let failWith: string | null = null;
  const launch: Launch = (schedule, opts) => {
    if (failWith) return { error: failWith };
    let resolve!: (e: ScriptExit) => void;
    const exited = new Promise<ScriptExit>((r) => { resolve = r; });
    const stops: string[] = [];
    const exit = (e: Partial<ScriptExit>) => resolve({ code: 0, finished: true, error: null, state: null, stopReason: null, ...e });
    const child = {
      pid: 40_000 + launched.length, exited,
      stop: (reason: string) => { stops.push(reason); exit({ stopReason: reason }); return exited; },
      kill: () => exit({ code: null, finished: false }),
    };
    launched.push({ schedule, opts, exit, stops });
    return { child, log: new RunLog(new LogRing(), (t) => t), mask: (t) => t, costUsd: () => 0 } as unknown as Launched;
  };
  return { launch, launched, fail: (error: string | null) => { failWith = error; } };
}

const flush = () => Bun.sleep(1);

describe("AlwaysOnSupervisor (fake processes)", () => {
  beforeEach(() => setDb(openTestDb()));

  it("starts enabled always-on schedules only, with a 60 s heartbeat", () => {
    const fake = fakeLaunch();
    const id = makeAlwaysOn();
    const off = makeAlwaysOn();
    updateSchedule(off, { enabled: 0 });
    insertSchedule({ name: "tick", cron_expr: "* * * * *", provider_id: "mock", project_path: projectDir, prompt: "", kind: "script", mode: "tick", script: "x" });
    new AlwaysOnSupervisor(fake.launch, fakeClock().clock).sync();
    expect(fake.launched.map((l) => l.schedule.id)).toEqual([id]);
    expect(fake.launched[0]!.opts).toEqual({ heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS });
    expect(listScheduleRuns(id)[0]!.status).toBe("running");
  });

  it("starts a process that exits again after 5, 10, 20, 40, 80, 160 s, then every 300 s", async () => {
    const fake = fakeLaunch();
    const time = fakeClock();
    const id = makeAlwaysOn();
    const sup = new AlwaysOnSupervisor(fake.launch, time.clock);
    sup.sync();
    for (let i = 0; i < 8; i++) {
      fake.launched.at(-1)!.exit({ code: 1, error: `crash ${i}` });
      await flush();
      expect(sup.status(id)).toMatchObject({ state: "restarting", restarts: i + 1, lastError: `crash ${i}` });
      time.advance(time.delays().at(-1)!);
      expect(sup.status(id)!.state).toBe("running");
    }
    expect(time.delays()).toEqual([...BACKOFF_MS, 300_000]);
    expect(time.delays().slice(0, 7)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
    const runs = listScheduleRuns(id, 50);
    expect(runs.filter((r) => r.status === "error")).toHaveLength(8);
  });

  it("waits 5 s again after a process that lived 10 minutes", async () => {
    const fake = fakeLaunch();
    const time = fakeClock();
    makeAlwaysOn();
    const sup = new AlwaysOnSupervisor(fake.launch, time.clock);
    sup.sync();
    for (let i = 0; i < 3; i++) {
      fake.launched.at(-1)!.exit({ error: "crash" });
      await flush();
      time.advance(time.delays().at(-1)!);
    }
    time.advance(STABLE_MS);
    fake.launched.at(-1)!.exit({ error: "crash after a long life" });
    await flush();
    expect(time.delays()).toEqual([5_000, 10_000, 20_000, 5_000]);
  });

  it("stops a schedule turned off and does not start it again; starts it when turned back on", async () => {
    const fake = fakeLaunch();
    const time = fakeClock();
    const id = makeAlwaysOn();
    const sup = new AlwaysOnSupervisor(fake.launch, time.clock);
    sup.sync();
    updateSchedule(id, { enabled: 0 });
    sup.sync();
    await flush();
    expect(fake.launched[0]!.stops).toEqual(["it was turned off"]);
    expect(sup.status(id)).toBeNull();
    expect(time.pending()).toBe(0);
    expect(listScheduleRuns(id)[0]).toMatchObject({ status: "done", error: null });

    updateSchedule(id, { enabled: 1 });
    sup.sync();
    expect(fake.launched).toHaveLength(2);
  });

  it("after an edit, starts the new version only once the old process has exited", async () => {
    const fake = fakeLaunch();
    const id = makeAlwaysOn();
    const sup = new AlwaysOnSupervisor(fake.launch, fakeClock().clock);
    sup.sync();
    // The old process takes its time to stop.
    const old = fake.launched[0]!;
    let finishStop!: () => void;
    const slow = new Promise<void>((r) => { finishStop = r; });
    (sup as unknown as { entries: Map<number, { run: Launched }> }).entries.get(id)!.run.child.stop = ((reason: string) => {
      old.stops.push(reason);
      void slow.then(() => old.exit({ stopReason: reason }));
      return Promise.resolve();
    }) as never;

    updateSchedule(id, { script: "export default async () => { /* v2 */ }" });
    sup.sync();
    sup.sync(); // a second look while it stops changes nothing
    await flush();
    expect(old.stops).toEqual(["it was edited"]);
    expect(fake.launched).toHaveLength(1);
    finishStop();
    await flush();
    expect(fake.launched).toHaveLength(2);
    expect(fake.launched[1]!.schedule.script).toContain("v2");
    // Renaming is not an edit of what runs.
    updateSchedule(id, { name: "renamed" });
    sup.sync();
    await flush();
    expect(fake.launched[1]!.stops).toEqual([]);
    expect(fake.launched).toHaveLength(2);
  });

  it("restart starts the process again at once and puts the backoff back at 5 s", async () => {
    const fake = fakeLaunch();
    const time = fakeClock();
    const id = makeAlwaysOn();
    const sup = new AlwaysOnSupervisor(fake.launch, time.clock);
    sup.sync();
    for (let i = 0; i < 3; i++) {
      fake.launched.at(-1)!.exit({ error: "crash" });
      await flush();
      if (i < 2) time.advance(time.delays().at(-1)!);
    }
    // Waiting 20 s to restart; a restart does not wait.
    await sup.restart(id);
    expect(sup.status(id)!.state).toBe("running");
    expect(time.pending()).toBe(0);
    fake.launched.at(-1)!.exit({ error: "crash" });
    await flush();
    expect(time.delays().at(-1)).toBe(5_000);

    // While running: stopped, then started again.
    time.advance(5_000);
    await sup.restart(id);
    expect(fake.launched.at(-2)!.stops).toEqual(["it was restarted"]);
    expect(sup.status(id)!.state).toBe("running");
    updateSchedule(id, { enabled: 0 });
    await expect(sup.restart(id)).rejects.toThrow("Turn the schedule on to start it");
  });

  it("does not retry a schedule that cannot start until it is edited", async () => {
    const fake = fakeLaunch();
    const time = fakeClock();
    const id = makeAlwaysOn();
    const sup = new AlwaysOnSupervisor(fake.launch, time.clock);
    fake.fail("Fill in token before it can run");
    sup.sync();
    sup.sync();
    expect(sup.status(id)).toMatchObject({ state: "failed", lastError: "Fill in token before it can run" });
    expect(time.pending()).toBe(0);
    expect(listScheduleRuns(id)).toHaveLength(1);
    fake.fail(null);
    updateSchedule(id, { input_values_json: '{"channel":"#ops"}' });
    sup.sync();
    expect(sup.status(id)!.state).toBe("running");
  });

  it("stops everything on shutdown, closes the run rows, and starts nothing after", async () => {
    const fake = fakeLaunch();
    const time = fakeClock();
    const id = makeAlwaysOn();
    const sup = new AlwaysOnSupervisor(fake.launch, time.clock);
    sup.sync();
    sup.stopAll("PPM stopped");
    expect(listScheduleRuns(id)[0]).toMatchObject({ status: "done" });
    expect(listScheduleRuns(id)[0]!.ended_at).not.toBeNull();
    await flush();
    expect(fake.launched[0]!.stops).toEqual(["PPM stopped"]);
    sup.sync();
    expect(fake.launched).toHaveLength(1);
    expect(time.pending()).toBe(0);
  });

  it("a process deleted with its schedule is stopped and waited for", async () => {
    const fake = fakeLaunch();
    const id = makeAlwaysOn();
    const sup = new AlwaysOnSupervisor(fake.launch, fakeClock().clock);
    sup.sync();
    updateSchedule(id, { enabled: 0 });
    await sup.stop(id);
    deleteSchedule(id);
    expect(fake.launched[0]!.stops).toEqual(["it was deleted"]);
    expect(sup.status(id)).toBeNull();
  });
});

describe("AlwaysOnSupervisor (real processes)", () => {
  const sups: AlwaysOnSupervisor[] = [];
  const ids: number[] = [];
  beforeEach(() => setDb(openTestDb()));
  afterEach(async () => {
    for (const sup of sups.splice(0)) sup.stopAll("test over");
    for (const id of ids.splice(0)) {
      const child = liveScript(id);
      if (child) await child.exited;
      removeRunDir(id);
    }
  });
  const track = (sup: AlwaysOnSupervisor) => { sups.push(sup); return sup; };
  const make = (script?: string) => { const id = makeAlwaysOn(script); ids.push(id); return id; };

  it("kills the previous server's leftover before the new process starts", async () => {
    const id = make();
    const token = crypto.randomUUID();
    const stray = Bun.spawn(["sleep", "30"], { env: { ...process.env, PPM_SCHEDULE_RUN: token } });
    recordSpawn(id, stray.pid, token);
    const sup = track(new AlwaysOnSupervisor());
    await sup.prepare();
    expect(isAlive(stray.pid)).toBe(false);
    sup.sync();
    expect(liveScript(id)).not.toBeNull();
  });

  it("never runs two processes for one schedule across an edit", async () => {
    const id = make(`export default async (ctx) => {
      console.log("start v1");
      try { await ctx.sleep(3_600_000); } catch { console.log("stop v1"); }
    }`);
    const sup = track(new AlwaysOnSupervisor());
    sup.sync();
    const lines = () => logRing(id).since(0).map((l) => l.text);
    await waitFor(() => lines().includes("start v1"), "v1 to start");
    updateSchedule(id, { script: `export default async (ctx) => { console.log("start v2"); await ctx.sleep(3_600_000); }` });
    sup.sync();
    await waitFor(() => lines().includes("start v2"), "v2 to start");
    const order = lines().filter((l) => /^(start|stop) v/.test(l));
    expect(order.slice(-3)).toEqual(["start v1", "stop v1", "start v2"]);
  });

  it("kills a process that stopped answering, and starts it again", async () => {
    const id = make("export default async () => { while (true) {} }");
    const time = fakeClock();
    const quick: Launch = (s) => launchScript(s, { heartbeatTimeoutMs: 400 });
    const sup = track(new AlwaysOnSupervisor(quick, { now: () => Date.now(), after: time.clock.after }));
    sup.sync();
    const first = liveScript(id)!;
    await waitFor(() => sup.status(id)?.state === "restarting", "the hung process to be killed", 8000);
    expect(isAlive(first.pid)).toBe(false);
    expect(sup.status(id)!.lastError).toBe("Stopped: no heartbeat for 0 s");
    time.advance(5_000);
    expect(sup.status(id)!.state).toBe("running");
    expect(liveScript(id)!.pid).not.toBe(first.pid);
  });

  it("stops the process of a schedule turned off", async () => {
    const id = make();
    const sup = track(new AlwaysOnSupervisor());
    sup.sync();
    const child = liveScript(id)!;
    updateSchedule(id, { enabled: 0 });
    sup.sync();
    await child.exited;
    expect(isAlive(child.pid)).toBe(false);
    expect(getSchedule(id)!.enabled).toBe(0);
    expect(liveScript(id)).toBeNull();
  });
});

describe("AlwaysOnSupervisor.prepare", () => {
  beforeEach(() => setDb(openTestDb()));

  it("closes the run row of a process the previous server left running, as ended rather than failed", async () => {
    const id = makeAlwaysOn();
    const life = listScheduleRuns(id).length;
    const { insertScheduleRun } = await import("../../../../src/services/scheduler-db.service.ts");
    const runId = insertScheduleRun(id, null, "running");
    await new AlwaysOnSupervisor(fakeLaunch().launch, fakeClock().clock).prepare();
    const run = listScheduleRuns(id).find((r) => r.id === runId)!;
    expect(life).toBe(0);
    expect(run).toMatchObject({ status: "done", error: null });
    expect(run.ended_at).not.toBeNull();
  });
});
