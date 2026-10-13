import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerRegistry } from "../../../../src/providers/registry.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import { notificationService } from "../../../../src/services/notification.service.ts";
import { getSchedule, insertSchedule } from "../../../../src/services/scheduler-db.service.ts";
import { scheduleAsk } from "../../../../src/services/schedule-script/ctx-ask.ts";
import { ctxHost } from "../../../../src/services/schedule-script/ctx-host.ts";
import { STATE_MAX_BYTES } from "../../../../src/services/schedule-script/ctx-state.ts";
import { removeRunDir, writeScriptFile } from "../../../../src/services/schedule-script/script-files.ts";
import { ScriptProcess } from "../../../../src/services/schedule-script/script-process.ts";
import type { Schedule } from "../../../../src/types/scheduler.ts";

const restores: Array<() => void> = [];
let projectDir = "";
let previousProjects: unknown;
let schedule: Schedule;

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ppm-ctx-host-"));
  previousProjects = configService.get("projects");
  configService.set("projects", [{ name: "demo", path: projectDir }]);
});
afterAll(() => {
  configService.set("projects", previousProjects as never);
  rmSync(projectDir, { recursive: true, force: true });
});
beforeEach(() => {
  schedule = getSchedule(insertSchedule({
    name: "bot", cron_expr: "0 * * * * *", provider_id: "mock", project_path: projectDir, prompt: "",
    kind: "script", mode: "tick", script: "export default async () => {}",
  }))!;
});
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const stateOf = (id: number) => getSchedule(id)!.state_json;

describe("ctx host", () => {
  it("saves a state up to 2 MB of JSON, and keeps the old one when refused", async () => {
    const call = ctxHost(schedule);
    getDb().query("UPDATE schedules SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(schedule.id);
    await call("save", { state: '{"seen":[1,2]}' });
    expect(stateOf(schedule.id)).toBe('{"seen":[1,2]}');

    const big = JSON.stringify({ blob: "x".repeat(STATE_MAX_BYTES) });
    await expect(call("save", { state: big })).rejects.toThrow("a schedule keeps at most 2 MB");
    await expect(call("save", { state: "{nope" })).rejects.toThrow("ctx.state is not valid JSON");
    expect(stateOf(schedule.id)).toBe('{"seen":[1,2]}');
    // A state is not an edit of the schedule.
    expect(getSchedule(schedule.id)!.updated_at).toBe("2020-01-01 00:00:00");
  });

  it("notifies through PPM's notifications, under the schedule's project", async () => {
    const sent: unknown[] = [];
    const spy = spyOn(notificationService, "broadcast").mockImplementation((async (type: string, payload: unknown) => { sent.push({ type, payload }); }) as never);
    restores.push(() => spy.mockRestore());
    await ctxHost(schedule)("notify", { title: "PR #12 approved", body: "by hienlh", sessionId: "6d8c0aa2-0435-4e50-82a5-a6cd92deb312" });
    expect(sent).toEqual([{ type: "schedule", payload: { title: "PR #12 approved", body: "by hienlh", project: "demo", sessionId: "6d8c0aa2-0435-4e50-82a5-a6cd92deb312" } }]);
    await expect(ctxHost(schedule)("notify", { body: "no title" })).rejects.toThrow("ctx.notify needs a title");
  });

  it("asks the mock provider for free, and refuses a call made wrongly", async () => {
    const call = ctxHost(schedule);
    expect(await call("ai.ask", { prompt: "hi", opts: {} })).toEqual({ ok: true, text: "Mock answer: hi", costUsd: 0 });
    expect(await call("ai.ask", { prompt: "hi", opts: { jsonSchema: { type: "object" } } })).toMatchObject({ ok: true, json: {} });
    await expect(call("ai.ask", { prompt: " ", opts: {} })).rejects.toThrow("ctx.ai.ask needs a prompt");
    await expect(call("ai.ask", { prompt: "hi", opts: { temperature: 1 } })).rejects.toThrow('ctx.ai.ask has no option "temperature"');
    await expect(call("ai.ask", { prompt: "hi", opts: { effort: "max" } })).rejects.toThrow("effort must be");
    await expect(call("ai.ask", { prompt: "hi", opts: { timeoutMs: 600_001 } })).rejects.toThrow("timeoutMs must be");
    await expect(call("ai.chat", { key: "k", prompt: "hi", opts: { timeout: 5 } })).rejects.toThrow('ctx.ai.chat has no option "timeout"');
    await expect(call("ai.chat", { key: "", prompt: "hi", opts: {} })).rejects.toThrow("ctx.ai.chat needs a key");
    await expect(call("exec", {})).rejects.toThrow("ctx has no exec");
  });

  it("answers a failed or overdue question with ok: false, not a throw", async () => {
    const claude = providerRegistry.get("claude") as unknown as { completeOnce: (...a: unknown[]) => Promise<unknown> };
    const spy = spyOn(claude, "completeOnce").mockImplementation(async () => { throw new Error("No Claude account can take a request right now"); });
    restores.push(() => spy.mockRestore());
    expect(await scheduleAsk({ provider_id: "claude" }, "hi", {})).toEqual({ ok: false, text: "", error: "No Claude account can take a request right now" });
    expect(spy.mock.calls[0]![0]).toMatchObject({ prompt: "hi", model: "haiku", timeoutMs: 120_000 });

    spy.mockImplementation(async () => { await Bun.sleep(60); throw new Error("Claude took too long to answer"); });
    expect(await scheduleAsk({ provider_id: "claude" }, "hi", { timeoutMs: 50, model: "sonnet", effort: "low", system: "Judge." }))
      .toEqual({ ok: false, text: "", error: "Claude took too long to answer", timedOut: true });
    expect(spy.mock.calls[1]![0]).toMatchObject({ model: "sonnet", effort: "low", systemPrompt: "Judge.", timeoutMs: 50 });
  });

  it("serves a real script's calls end to end", async () => {
    const source = `
      export default async function (ctx) {
        console.log("ask " + JSON.stringify(await ctx.ai.ask("hi")));
        try { await ctx.ai.ask("hi", { temperature: 1 }); } catch (e) { console.log("refused: " + e.message); }
        ctx.state = { n: 1 };
        await ctx.save();
        ctx.state = { n: 2 };
      }`;
    const lines: string[] = [];
    const child = new ScriptProcess({
      init: {
        schedule: { id: schedule.id, name: schedule.name, mode: "tick" }, project: { name: "demo", path: projectDir },
        inputs: {}, state: {}, scriptPath: writeScriptFile(schedule.id, source),
      },
      cwd: projectDir, token: "ctx-host-test", onCall: ctxHost(schedule), onLine: (l) => lines.push(l),
    });
    const exit = await child.exited;
    removeRunDir(schedule.id);
    expect(exit).toMatchObject({ finished: true, error: null, state: '{"n":2}' });
    expect(lines).toContain('ask {"ok":true,"text":"Mock answer: hi","costUsd":0}');
    expect(lines.find((l) => l.startsWith("refused: "))).toStartWith('refused: ctx.ai.ask has no option "temperature"');
    // What ctx.save() stored; the state at the end is the tick runner's to keep.
    expect(stateOf(schedule.id)).toBe('{"n":1}');
  });
});
