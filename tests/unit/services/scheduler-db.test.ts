import { describe, it, expect, beforeEach } from "bun:test";
import { openTestDb, setDb, getDb, CURRENT_SCHEMA_VERSION } from "../../../src/services/db.service.ts";
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
  getEarliestFireAt,
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

  it("cleanupScheduleRuns leaves a script's long-running row to the always-on supervisor", () => {
    const id = insertSchedule({ ...baseSchedule, kind: "script", mode: "always-on", cron_expr: "", prompt: "", script: "x" });
    const life = insertScheduleRun(id, null);
    getDb().query("UPDATE schedule_runs SET started_at = datetime('now', '-5 hours') WHERE id = ?").run(life);
    cleanupScheduleRuns();
    expect(listScheduleRuns(id)[0]!.status).toBe("running");
  });
});

describe("scheduler-db.service: script schedules (v57)", () => {
  beforeEach(() => {
    setDb(openTestDb());
  });

  it("the database ends at the current schema version", () => {
    const { user_version } = getDb().query("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
  });

  it("a schedule saved without the new fields is a prompt run on a cron, as every older one was", () => {
    const id = insertSchedule(baseSchedule);
    const s = getSchedule(id)!;
    expect(s.kind).toBe("prompt");
    expect(s.mode).toBe("tick");
    expect(s.description).toBe("");
    expect(s.script).toBeNull();
    expect(JSON.parse(s.inputs_json)).toEqual([]);
    expect(JSON.parse(s.input_values_json)).toEqual({});
    expect(s.secrets_enc).toBeNull();
    expect(s.state_json).toBeNull();
  });

  it("stores a script schedule's fields", () => {
    const id = insertSchedule({
      ...baseSchedule, prompt: "", cron_expr: "", kind: "script", mode: "always-on", description: "d",
      script: "export default async () => {}", inputs_json: '[{"key":"a","label":"A","type":"text"}]',
      input_values_json: '{"a":"x"}', secrets_enc: "enc",
    });
    const s = getSchedule(id)!;
    expect([s.kind, s.mode, s.description, s.script, s.secrets_enc]).toEqual(["script", "always-on", "d", "export default async () => {}", "enc"]);
    expect(JSON.parse(s.input_values_json)).toEqual({ a: "x" });
  });

  it("refuses a kind or mode it does not know", () => {
    const id = insertSchedule(baseSchedule);
    expect(() => getDb().query("UPDATE schedules SET kind = 'shell' WHERE id = ?").run(id)).toThrow();
    expect(() => getDb().query("UPDATE schedules SET mode = 'daily' WHERE id = ?").run(id)).toThrow();
  });

  it("deleting a schedule deletes its chats, background turns and runtime row", () => {
    const id = insertSchedule({ ...baseSchedule, kind: "script", script: "x", prompt: "" });
    const db = getDb();
    db.query("INSERT INTO schedule_chats (schedule_id, key, session_id) VALUES (?, 'k', 's1')").run(id);
    db.query("INSERT INTO schedule_ai_turns (schedule_id, key, session_id, status) VALUES (?, 'k', 's1', 'running')").run(id);
    db.query("INSERT INTO schedule_runtime (schedule_id, pid, token) VALUES (?, 123, 't')").run(id);
    deleteSchedule(id);
    for (const table of ["schedule_chats", "schedule_ai_turns", "schedule_runtime"]) {
      const { n } = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(n).toBe(0);
    }
  });

  it("getEarliestFireAt is the soonest fire among enabled schedules", () => {
    expect(getEarliestFireAt()).toBeNull();
    insertSchedule({ ...baseSchedule, next_fire_at: "2026-10-12T10:00:30.000Z" });
    insertSchedule({ ...baseSchedule, next_fire_at: "2026-10-12T10:00:05.000Z", enabled: false });
    insertSchedule({ ...baseSchedule, next_fire_at: "2026-10-12T10:00:10.000Z" });
    insertSchedule({ ...baseSchedule, mode: "always-on", next_fire_at: null });
    expect(getEarliestFireAt()).toBe("2026-10-12T10:00:10.000Z");
  });
});
