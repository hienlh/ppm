import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { insertSchedule } from "../../../../src/services/scheduler-db.service.ts";
import {
  blockedBy, isAlive, liveScript, ownership, reconcileLeftovers, retryBlocked, startScript,
} from "../../../../src/services/schedule-script/instance-guard.ts";
import { getRuntime, recordSpawn } from "../../../../src/services/schedule-script/script-runtime-db.ts";

const dir = mkdtempSync(join(tmpdir(), "ppm-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const strays: Array<ReturnType<typeof Bun.spawn>> = [];
afterAll(() => { for (const p of strays) p.kill("SIGKILL"); });

/** A long-lived process standing in for a child a previous server left behind. */
function stray(token?: string): ReturnType<typeof Bun.spawn> {
  const p = Bun.spawn(["sleep", "30"], { env: { ...process.env, ...(token && { PPM_SCHEDULE_RUN: token }) } });
  strays.push(p);
  return p;
}

const newSchedule = () => insertSchedule({
  name: "s", cron_expr: "", provider_id: "mock", project_path: dir, prompt: "", kind: "script", mode: "always-on", script: "x",
});

function startSleeper(id: number) {
  const file = join(dir, `sleeper-${id}.mjs`);
  writeFileSync(file, "export default async (ctx) => { while (true) await ctx.sleep(1000); }");
  return startScript(id, {
    init: { schedule: { id, name: "s", mode: "always-on" }, project: { name: "p", path: dir }, inputs: {}, state: {}, scriptPath: file },
    cwd: dir, onCall: async () => null, onLine: () => {},
  });
}

describe("one child per schedule", () => {
  beforeEach(() => setDb(openTestDb()));

  it("a second start while the first child is alive is refused; after it exits, a new one may start", async () => {
    const id = newSchedule();
    const first = startSleeper(id)!;
    expect(first).not.toBeNull();
    expect(startSleeper(id)).toBeNull();
    expect(liveScript(id)).toBe(first);
    expect(getRuntime(id)!.pid).toBe(first.pid);
    await first.stop("test");
    expect(liveScript(id)).toBeNull();
    expect(getRuntime(id)!.pid).toBeNull();
    const second = startSleeper(id)!;
    expect(second).not.toBeNull();
    await second.stop("test");
  });

  it("at boot, a recorded child that is provably ours is killed before anything starts", async () => {
    const id = newSchedule();
    const left = stray("tok-ours");
    recordSpawn(id, left.pid, "tok-ours");
    expect(ownership(left.pid, "tok-ours")).toBe("ours");
    await reconcileLeftovers({ killMs: 3_000, unknownMs: 3_000 });
    expect(isAlive(left.pid)).toBe(false);
    expect(getRuntime(id)!.pid).toBeNull();
    expect(blockedBy(id)).toBeNull();
  });

  it("a recorded pid that now belongs to some other process is forgotten, not killed", async () => {
    const id = newSchedule();
    const unrelated = stray();
    recordSpawn(id, unrelated.pid, "tok-old");
    expect(ownership(unrelated.pid, "tok-old")).toBe("not-ours");
    await reconcileLeftovers({ killMs: 3_000, unknownMs: 3_000 });
    expect(isAlive(unrelated.pid)).toBe(true);
    expect(getRuntime(id)!.pid).toBeNull();
    expect(blockedBy(id)).toBeNull();
  });

  it("a child that cannot be proved ours and does not go away blocks its schedule, until it is gone", async () => {
    const id = newSchedule();
    const unknown = stray();
    recordSpawn(id, unknown.pid, "tok-?");
    await reconcileLeftovers({ killMs: 200, unknownMs: 200 }, () => "unknown");
    expect(blockedBy(id)).toBe(unknown.pid);
    expect(startSleeper(id)).toBeNull();
    expect(await retryBlocked(id)).toBe(false);
    unknown.kill("SIGKILL");
    await unknown.exited;
    expect(await retryBlocked(id)).toBe(true);
    const child = startSleeper(id)!;
    expect(child).not.toBeNull();
    await child.stop("test");
  });

  it("a recorded child that has already exited is simply cleared", async () => {
    const id = newSchedule();
    const gone = stray("tok-gone");
    gone.kill("SIGKILL");
    await gone.exited;
    recordSpawn(id, gone.pid, "tok-gone");
    await reconcileLeftovers({ killMs: 200, unknownMs: 200 });
    expect(getRuntime(id)!.pid).toBeNull();
  });
});
