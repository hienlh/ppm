import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb, getDb } from "../../../src/services/db.service.ts";
import {
  getSchedules,
  getSchedule,
  getDueSchedules,
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  setScheduleSessionId,
  insertScheduleRun,
  updateScheduleRun,
  listScheduleRuns,
  cleanupScheduleRuns,
} from "../../../src/services/scheduler-db.service.ts";

const baseSchedule = {
  name: "test",
  cron_expr: "*/5 * * * *",
  provider_id: "claude-agent-sdk",
  project_path: "/tmp/proj",
  prompt: "do work",
};

describe("scheduler-db.service (SQLite v31)", () => {
  beforeEach(() => {
    setDb(openTestDb());
  });

  it("migration creates schedules + schedule_runs with provider_id", () => {
    const cols = getDb().query("PRAGMA table_info(schedules)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(["provider_id", "cron_expr", "permission_mode", "max_turns", "timeout_ms", "session_id", "next_fire_at"]),
    );
    const runCols = getDb().query("PRAGMA table_info(schedule_runs)").all() as Array<{ name: string }>;
    expect(runCols.map((c) => c.name)).toEqual(
      expect.arrayContaining(["rotated_to_session_id", "output_truncated", "context_window_pct", "cost_usd"]),
    );
  });

  it("insert applies defaults; get/list round-trip", () => {
    const id = insertSchedule(baseSchedule);
    const s = getSchedule(id)!;
    expect(s.permission_mode).toBe("bypassPermissions");
    expect(s.timeout_ms).toBe(1_800_000);
    expect(s.enabled).toBe(1);
    expect(s.max_turns).toBeNull();
    expect(getSchedules()).toHaveLength(1);
  });

  it("getDueSchedules excludes disabled and future schedules", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    insertSchedule({ ...baseSchedule, name: "due", next_fire_at: past });
    insertSchedule({ ...baseSchedule, name: "future", next_fire_at: future });
    insertSchedule({ ...baseSchedule, name: "disabled", enabled: false, next_fire_at: past });
    insertSchedule({ ...baseSchedule, name: "no-fire", next_fire_at: null });

    const due = getDueSchedules(new Date().toISOString());
    expect(due.map((s) => s.name)).toEqual(["due"]);
  });

  it("updateSchedule patches fields and bumps updated_at", () => {
    const id = insertSchedule(baseSchedule);
    updateSchedule(id, { enabled: 0, prompt: "new prompt" });
    const s = getSchedule(id)!;
    expect(s.enabled).toBe(0);
    expect(s.prompt).toBe("new prompt");
  });

  it("setScheduleSessionId persists session linkage", () => {
    const id = insertSchedule(baseSchedule);
    setScheduleSessionId(id, "sess-123");
    expect(getSchedule(id)!.session_id).toBe("sess-123");
  });

  it("deleteSchedule cascades schedule_runs", () => {
    const id = insertSchedule(baseSchedule);
    insertScheduleRun(id, "sess-1");
    insertScheduleRun(id, "sess-1", "skipped");
    expect(listScheduleRuns(id)).toHaveLength(2);

    deleteSchedule(id);
    const orphans = getDb().query("SELECT COUNT(*) as n FROM schedule_runs").get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it("updateScheduleRun writes result fields", () => {
    const id = insertSchedule(baseSchedule);
    const runId = insertScheduleRun(id, "sess-1");
    updateScheduleRun(runId, {
      status: "done",
      output_truncated: "hello",
      context_window_pct: 42.5,
      cost_usd: 0.0123,
      rotated_to_session_id: "sess-2",
      ended_at: new Date().toISOString(),
    });
    const run = listScheduleRuns(id)[0]!;
    expect(run.status).toBe("done");
    expect(run.output_truncated).toBe("hello");
    expect(run.context_window_pct).toBe(42.5);
    expect(run.cost_usd).toBe(0.0123);
    expect(run.rotated_to_session_id).toBe("sess-2");
    expect(run.ended_at).not.toBeNull();
  });

  it("cleanupScheduleRuns orphans stale running rows and prunes >30d", () => {
    const id = insertSchedule(baseSchedule);
    const staleRunning = insertScheduleRun(id, null);
    getDb().query("UPDATE schedule_runs SET started_at = datetime('now', '-3 hours') WHERE id = ?").run(staleRunning);
    const ancient = insertScheduleRun(id, null, "done");
    getDb().query("UPDATE schedule_runs SET started_at = datetime('now', '-31 days') WHERE id = ?").run(ancient);
    const freshRunning = insertScheduleRun(id, null);

    cleanupScheduleRuns();

    const runs = listScheduleRuns(id, 50);
    expect(runs.find((r) => r.id === ancient)).toBeUndefined();
    expect(runs.find((r) => r.id === staleRunning)!.status).toBe("error");
    expect(runs.find((r) => r.id === staleRunning)!.error).toContain("orphaned");
    expect(runs.find((r) => r.id === freshRunning)!.status).toBe("running");
  });
});
