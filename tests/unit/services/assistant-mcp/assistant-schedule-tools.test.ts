/**
 * The schedule tools against a stand-in for the `/api/schedules` routes, which records every
 * call: reading never asks; every write asks first with the prompt verbatim (and the bypass
 * warning when it applies) and writes nothing unless approved; only schedules of registered
 * projects change; an approval stands only if the schedule is still what the card showed; and the
 * family's caller reaches nothing but its own routes.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Schedule, ScheduleRun } from "../../../../src/types/scheduler.ts";
import type { ApprovalAsk, ApprovalVerdict, AskApproval } from "../../../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { CallPpmRoute, RouteCallResult } from "../../../../src/services/assistant-mcp/assistant-route-rules.ts";
import { createRouteCaller, ROUTE_NOT_ALLOWED, type RouteApp } from "../../../../src/services/assistant-mcp/assistant-route-call.ts";
import type { ToolContext } from "../../../../src/services/assistant-mcp/assistant-tool-family.ts";
import type { ScheduleDeps } from "../../../../src/services/assistant-mcp/assistant-schedule-shape.ts";
import { SCHEDULE_ROUTES, SCHEDULE_TOOL_HANDLERS } from "../../../../src/services/assistant-mcp/assistant-schedule-tools.ts";
import { scheduleGet, schedulesList } from "../../../../src/services/assistant-mcp/assistant-schedule-read-tools.ts";
import { scheduleDelete, scheduleRunNow, scheduleSave } from "../../../../src/services/assistant-mcp/assistant-schedule-write-tools.ts";
import { SCHEDULE_BYPASS_WARNING } from "../../../../src/services/assistant-mcp/assistant-approval-summary-schedule.ts";
import { SCHEDULE_TOOLS } from "../../../../src/shared/assistant-schedule-tool-names.ts";
import { WATCH_TURN_REFUSAL } from "../../../../src/services/chat-control/chat-control.ts";

const WEB = join(tmpdir(), "ppm-schedule-unit-web");
const ELSEWHERE = join(tmpdir(), "ppm-schedule-unit-elsewhere");
const PROMPT = "  Review the open PRs.\n\nThen summarise — keep ‮this‬ as written.  ";

const deps: ScheduleDeps = {
  projects: () => [{ name: "web", path: WEB }, { name: "api", path: join(tmpdir(), "ppm-schedule-unit-api") }],
  defaultProvider: () => provider,
  timeZone: () => "Asia/Saigon",
};
let provider = "claude";

const sched = (over: Partial<Schedule> = {}): Schedule => ({
  id: 1, name: "Nightly", cron_expr: "0 7 * * *", provider_id: "claude", project_path: WEB, prompt: PROMPT,
  permission_mode: "bypassPermissions", max_turns: null, timeout_ms: 1_800_000, enabled: 1, session_id: "sess-1",
  last_run_at: null, next_fire_at: "2026-10-12T00:00:00.000Z", created_at: "2026-10-11 10:00:00", updated_at: "2026-10-11 10:00:00",
  ...over,
});
const run = (over: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: 1, schedule_id: 1, session_id: "sess-1", rotated_to_session_id: null, status: "done", output_truncated: "ok",
  context_window_pct: null, cost_usd: 0.01, error: null, started_at: "2026-10-11 10:00:00", ended_at: "2026-10-11 10:01:00", ...over,
});

/** An in-memory `/api/schedules`, recording each call. */
function fakeRoutes(initial: Schedule[], runs: Record<number, ScheduleRun[]> = {}) {
  const store = new Map(initial.map((s) => [s.id, { ...s }]));
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const ok = <T>(data: T, status = 200): RouteCallResult<T> => ({ status, ok: true, data });
  const missing = { status: 404, ok: false, error: "Schedule not found" };
  const callRoute = (async (method, path, body) => {
    calls.push({ method, path, ...(body ? { body } : {}) });
    const url = new URL(path, "http://x");
    const m = /^\/api\/schedules(?:\/(\d+)(?:\/(runs|run-now))?)?$/.exec(url.pathname);
    if (!m) return { status: 403, ok: false, code: ROUTE_NOT_ALLOWED };
    const id = m[1] ? Number(m[1]) : null;
    const s = id === null ? null : store.get(id);
    if (id !== null && !s) return missing;
    if (method === "GET" && id === null) return ok([...store.values()]);
    if (method === "GET" && m[2] === "runs") return ok((runs[id!] ?? []).slice(0, Number(url.searchParams.get("limit") ?? 20)));
    if (method === "GET") return ok(s);
    if (method === "POST" && id === null) {
      const created = sched({ id: 99, name: String(body!.name), cron_expr: String(body!.cron_expr), project_path: String(body!.project_path),
        prompt: String(body!.prompt), permission_mode: String(body!.permission_mode), provider_id: provider });
      store.set(99, created);
      return ok(created, 201);
    }
    if (method === "PATCH") {
      const next = { ...s!, updated_at: "2026-10-11 11:00:00" } as Record<string, unknown>;
      for (const [k, v] of Object.entries(body ?? {})) next[k] = k === "enabled" ? (v ? 1 : 0) : v;
      store.set(id!, next as unknown as Schedule);
      return ok(next);
    }
    if (method === "DELETE") { store.delete(id!); return ok(true); }
    if (method === "POST" && m[2] === "run-now") return ok({ runId: 5, wasRunning: false });
    return { status: 405, ok: false };
  }) as CallPpmRoute;
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { store, calls, writes, callRoute };
}

/** An asker that records cards and answers `verdict`, optionally doing something while it "waits". */
function asker(verdict: ApprovalVerdict = { verdict: "approved" }, whileWaiting?: () => void) {
  const asks: ApprovalAsk[] = [];
  const ask: AskApproval = async (a) => { asks.push(a); whileWaiting?.(); return verdict; };
  return { asks, ask };
}
const neverAsk: AskApproval = async () => { throw new Error("a read must not ask"); };
const ctxOf = (callRoute: CallPpmRoute, ask: AskApproval): ToolContext => ({ sessionId: "s-1", ask, callRoute });
const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

beforeEach(() => { provider = "claude"; });

describe("reading schedules", () => {
  it("lists every schedule without asking, naming the project by its folder", async () => {
    const routes = fakeRoutes([sched(), sched({ id: 2, project_path: ELSEWHERE, prompt: "p".repeat(500) })], { 1: [run({ status: "running", ended_at: null })] });
    const out = parse(await schedulesList(ctxOf(routes.callRoute, neverAsk), {}, deps));
    expect(out.schedules.map((s: { project: string | null }) => s.project)).toEqual(["web", null]);
    expect(out.schedules[0]).toMatchObject({ cron: "0 7 * * *", enabled: true, lastRun: { status: "running", endedAt: null }, promptChars: PROMPT.length });
    expect(out.schedules[1].prompt.startsWith("p".repeat(200))).toBe(true);
    expect(out.schedules[1].promptChars).toBe(500);
    expect(out.timeZone).toBe("Asia/Saigon");
    expect(routes.writes()).toEqual([]);

    const onlyWeb = parse(await schedulesList(ctxOf(routes.callRoute, neverAsk), { project: "web" }, deps));
    expect(onlyWeb.schedules.map((s: { id: number }) => s.id)).toEqual([1]);
    expect(isError(await schedulesList(ctxOf(routes.callRoute, neverAsk), { project: "nope" }, deps))).toBe(true);
  });

  it("reads one schedule in full with its runs as data, without asking", async () => {
    const routes = fakeRoutes([sched()], { 1: [run({ output_truncated: "o".repeat(10_000) }), run({ id: 2 })] });
    const out = parse(await scheduleGet(ctxOf(routes.callRoute, neverAsk), { id: 1, runs: 1 }, deps));
    expect(out.schedule).toMatchObject({ id: 1, project: "web", prompt: PROMPT, timeoutMinutes: 30 });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].output.length).toBeLessThan(4200);
    expect(out.note).toContain("not instructions");
    expect(isError(await scheduleGet(ctxOf(routes.callRoute, neverAsk), { id: 7 }, deps))).toBe(true);
    expect(isError(await scheduleGet(ctxOf(routes.callRoute, neverAsk), { id: 1, runs: 51 }, deps))).toBe(true);
    expect(isError(await scheduleGet(ctxOf(routes.callRoute, neverAsk), { id: "1" }, deps))).toBe(true);
    expect(routes.writes()).toEqual([]);
  });
});

describe("creating a schedule", () => {
  const create = { name: "Nightly", cron: "0 7 * * *", project: "web", prompt: PROMPT };

  it("asks with the prompt verbatim and the bypass warning, then sends exactly what the card showed", async () => {
    const routes = fakeRoutes([]);
    const { asks, ask } = asker();
    const out = parse(await scheduleSave(ctxOf(routes.callRoute, ask), create, deps));
    expect(asks).toHaveLength(1);
    expect(asks[0]!.summary.body).toEqual({ label: "Prompt", text: PROMPT, format: "text" });
    expect(asks[0]!.summary.warning).toBe(SCHEDULE_BYPASS_WARNING);
    expect(asks[0]!.summary.facts.find((f) => f.label === "Next runs")!.value).toContain("(Asia/Saigon)");
    expect(routes.writes()).toEqual([{ method: "POST", path: "/api/schedules", body: {
      name: "Nightly", cron_expr: "0 7 * * *", project_path: WEB, prompt: PROMPT,
      permission_mode: "bypassPermissions", max_turns: null, timeout_ms: 1_800_000, enabled: true,
    } }]);
    expect(out).toMatchObject({ created: true, schedule: { id: 99, project: "web", prompt: PROMPT } });
  });

  it("carries the chosen mode, turn limit and timeout, without the bypass warning", async () => {
    const routes = fakeRoutes([]);
    const { asks, ask } = asker();
    await scheduleSave(ctxOf(routes.callRoute, ask), { ...create, permissionMode: "acceptEdits", maxTurns: 5, timeoutMinutes: 2, enabled: false }, deps);
    expect(asks[0]!.summary.warning).toBeUndefined();
    expect(routes.writes()[0]!.body).toMatchObject({ permission_mode: "acceptEdits", max_turns: 5, timeout_ms: 120_000, enabled: false });
  });

  it("refuses bad input before asking", async () => {
    const bad: Array<Record<string, unknown>> = [
      { name: "x" },
      { ...create, cron: "every morning" },
      { ...create, project: "not-registered" },
      { ...create, project: "__assistant__" },
      { ...create, prompt: "   " },
      { ...create, name: "two\nlines" },
      { ...create, permissionMode: "yolo" },
      { ...create, maxTurns: -1 },
      { ...create, timeoutMinutes: 0.1 },
      { ...create, enabled: "yes" },
      { ...create, id: "abc" },
    ];
    for (const args of bad) {
      const routes = fakeRoutes([]);
      const { asks, ask } = asker();
      const result = await scheduleSave(ctxOf(routes.callRoute, ask), args, deps);
      expect({ args, error: isError(result), asks: asks.length, writes: routes.writes().length }).toEqual({ args, error: true, asks: 0, writes: 0 });
    }
  });

  it("writes nothing when the user declines or the turn is a watch turn", async () => {
    for (const verdict of [
      { verdict: "denied", reason: "no" },
      { verdict: "unavailable", reason: WATCH_TURN_REFUSAL },
      { verdict: "withdrawn", reason: "typed" },
    ] as ApprovalVerdict[]) {
      const routes = fakeRoutes([sched()]);
      const { ask } = asker(verdict);
      const results = [
        await scheduleSave(ctxOf(routes.callRoute, ask), create, deps),
        await scheduleSave(ctxOf(routes.callRoute, ask), { id: 1, enabled: false }, deps),
        await scheduleDelete(ctxOf(routes.callRoute, ask), { id: 1 }, deps),
        await scheduleRunNow(ctxOf(routes.callRoute, ask), { id: 1 }, deps),
      ];
      expect(results.every(isError)).toBe(true);
      expect(routes.writes()).toEqual([]);
    }
  });

  it("is stale when the default provider changed while the card waited", async () => {
    const routes = fakeRoutes([]);
    const { ask } = asker({ verdict: "approved" }, () => { provider = "codex"; });
    const result = await scheduleSave(ctxOf(routes.callRoute, ask), create, deps);
    expect(parse(result).outcome).toBe("stale");
    expect(routes.writes()).toEqual([]);
  });
});

describe("changing a schedule", () => {
  it("sends only the fields that change, listed old → new", async () => {
    const routes = fakeRoutes([sched()]);
    const { asks, ask } = asker();
    const out = parse(await scheduleSave(ctxOf(routes.callRoute, ask), { id: 1, cron: "*/30 * * * *", name: "Nightly" }, deps));
    expect(asks[0]!.summary.facts.find((f) => f.label === "Cron")!.value).toBe("0 7 * * * → */30 * * * *");
    expect(asks[0]!.summary.body).toBeUndefined();
    expect(routes.writes()).toEqual([{ method: "PATCH", path: "/api/schedules/1", body: { cron_expr: "*/30 * * * *" } }]);
    expect(out).toMatchObject({ updated: true, changed: ["cron"], schedule: { cron: "*/30 * * * *" } });
  });

  it("pauses with its own headline, and refuses an edit that changes nothing", async () => {
    const routes = fakeRoutes([sched()]);
    const { asks, ask } = asker();
    await scheduleSave(ctxOf(routes.callRoute, ask), { id: 1, enabled: false }, deps);
    expect(asks[0]!.summary.headline).toStartWith("Pause the schedule");
    expect(routes.writes()).toEqual([{ method: "PATCH", path: "/api/schedules/1", body: { enabled: false } }]);
    const same = await scheduleSave(ctxOf(routes.callRoute, ask), { id: 1, enabled: false, prompt: PROMPT }, deps);
    expect(isError(same)).toBe(true);
    expect(asks).toHaveLength(1);
  });

  it("changes only schedules of registered projects, but still reads the others", async () => {
    const routes = fakeRoutes([sched({ project_path: ELSEWHERE })]);
    const { asks, ask } = asker();
    for (const result of [
      await scheduleSave(ctxOf(routes.callRoute, ask), { id: 1, enabled: false }, deps),
      await scheduleDelete(ctxOf(routes.callRoute, ask), { id: 1 }, deps),
      await scheduleRunNow(ctxOf(routes.callRoute, ask), { id: 1 }, deps),
    ]) {
      expect(isError(result)).toBe(true);
      expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain("not a registered project");
    }
    expect(asks).toEqual([]);
    expect(routes.writes()).toEqual([]);
    expect(isError(await scheduleGet(ctxOf(routes.callRoute, neverAsk), { id: 1 }, deps))).toBe(false);
  });

  it("is stale when the schedule was edited while the card waited", async () => {
    for (const call of [
      (c: ToolContext) => scheduleSave(c, { id: 1, enabled: false }, deps),
      (c: ToolContext) => scheduleDelete(c, { id: 1 }, deps),
      (c: ToolContext) => scheduleRunNow(c, { id: 1 }, deps),
    ]) {
      const routes = fakeRoutes([sched()]);
      const { ask } = asker({ verdict: "approved" }, () => {
        routes.store.set(1, sched({ prompt: "something else", updated_at: "2026-10-11 12:00:00" }));
      });
      const result = await call(ctxOf(routes.callRoute, ask));
      expect(parse(result).outcome).toBe("stale");
      expect(routes.writes()).toEqual([]);
    }
  });

  it("goes ahead when only a run's bookkeeping moved updated_at", async () => {
    const routes = fakeRoutes([sched()]);
    const { ask } = asker({ verdict: "approved" }, () => {
      routes.store.set(1, sched({ last_run_at: "2026-10-11T11:00:00Z", next_fire_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-11 12:00:00" }));
    });
    const result = await scheduleSave(ctxOf(routes.callRoute, ask), { id: 1, enabled: false }, deps);
    expect(isError(result)).toBe(false);
    expect(routes.writes()).toHaveLength(1);
  });

  it("is stale when the schedule was deleted while the card waited", async () => {
    const routes = fakeRoutes([sched()]);
    const { ask } = asker({ verdict: "approved" }, () => { routes.store.delete(1); });
    expect(parse(await scheduleRunNow(ctxOf(routes.callRoute, ask), { id: 1 }, deps)).outcome).toBe("stale");
    expect(routes.writes()).toEqual([]);
  });
});

describe("deleting and running", () => {
  it("counts the runs a delete takes and hands back the whole schedule", async () => {
    const many = Array.from({ length: 200 }, (_, i) => run({ id: i + 1 }));
    const routes = fakeRoutes([sched()], { 1: many });
    const { asks, ask } = asker();
    const out = parse(await scheduleDelete(ctxOf(routes.callRoute, ask), { id: 1 }, deps));
    expect(asks[0]!.summary.body?.text).toBe(PROMPT);
    expect(asks[0]!.summary.facts.find((f) => f.label === "Run history")!.value).toContain("200+");
    expect(routes.writes()).toEqual([{ method: "DELETE", path: "/api/schedules/1" }]);
    expect(out).toMatchObject({ deleted: true, runsDeleted: "200+", schedule: { prompt: PROMPT, cron: "0 7 * * *", permissionMode: "bypassPermissions" } });
  });

  it("warns that a run is already going, then starts one", async () => {
    const routes = fakeRoutes([sched()], { 1: [run({ status: "running", ended_at: null })] });
    const { asks, ask } = asker();
    const out = parse(await scheduleRunNow(ctxOf(routes.callRoute, ask), { id: 1 }, deps));
    expect(asks[0]!.summary.facts.find((f) => f.label === "Already running")).toBeDefined();
    expect(asks[0]!.summary.warning).toBe(SCHEDULE_BYPASS_WARNING);
    expect(asks[0]!.summary.body?.text).toBe(PROMPT);
    expect(routes.writes()).toEqual([{ method: "POST", path: "/api/schedules/1/run-now" }]);
    expect(out).toMatchObject({ started: true, runId: 5, scheduleId: 1, project: "web", sessionId: "sess-1" });
  });
});

describe("the schedule family", () => {
  it("serves its five tools", () => {
    expect(Object.keys(SCHEDULE_TOOL_HANDLERS).sort()).toEqual([...SCHEDULE_TOOLS].sort());
  });

  it("reaches only the schedule routes, and only with the keys they take", async () => {
    const seen: string[] = [];
    const app: RouteApp = { request: async (url) => { seen.push(url); return Response.json({ ok: true, data: [] }); } };
    const call = createRouteCaller(SCHEDULE_ROUTES, { app: async () => app, isProject: () => null });
    const refused: Array<[string, string, Record<string, unknown>?]> = [
      ["GET", "/api/tunnels"],
      ["DELETE", "/api/tunnels/12"],
      ["POST", "/api/tunnel/enabled", { enabled: true }],
      ["GET", "/api/project/web/git/changes"],
      ["GET", "/api/settings"],
      ["PUT", "/api/schedules/1", {}],
      ["DELETE", "/api/schedules"],
      ["GET", "/api/schedules?enabledOnly=true"],
      ["GET", "/api/schedules/1/runs?limit=5&x=1"],
      ["GET", "/api/schedules/1/runs?limit=5&limit=6"],
      ["POST", "/api/schedules/1/run-now/extra", {}],
      ["GET", "/api/schedules/../tunnels"],
      ["GET", "/api/schedules/1%2F..%2F..%2Ftunnels"],
    ];
    for (const [method, path, body] of refused) {
      const res = await call(method as never, path, body);
      expect({ method, path, code: res.code }).toEqual({ method, path, code: ROUTE_NOT_ALLOWED });
    }
    expect(seen).toEqual([]);
    for (const [method, path] of [["GET", "/api/schedules"], ["GET", "/api/schedules/1/runs?limit=5"], ["POST", "/api/schedules/1/run-now"], ["PATCH", "/api/schedules/1"], ["DELETE", "/api/schedules/1"]]) {
      expect((await call(method as never, path!, method === "POST" || method === "PATCH" ? {} : undefined)).ok).toBe(true);
    }
    expect(seen).toHaveLength(5);
  });
});
