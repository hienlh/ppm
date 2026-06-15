import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { configService } from "../../src/services/config.service.ts";

// ── Mocks (must precede route import) ────────────────────────────────
// scheduler.service is a tiny singleton wrapper — mocking it keeps the
// runner→chat→provider→SDK chain out of this test process entirely.
const runJobNowMock = mock(() => ({ runId: 7, wasRunning: false }));
mock.module("../../src/services/scheduler.service.ts", () => ({
  schedulerService: { runJobNow: runJobNowMock },
}));

// Monkey-patch (not mock.module) so later test files still get the real configService
const originalGet = configService.get.bind(configService);
configService.get = ((key: string) =>
  key === "ai" ? { default_provider: "claude-agent-sdk" } : undefined) as typeof configService.get;
afterAll(() => { configService.get = originalGet; });

const { schedulesRoutes } = await import("../../src/server/routes/schedules.ts");
const { insertSchedule, listScheduleRuns, insertScheduleRun } = await import("../../src/services/scheduler-db.service.ts");

const validBody = {
  name: "api-test",
  cron_expr: "0 7 * * *",
  project_path: "/tmp/p",
  prompt: "review PRs",
};

const post = (path: string, body?: unknown) =>
  schedulesRoutes.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });

describe("schedules routes", () => {
  beforeEach(() => {
    setDb(openTestDb());
    runJobNowMock.mockClear();
  });

  it("POST / creates a schedule with snapshot provider_id and next_fire_at", async () => {
    const res = await post("/", validBody);
    expect(res.status).toBe(201);
    const { data } = await res.json() as { data: Record<string, unknown> };
    expect(data.provider_id).toBe("claude-agent-sdk");
    expect(data.next_fire_at).not.toBeNull();
  });

  it("POST / rejects invalid cron with 400", async () => {
    const res = await post("/", { ...validBody, cron_expr: "not a cron" });
    expect(res.status).toBe(400);
    const { error } = await res.json() as { error: string };
    expect(error).toContain("Invalid cron");
  });

  it("POST / rejects missing fields with 400", async () => {
    const res = await post("/", { name: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid budget numbers with 400", async () => {
    expect((await post("/", { ...validBody, max_turns: -5 })).status).toBe(400);
    expect((await post("/", { ...validBody, timeout_ms: 50 })).status).toBe(400);
    expect((await post("/", { ...validBody, max_turns: "abc" })).status).toBe(400);

    await post("/", validBody);
    const res = await schedulesRoutes.request("/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout_ms: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("GET / lists, GET /:id fetches, 404 on unknown", async () => {
    await post("/", validBody);
    const list = await schedulesRoutes.request("/");
    const { data } = await list.json() as { data: unknown[] };
    expect(data).toHaveLength(1);

    expect((await schedulesRoutes.request("/1")).status).toBe(200);
    expect((await schedulesRoutes.request("/999")).status).toBe(404);
  });

  it("PATCH /:id updates fields and recomputes next_fire_at on cron change", async () => {
    await post("/", validBody);
    const res = await schedulesRoutes.request("/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expr: "*/10 * * * *", enabled: false }),
    });
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { cron_expr: string; enabled: number } };
    expect(data.cron_expr).toBe("*/10 * * * *");
    expect(data.enabled).toBe(0);
  });

  it("PATCH /:id rejects invalid cron", async () => {
    await post("/", validBody);
    const res = await schedulesRoutes.request("/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expr: "garbage" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /:id removes schedule", async () => {
    await post("/", validBody);
    expect((await schedulesRoutes.request("/1", { method: "DELETE" })).status).toBe(200);
    expect((await schedulesRoutes.request("/1")).status).toBe(404);
  });

  it("POST /:id/run-now delegates to schedulerService with runId + wasRunning", async () => {
    await post("/", validBody);
    const res = await post("/1/run-now");
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { runId: number; wasRunning: boolean } };
    expect(data.runId).toBe(7);
    expect(runJobNowMock).toHaveBeenCalledWith(1);
  });

  it("GET /:id/runs returns run history", async () => {
    await post("/", validBody);
    insertScheduleRun(1, "sess-1", "done");
    const res = await schedulesRoutes.request("/1/runs?limit=5");
    const { data } = await res.json() as { data: unknown[] };
    expect(data).toHaveLength(1);
    expect(listScheduleRuns(1)).toHaveLength(1);
  });
});
