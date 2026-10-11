/**
 * The schedule tools end to end through the real `/api/schedules` routes, reached the way the
 * endpoint reaches them (the family's in-process route caller), on the test's throwaway PPM_HOME
 * and in-memory database: create → list → edit → pause → turn on → run now → read the run →
 * delete, each write broadcasting `schedules:changed` to `/ws/global` clients as a click in
 * Settings would. A run never reaches a model: the scheduler is the real one with a scripted
 * runner in place of the chat/provider chain.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerService, nextFireAt } from "../../src/services/scheduler-core.ts";
import type { Schedule } from "../../src/types/scheduler.ts";

// The real scheduler (run rows, concurrency count, bookkeeping) driving a scripted runner, so
// "run now" exercises everything but the model. Mocked before anything imports the routes.
const runnerCalls: Array<{ id: number; prompt: string; sessionId: string }> = [];
const scheduler = new SchedulerService({
  ensureScheduleSession: async () => "sched-int-session",
  runScheduleOnce: async (s: Schedule, sessionId: string) => {
    runnerCalls.push({ id: s.id, prompt: s.prompt, sessionId });
    return { status: "done", output: "scripted run output", costUsd: 0 };
  },
});
mock.module("../../src/services/scheduler.service.ts", () => ({ schedulerService: scheduler, nextFireAt }));

const { configService } = await import("../../src/services/config.service.ts");
const { openTestDb, setDb } = await import("../../src/services/db.service.ts");
const { insertSchedule } = await import("../../src/services/scheduler-db.service.ts");
const { globalWebSocket } = await import("../../src/server/ws/global.ts");
const { createRouteCaller } = await import("../../src/services/assistant-mcp/assistant-route-call.ts");
const { SCHEDULE_ROUTES } = await import("../../src/services/assistant-mcp/assistant-schedule-tools.ts");
const { scheduleGet, schedulesList } = await import("../../src/services/assistant-mcp/assistant-schedule-read-tools.ts");
const { scheduleDelete, scheduleRunNow, scheduleSave } = await import("../../src/services/assistant-mcp/assistant-schedule-write-tools.ts");
const { approvalAskerFor, createApprovalBroker } = await import("../../src/services/assistant-mcp/assistant-approval-broker.ts");
type AskApproval = import("../../src/services/assistant-mcp/assistant-approval-broker.ts").AskApproval;
type ApprovalAsk = import("../../src/services/assistant-mcp/assistant-approval-broker.ts").ApprovalAsk;

const PROMPT = "Check the build.\n  Report anything red — exactly this text.";
let projectDir: string;
let otherDir: string;
let savedProjects: unknown;
const sent: string[] = [];
const socket = { data: { type: "global" }, send: (d: string) => { sent.push(d); return d.length; } };
const changes = () => sent.filter((d) => JSON.parse(d).type === "schedules:changed").length;

const callRoute = createRouteCaller(SCHEDULE_ROUTES);
const asks: ApprovalAsk[] = [];
const approve: AskApproval = async (a) => { asks.push(a); return { verdict: "approved" }; };
const ctx = (ask: AskApproval = approve) => ({ sessionId: "assistant-int", ask, callRoute });
const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

beforeAll(() => {
  setDb(openTestDb());
  projectDir = mkdtempSync(join(tmpdir(), "ppm-sched-int-"));
  otherDir = mkdtempSync(join(tmpdir(), "ppm-sched-int-other-"));
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "sched-int", path: projectDir }]);
  globalWebSocket.open(socket as never);
});

afterAll(() => {
  globalWebSocket.close(socket as never);
  configService.set("projects", savedProjects as never);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(otherDir, { recursive: true, force: true });
});

async function waitForRun(id: number): Promise<{ status: string; output: string | null }> {
  for (let i = 0; i < 100; i++) {
    const got = parse(await scheduleGet(ctx(), { id, runs: 1 }));
    if (got.runs[0] && got.runs[0].status !== "running") return got.runs[0];
    await Bun.sleep(20);
  }
  throw new Error("the run did not finish");
}

describe("schedule tools through the real routes", () => {
  it("creates, lists, edits, pauses, runs and deletes a schedule, broadcasting each change", async () => {
    expect(parse(await schedulesList(ctx(), {})).schedules).toEqual([]);

    const created = parse(await scheduleSave(ctx(), { name: "Build check", cron: "0 7 * * 1-5", project: "sched-int", prompt: PROMPT }));
    expect(created).toMatchObject({ created: true, schedule: { project: "sched-int", prompt: PROMPT, permissionMode: "bypassPermissions", enabled: true } });
    const id = created.schedule.id as number;
    expect(asks.at(-1)!.summary.body?.text).toBe(PROMPT);
    expect(changes()).toBe(1);

    const listed = parse(await schedulesList(ctx(), { project: "sched-int" }));
    expect(listed.schedules).toHaveLength(1);
    expect(listed.schedules[0]).toMatchObject({ id, name: "Build check", project: "sched-int", lastRun: null });

    const edited = parse(await scheduleSave(ctx(), { id, cron: "*/15 * * * *", permissionMode: "acceptEdits" }));
    expect(edited).toMatchObject({ updated: true, schedule: { cron: "*/15 * * * *", permissionMode: "acceptEdits" } });
    expect(changes()).toBe(2);

    expect(parse(await scheduleSave(ctx(), { id, enabled: false })).schedule.enabled).toBe(false);
    expect(asks.at(-1)!.summary.headline).toStartWith("Pause");
    expect(parse(await scheduleSave(ctx(), { id, enabled: true })).schedule.enabled).toBe(true);
    expect(asks.at(-1)!.summary.headline).toStartWith("Turn on");
    expect(changes()).toBe(4);

    const started = parse(await scheduleRunNow(ctx(), { id }));
    expect(started).toMatchObject({ started: true, scheduleId: id, wasRunning: false });
    expect(changes()).toBe(5);
    expect(await waitForRun(id)).toMatchObject({ status: "done", output: "scripted run output" });
    expect(runnerCalls).toEqual([{ id, prompt: PROMPT, sessionId: "sched-int-session" }]);

    const deleted = parse(await scheduleDelete(ctx(), { id }));
    expect(deleted).toMatchObject({ deleted: true, runsDeleted: 1, schedule: { id, prompt: PROMPT, cron: "*/15 * * * *" } });
    expect(changes()).toBe(6);
    expect(parse(await schedulesList(ctx(), {})).schedules).toEqual([]);
    expect(isError(await scheduleGet(ctx(), { id }))).toBe(true);
  });

  it("reads a schedule outside the registered projects but never changes it", async () => {
    const id = insertSchedule({ name: "Elsewhere", cron_expr: "0 9 * * *", provider_id: "claude", project_path: otherDir, prompt: "x", next_fire_at: nextFireAt("0 9 * * *") });
    const before = changes();
    const asked = asks.length;
    expect(parse(await schedulesList(ctx(), {})).schedules.find((s: { id: number }) => s.id === id)).toMatchObject({ project: null, folder: otherDir });
    expect(parse(await scheduleGet(ctx(), { id })).schedule).toMatchObject({ id, project: null });
    for (const result of [
      await scheduleSave(ctx(), { id, enabled: false }),
      await scheduleDelete(ctx(), { id }),
      await scheduleRunNow(ctx(), { id }),
    ]) expect(isError(result)).toBe(true);
    expect(asks.length).toBe(asked);
    expect(changes()).toBe(before);
    expect(parse(await scheduleGet(ctx(), { id })).schedule.enabled).toBe(true);
  });

  it("changes nothing when declined or asked from a watch turn", async () => {
    const created = parse(await scheduleSave(ctx(), { name: "Keep", cron: "0 8 * * *", project: "sched-int", prompt: "p" }));
    const id = created.schedule.id as number;
    const before = changes();
    const decline: AskApproval = async () => ({ verdict: "denied", reason: "no" });
    // The endpoint's own asker in a watch turn: it refuses without showing a card.
    const watchTurn = approvalAskerFor("assistant-int", undefined, createApprovalBroker({ deliver: () => { throw new Error("no card in a watch turn"); } }), () => true);
    for (const ask of [decline, watchTurn]) {
      for (const result of [
        await scheduleSave(ctx(ask), { id, enabled: false }),
        await scheduleSave(ctx(ask), { name: "New", cron: "0 8 * * *", project: "sched-int", prompt: "p" }),
        await scheduleDelete(ctx(ask), { id }),
        await scheduleRunNow(ctx(ask), { id }),
      ]) expect(isError(result)).toBe(true);
    }
    expect(changes()).toBe(before);
    expect(parse(await scheduleGet(ctx(), { id, runs: 5 }))).toMatchObject({ schedule: { enabled: true }, runs: [] });
    expect(parse(await schedulesList(ctx(), { project: "sched-int" })).schedules).toHaveLength(1);
  });
});
