/**
 * The PPM Assistant's `schedule_propose_script` through the real `/api/schedules` routes, reached
 * the way its endpoint reaches them: allowed, the script schedule exists exactly as the card showed
 * it; declined or with its file changed meanwhile, nothing exists. `schedule_save` turning a script
 * back on shows the script and is allowed only in PPM.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerService, nextFireAt } from "../../src/services/scheduler-core.ts";

const scheduler = new SchedulerService({
  ensureScheduleSession: async () => "propose-int-session",
  runScheduleOnce: async () => ({ status: "done", output: "", costUsd: 0 }),
  runScriptTick: async () => {},
}, {
  prepare: async () => {}, sync: () => {}, restart: async () => {}, isRunning: () => false, stopAll: () => {},
});
mock.module("../../src/services/scheduler.service.ts", () => ({
  schedulerService: scheduler,
  nextFireAt,
  alwaysOnSupervisor: { status: () => null, stop: async () => {} },
}));

const { configService } = await import("../../src/services/config.service.ts");
const { openTestDb, setDb } = await import("../../src/services/db.service.ts");
const { getSchedule, getSchedules } = await import("../../src/services/scheduler-db.service.ts");
const { createRouteCaller } = await import("../../src/services/assistant-mcp/assistant-route-call.ts");
const { SCHEDULE_ROUTES } = await import("../../src/services/assistant-mcp/assistant-schedule-tools.ts");
const { scheduleProposeScript } = await import("../../src/services/assistant-mcp/assistant-schedule-propose-tool.ts");
const { scheduleSave } = await import("../../src/services/assistant-mcp/assistant-schedule-write-tools.ts");
const { decidingInput } = await import("../../src/services/chat-control/approval-deciding-input.ts");
type AskApproval = import("../../src/services/assistant-mcp/assistant-approval-broker.ts").AskApproval;
type ApprovalAsk = import("../../src/services/assistant-mcp/assistant-approval-broker.ts").ApprovalAsk;

const SCRIPT = "export default async function main(ctx) {\n  ctx.log(`checked ${Date.now()}`);\n}\n";
let projectDir: string;
let savedProjects: unknown;
const callRoute = createRouteCaller(SCHEDULE_ROUTES);
let asks: ApprovalAsk[];
const answering = (verdict: "approved" | "denied", during?: () => void): AskApproval => async (a) => {
  asks.push(a);
  during?.();
  return verdict === "approved" ? { verdict } : { verdict, reason: "The user said no." };
};
const ctx = (ask: AskApproval) => ({ sessionId: "assistant-propose-int", ask, callRoute });
const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;
const deps = {
  card: () => ({ nextRuns: (_c: string, _z: string | null, n: number) => Array.from({ length: n }, () => "soon"), machineZone: "Asia/Saigon", chat: () => null }),
};

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ppm-propose-int-"));
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "propose-int", path: projectDir }]);
});
afterAll(() => {
  configService.set("projects", savedProjects as never);
  rmSync(projectDir, { recursive: true, force: true });
});
beforeEach(() => {
  setDb(openTestDb());
  asks = [];
});

describe("schedule_propose_script", () => {
  it("creates the script schedule the card showed once the user allows it", async () => {
    const res = await scheduleProposeScript(ctx(answering("approved")), {
      project: "propose-int", name: "Watch", cron: "0 */10 * * * *", script: SCRIPT, timezone: "Europe/London", permissionMode: "default",
    }, deps);
    const out = parse(res);
    expect(out.created).toBe(true);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.summary.body!.text).toBe(SCRIPT);
    expect(decidingInput({ tool: asks[0]!.tool, input: asks[0]!.input, summary: asks[0]!.summary }).complete).toBe(false);
    expect(getSchedule(out.schedule.id)).toMatchObject({
      kind: "script", script: SCRIPT, project_path: projectDir, timezone: "Europe/London", cron_expr: "0 */10 * * * *", enabled: 1,
    });
  });

  it("creates nothing when the user declines", async () => {
    const res = await scheduleProposeScript(ctx(answering("denied")), { project: "propose-int", name: "Watch", cron: "0 */10 * * * *", script: SCRIPT }, deps);
    expect(parse(res).outcome).toBe("declined");
    expect(getSchedules()).toHaveLength(0);
  });

  it("creates nothing when its file changed while the card waited", async () => {
    const file = join(projectDir, "watch.ppm-schedule.json");
    const template = { ppmScheduleTemplate: 1, name: "From file", kind: "script", mode: "tick", cron: "0 */10 * * * *", script: SCRIPT };
    writeFileSync(file, JSON.stringify(template));
    const res = await scheduleProposeScript(ctx(answering("approved", () => writeFileSync(file, JSON.stringify({ ...template, name: "Swapped" })))), { project: "propose-int", file }, deps);
    expect(textOf(res)).toContain("stale");
    expect(getSchedules()).toHaveLength(0);
  });

  it("is refused for a project PPM does not have, before any card", async () => {
    const res = await scheduleProposeScript(ctx(answering("approved")), { project: "nope", name: "W", cron: "0 */10 * * * *", script: SCRIPT }, deps);
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(asks).toHaveLength(0);
  });

  it("is what schedule_save points to for a script, and schedule_save turning one on shows the script", async () => {
    expect(textOf(await scheduleSave(ctx(answering("approved")), { kind: "script", name: "x" }))).toContain("schedule_propose_script");
    const created = parse(await scheduleProposeScript(ctx(answering("approved")), { project: "propose-int", name: "W", cron: "0 */10 * * * *", script: SCRIPT }, deps));
    await scheduleSave(ctx(answering("approved")), { id: created.schedule.id, enabled: false });
    asks = [];
    await scheduleSave(ctx(answering("approved")), { id: created.schedule.id, enabled: true });
    expect(asks[0]!.summary.body).toMatchObject({ text: SCRIPT });
    expect(asks[0]!.summary.reviewInPpm).toBeTruthy();
    expect(getSchedule(created.schedule.id)!.enabled).toBe(1);
  });
});
