import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScriptProcess, childEnv, type ScriptExit } from "../../../../src/services/schedule-script/script-process.ts";
import { isAlive } from "../../../../src/services/schedule-script/instance-guard.ts";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ppm-script-proc-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function scriptFile(source: string): string {
  const file = join(dir, `s${++n}.mjs`);
  writeFileSync(file, source);
  return file;
}

interface Run { child: ScriptProcess; lines: string[]; calls: Array<{ method: string; params: unknown }> }

function run(source: string, opts: {
  state?: unknown;
  onCall?: (method: string, params: unknown) => Promise<unknown>;
  heartbeatTimeoutMs?: number;
  heartbeatMs?: number;
} = {}): Run {
  const lines: string[] = [];
  const calls: Run["calls"] = [];
  const child = new ScriptProcess({
    init: {
      schedule: { id: 7, name: "t", mode: "tick" },
      project: { name: "proj", path: dir },
      inputs: { greeting: "hello", token: "xoxp-secret" },
      state: opts.state ?? {},
      scriptPath: scriptFile(source),
      heartbeatMs: opts.heartbeatMs,
    },
    cwd: dir,
    token: "test-token",
    onCall: async (method, params) => {
      calls.push({ method, params });
      return opts.onCall ? opts.onCall(method, params) : null;
    },
    onLine: (line) => lines.push(line),
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
  });
  return { child, lines, calls };
}

const within = async (p: Promise<ScriptExit>, ms: number): Promise<ScriptExit> =>
  Promise.race([p, Bun.sleep(ms).then(() => { throw new Error(`no exit within ${ms} ms`); })]);

describe("ScriptProcess", () => {
  it("runs the script with ctx, and everything it prints comes back as lines", async () => {
    const { child, lines } = run(`
      export default async function (ctx) {
        ctx.log("log", ctx.inputs.greeting, ctx.schedule.id, ctx.project.name);
        console.log("stdout");
        console.error("stderr");
        ctx.state.n = (ctx.state.n ?? 0) + 1;
      }`, { state: { n: 1 } });
    const exit = await within(child.exited, 10_000);
    expect(exit).toMatchObject({ finished: true, error: null, code: 0, stopReason: null });
    expect(JSON.parse(exit.state!)).toEqual({ n: 2 });
    expect(lines).toEqual(expect.arrayContaining(["log hello 7 proj", "stdout", "stderr"]));
  });

  it("keeps every line of a script that prints a lot right before it returns", async () => {
    const { child, lines } = run(`export default async () => { for (let i = 0; i < 5000; i++) console.log("line " + i); }`);
    await within(child.exited, 10_000);
    expect(lines.length).toBe(5000);
    expect(lines.at(-1)).toBe("line 4999");
  });

  it("a throw is the run's error, stack included; a missing default export says what is expected", async () => {
    const thrown = await within(run(`export default async () => { throw new Error("boom"); }`).child.exited, 10_000);
    expect(thrown.finished).toBe(true);
    expect(thrown.error).toContain("boom");
    expect(thrown.error).toContain(" at ");
    const noDefault = await within(run(`export const x = 1;`).child.exited, 10_000);
    expect(noDefault.error).toContain("must export a default function");
  });

  it("ctx calls reach PPM, and PPM's answer or refusal comes back to the script", async () => {
    const { child, lines, calls } = run(`
      export default async function (ctx) {
        ctx.state.saved = true;
        await ctx.save();
        const answer = await ctx.ai.ask("hi", { model: "haiku" });
        ctx.log("answer", answer.text);
        try { await ctx.notify({ title: "t", body: "b" }); } catch (e) { ctx.log("refused", e.message); }
      }`, {
      onCall: async (method) => {
        if (method === "ai.ask") return { ok: true, text: "hello back" };
        if (method === "notify") throw new Error("notifications are off");
        return null;
      },
    });
    const exit = await within(child.exited, 10_000);
    expect(exit.error).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["save", "ai.ask", "notify"]);
    expect(calls[0]!.params).toEqual({ state: '{"saved":true}' });
    expect(calls[1]!.params).toEqual({ prompt: "hi", opts: { model: "haiku" } });
    expect(lines).toEqual(expect.arrayContaining(["answer hello back", "refused notifications are off"]));
  });

  it("stop() aborts ctx.signal and ctx.sleep, and a script that honours it finishes cleanly", async () => {
    const { child, lines } = run(`
      export default async function (ctx) {
        console.log("started");
        try { while (true) await ctx.sleep(1000); } catch (e) { ctx.log("stopped by", e.name, e.message, ctx.signal.aborted); }
      }`);
    while (!lines.includes("started")) await Bun.sleep(20);
    const exit = await within(child.stop("disabled"), 5_000);
    expect(exit).toMatchObject({ finished: true, error: null, stopReason: "disabled" });
    expect(lines).toContain("stopped by AbortError disabled true");
  });

  it("a script that ignores stop() is killed after the grace period", async () => {
    const { child, lines } = run(`export default async () => { console.log("started"); await new Promise(() => {}); }`);
    while (!lines.includes("started")) await Bun.sleep(20);
    const t0 = Date.now();
    const exit = await within(child.stop("timed out after 1 s", 300), 5_000);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(exit).toMatchObject({ finished: false, stopReason: "timed out after 1 s" });
    expect(exit.error).toContain("timed out after 1 s");
  });

  it("a script that blocks its event loop is still killed", async () => {
    const flag = join(dir, "blocking");
    const { child } = run(`export default async () => { (await import("node:fs")).writeFileSync(${JSON.stringify(flag)}, "1"); while (true) {} }`);
    while (!existsSync(flag)) await Bun.sleep(20);
    const exit = await within(child.stop("disabled", 300), 5_000);
    expect(exit.finished).toBe(false);
  });

  it("a missed heartbeat kills a stuck child; a healthy one keeps running", async () => {
    const healthy = run(`export default async (ctx) => { await ctx.sleep(1200); }`, { heartbeatMs: 100, heartbeatTimeoutMs: 600 });
    const flag = join(dir, "stuck");
    const stuck = run(`export default async () => { (await import("node:fs")).writeFileSync(${JSON.stringify(flag)}, "1"); while (true) {} }`,
      { heartbeatMs: 100, heartbeatTimeoutMs: 600 });
    const stuckExit = await within(stuck.child.exited, 8_000);
    expect(stuckExit.stopReason).toContain("no heartbeat");
    const healthyExit = await within(healthy.child.exited, 8_000);
    expect(healthyExit).toMatchObject({ finished: true, error: null, stopReason: null });
  });

  it("the child gets the run token and none of systemd's notify variables", async () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    try {
      expect(childEnv("tok").NOTIFY_SOCKET).toBeUndefined();
      expect(childEnv("tok").PPM_SCHEDULE_RUN).toBe("tok");
      expect(childEnv("tok").BUN_BE_BUN).toBe("1");
      const { child, lines } = run(`export default async () => { console.log(String(process.env.NOTIFY_SOCKET), process.env.PPM_SCHEDULE_RUN); }`);
      await within(child.exited, 10_000);
      expect(lines).toContain("undefined test-token");
    } finally {
      delete process.env.NOTIFY_SOCKET;
    }
  });
});

describe("a script child never outlives PPM", () => {
  it("when its stdin closes (PPM went away) the script sees ctx.signal abort, then the child exits", async () => {
    const { child, lines } = run(`
      export default async function (ctx) {
        console.log("started");
        ctx.signal.addEventListener("abort", () => console.log("aborted: " + ctx.signal.reason.message));
        await new Promise(() => {});
      }`);
    while (!lines.includes("started")) await Bun.sleep(20);
    (child as unknown as { closeStdin(): void }).closeStdin();
    const exit = await within(child.exited, 5_000);
    expect(lines).toContain("aborted: PPM stopped");
    expect(exit.finished).toBe(false);
  });

  const fakePpm = resolve(import.meta.dir, "../../../helpers/schedule-script-fake-ppm.ts");

  async function orphanCheck(source: string, flag: string): Promise<number> {
    const out = join(dir, `pid-${++n}`);
    const ppm = Bun.spawn([process.execPath, fakePpm, scriptFile(source), out], { env: process.env, stdout: "ignore", stderr: "inherit" });
    try {
      while (!existsSync(out) || !existsSync(flag)) await Bun.sleep(20);
      // Let the watchdog look at the living parent first: Bun caches process.ppid on first read,
      // so a watchdog that trusted it would keep seeing this parent after it died.
      await Bun.sleep(700);
      const childPid = Number(readFileSync(out, "utf8"));
      expect(isAlive(childPid)).toBe(true);
      ppm.kill("SIGKILL");
      await ppm.exited;
      const t0 = Date.now();
      while (isAlive(childPid) && Date.now() - t0 < 6_000) await Bun.sleep(25);
      const alive = isAlive(childPid);
      if (alive) process.kill(childPid, "SIGKILL");
      expect(alive).toBe(false);
      return Date.now() - t0;
    } finally {
      ppm.kill("SIGKILL");
    }
  }

  it("when PPM is SIGKILLed, an idle child exits within a few seconds", async () => {
    const flag = join(dir, "idle-up");
    const ms = await orphanCheck(`export default async (ctx) => { (await import("node:fs")).writeFileSync(${JSON.stringify(flag)}, "1"); while (true) await ctx.sleep(1000); }`, flag);
    expect(ms).toBeLessThan(4_000);
  });

  it("when PPM is SIGKILLed, a child stuck in a busy loop is killed by its watchdog", async () => {
    const flag = join(dir, "busy-up");
    const ms = await orphanCheck(`export default async () => { (await import("node:fs")).writeFileSync(${JSON.stringify(flag)}, "1"); while (true) {} }`, flag);
    expect(ms).toBeLessThan(3_000);
  });
});
