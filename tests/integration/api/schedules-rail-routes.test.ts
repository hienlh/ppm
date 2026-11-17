/**
 * The Schedules window's backend against the real app: the list answers each schedule with its
 * newest run, project, effective permission mode and task; Dismiss silences one problem and only
 * that one; a task page reminder is a one-shot schedule into the manager chat that the task owns,
 * and closing or deleting the task deletes it; the AI's `session_schedule_create` may tie its
 * schedule only to an open task of its own chat's project.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../test-setup.ts";
import { app } from "../../../src/server/index.ts";
import { configService } from "../../../src/services/config.service.ts";
import {
  getDb, openTestDb, setDb, setSessionMetadata, setSessionPermissionMode, setSessionProvider,
} from "../../../src/services/db.service.ts";
import { projectKey as keyOf } from "../../../src/services/project-name-for-path.ts";
import { closeTask, createTask, softDeleteTask } from "../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { enableOnManagerAssigned, setTasksEnabled } from "../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { getSchedule, insertSchedule, insertScheduleRun, listSchedulesForTask, updateScheduleRun } from "../../../src/services/scheduler-db.service.ts";
import { nextFireAt } from "../../../src/services/scheduler-timing.ts";
import { startTaskReminderCleanup } from "../../../src/services/task-reminders/task-reminder-cleanup.ts";
import { createSessionSchedule } from "../../../src/services/session-schedules/session-schedule-save.ts";
import { scheduleAttention } from "../../../src/shared/schedule-attention.ts";
import type { WriteContext } from "../../../src/shared/ppm-tasks.ts";
import type { ScheduleOverview } from "../../../src/types/scheduler.ts";

const USER: WriteContext = { actor: { kind: "user", label: "You" }, via: "ppm" };

let root: string;
let otherRoot: string;
let key: string;
let savedProjects: unknown;
let stopCleanup: (() => void) | null = null;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-sched-rail-"));
  otherRoot = mkdtempSync(join(tmpdir(), "ppm-sched-rail-other-"));
  savedProjects = configService.get("projects");
});

afterAll(async () => {
  stopCleanup?.();
  configService.set("projects", savedProjects as never);
  for (const dir of [root, otherRoot]) {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 40) throw e;
        await Bun.sleep(100);
      }
    }
  }
});

beforeEach(() => {
  stopCleanup?.();
  setDb(openTestDb());
  configService.set("projects", [{ name: "alpha", path: root }, { name: "beta", path: otherRoot }]);
  key = keyOf(root);
  setTasksEnabled(root, true, USER);
  setTasksEnabled(otherRoot, true, USER);
  stopCleanup = startTaskReminderCleanup();
});

type Envelope<T> = { ok: boolean; data?: T; error?: string; problems?: string[] };

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: Envelope<T> }> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(new Request(`http://localhost${path}`, init));
  return { status: res.status, json: await res.json() as Envelope<T> };
}

/** A Claude chat of the project as PPM stores one: the only kind a schedule can reach. */
async function chatIn(projectName: string, projectPath: string): Promise<string> {
  const id = crypto.randomUUID();
  setSessionMetadata(id, projectName, projectPath);
  setSessionProvider(id, "claude");
  return id;
}

function assignManager(sessionId: string): void {
  getDb().query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, 'user', 1)")
    .run(key, root, sessionId, "claude");
  enableOnManagerAssigned(key, root);
}

/** A local moment `days` ahead on the clock of `zone`, as the task page sends it. */
function ahead(days: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(Date.now() + days * 86_400_000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T18:30`;
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("GET /api/schedules", () => {
  it("answers each schedule with its newest real run, project, effective mode and task", async () => {
    const chat = await chatIn("alpha", root);
    setSessionPermissionMode(chat, "acceptEdits");
    const task = createTask({ projectKey: key, title: "Review PR 412" }, USER);
    const reminder = createSessionSchedule({ target_session_id: chat, cron_expr: "30 18 17 11 *", prompt: "check", recurring: false, timezone: "Europe/London", task_id: task.id });
    const promptId = insertSchedule({
      name: "Nightly", cron_expr: "0 2 * * *", provider_id: "claude", project_path: root, prompt: "run tests", next_fire_at: nextFireAt("0 2 * * *"),
    });
    const failed = insertScheduleRun(promptId, null, "error");
    updateScheduleRun(failed, { error: "timed out", ended_at: new Date().toISOString() });
    insertScheduleRun(promptId, null, "skipped");

    const { status, json } = await call<ScheduleOverview[]>("GET", "/api/schedules");
    expect(status).toBe(200);
    const byId = new Map(json.data!.map((s) => [s.id, s]));
    const nightly = byId.get(promptId)!;
    expect(nightly.project_name).toBe("alpha");
    expect(nightly.effective_permission_mode).toBe("bypassPermissions");
    expect(nightly.last_run).toMatchObject({ id: failed, status: "error", error: "timed out" });
    const remind = byId.get(reminder.id)!;
    // A chat reminder runs in its chat's own mode, not the row's unused default.
    expect(remind.permission_mode).toBe("bypassPermissions");
    expect(remind.effective_permission_mode).toBe("acceptEdits");
    expect(remind.task).toMatchObject({ id: task.id, ref: "alpha/1", title: "Review PR 412", closed: false });
    expect(remind.last_run).toBeNull();
    // The next fires come from the host: three for a repeating schedule, the one for a one-shot.
    expect(nightly.next_fires).toHaveLength(3);
    expect(nightly.next_fires[0]).toBe(nightly.next_fire_at!);
    expect(Date.parse(nightly.next_fires[1]!) - Date.parse(nightly.next_fires[0]!)).toBe(86_400_000);
    expect(remind.next_fires).toEqual([remind.next_fire_at!]);

    const forTask = await call<ScheduleOverview[]>("GET", `/api/schedules?task=${task.id}`);
    expect(forTask.json.data!.map((s) => s.id)).toEqual([reminder.id]);
    expect((await call("GET", "/api/schedules?task=not-an-id")).status).toBe(400);
  });
});

describe("POST /api/schedules/:id/dismiss", () => {
  it("silences the problem it names, refuses a stale key, and lets a new failure show again", async () => {
    const id = insertSchedule({ name: "Nightly", cron_expr: "0 2 * * *", provider_id: "claude", project_path: root, prompt: "run tests" });
    const first = insertScheduleRun(id, null, "error");
    const listed = (await call<ScheduleOverview[]>("GET", "/api/schedules")).json.data![0]!;
    expect(scheduleAttention(listed)?.key).toBe(`failed:${first}`);

    expect((await call("POST", `/api/schedules/${id}/dismiss`, { key: "failed:999" })).status).toBe(409);
    const dismissed = await call<ScheduleOverview>("POST", `/api/schedules/${id}/dismiss`, { key: `failed:${first}` });
    expect(dismissed.status).toBe(200);
    expect(scheduleAttention(dismissed.json.data!)).toBeNull();
    expect(getSchedule(id)!.attention_dismissed).toBe(`failed:${first}`);

    const second = insertScheduleRun(id, null, "error");
    const again = (await call<ScheduleOverview>("GET", `/api/schedules/${id}`)).json.data!;
    expect(scheduleAttention(again)?.key).toBe(`failed:${second}`);

    // A run that succeeds clears it with no dismiss at all.
    const ok = insertScheduleRun(id, null, "done");
    updateScheduleRun(ok, { ended_at: new Date().toISOString() });
    expect(scheduleAttention((await call<ScheduleOverview>("GET", `/api/schedules/${id}`)).json.data!)).toBeNull();
    expect((await call("POST", `/api/schedules/${id}/dismiss`, { key: 3 })).status).toBe(400);
  });
});

describe("task reminders", () => {
  it("creates a one-shot reminder into the manager chat, owned by the task", async () => {
    const manager = await chatIn("alpha", root);
    assignManager(manager);
    const task = createTask({ projectKey: key, title: "Review PR 412" }, USER);
    const at = ahead(2, "Europe/London");
    const res = await call<ScheduleOverview>("POST", `/api/tasks/${task.id}/reminders`, { at, timezone: "Europe/London", note: "ask Minh" });
    expect(res.status).toBe(201);
    const r = res.json.data!;
    expect(r).toMatchObject({ kind: "session", target_session_id: manager, timezone: "Europe/London", recurring: 0, task_id: task.id });
    const [, month, day] = at.slice(0, 10).split("-").map(Number);
    expect(r.cron_expr).toBe(`30 18 ${day} ${month} *`);
    expect(r.prompt).toContain("alpha/1");
    expect(r.prompt).toContain("Note: ask Minh");
    // 18:30 on the London clock, whatever this machine's zone is.
    const london = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(r.next_fire_at!));
    expect(london).toBe("18:30");
  });

  it("refuses a time that has passed, one more than a year ahead, a bad zone and a closed task", async () => {
    assignManager(await chatIn("alpha", root));
    const task = createTask({ projectKey: key, title: "T" }, USER);
    const past = await call("POST", `/api/tasks/${task.id}/reminders`, { at: ahead(-2, "UTC"), timezone: "UTC" });
    expect(past.status).toBe(400);
    expect(past.json.problems).toEqual(["That time has already passed"]);
    const far = await call("POST", `/api/tasks/${task.id}/reminders`, { at: ahead(400, "UTC"), timezone: "UTC" });
    expect(far.json.problems).toEqual(["A reminder can be set at most a year ahead"]);
    expect((await call("POST", `/api/tasks/${task.id}/reminders`, { at: ahead(2, "UTC"), timezone: "Mars/Base" })).status).toBe(400);
    expect((await call("POST", `/api/tasks/${task.id}/reminders`, { at: "tomorrow", timezone: "UTC" })).status).toBe(400);
    const closed = closeTask(task.id, { closedAs: "done" }, task.revision, USER);
    const late = await call("POST", `/api/tasks/${closed.id}/reminders`, { at: ahead(2, "UTC"), timezone: "UTC" });
    expect(late.status).toBe(400);
    expect(late.json.problems).toEqual(["This task is closed: it needs no reminder"]);
  });

  it("refuses when the project has no chat to remind", async () => {
    const task = createTask({ projectKey: key, title: "T" }, USER);
    const res = await call("POST", `/api/tasks/${task.id}/reminders`, { at: ahead(2, "UTC"), timezone: "UTC" });
    expect(res.status).toBe(400);
    expect(res.json.problems![0]).toContain("no chat to remind");
  });

  it("deletes a task's reminders when the task is closed or deleted, and leaves other tasks' alone", async () => {
    assignManager(await chatIn("alpha", root));
    const done = createTask({ projectKey: key, title: "Done soon" }, USER);
    const gone = createTask({ projectKey: key, title: "Deleted soon" }, USER);
    const stays = createTask({ projectKey: key, title: "Still open" }, USER);
    for (const t of [done, gone, stays]) {
      expect((await call("POST", `/api/tasks/${t.id}/reminders`, { at: ahead(3, "UTC"), timezone: "UTC" })).status).toBe(201);
    }
    closeTask(done.id, { closedAs: "done" }, done.revision, USER);
    softDeleteTask(gone.id, gone.revision, USER);
    await flush();
    expect(listSchedulesForTask(done.id)).toEqual([]);
    expect(listSchedulesForTask(gone.id)).toEqual([]);
    expect(listSchedulesForTask(stays.id)).toHaveLength(1);
  });
});

describe("the AI's session_schedule_create with a task", () => {
  it("links an open task of its own project by reference, and refuses another project's or a closed one", async () => {
    const chat = await chatIn("alpha", root);
    const mine = createTask({ projectKey: key, title: "Mine" }, USER);
    const theirs = createTask({ projectKey: keyOf(otherRoot), title: "Theirs" }, USER);
    const linked = createSessionSchedule({ target_session_id: chat, cron_expr: "0 9 * * *", prompt: "look", task: "#1" });
    expect(linked.task_id).toBe(mine.id);
    expect(createSessionSchedule({ target_session_id: chat, cron_expr: "0 9 * * *", prompt: "look", task: "alpha/1" }).task_id).toBe(mine.id);
    expect(() => createSessionSchedule({ target_session_id: chat, cron_expr: "0 9 * * *", prompt: "x", task: theirs.id })).toThrow(/No task/);
    expect(() => createSessionSchedule({ target_session_id: chat, cron_expr: "0 9 * * *", prompt: "x", task: "beta/1" })).toThrow(/No task/);
    closeTask(mine.id, { closedAs: "done" }, mine.revision, USER);
    await flush();
    expect(getSchedule(linked.id)).toBeNull();
    expect(() => createSessionSchedule({ target_session_id: chat, cron_expr: "0 9 * * *", prompt: "x", task: "#1" })).toThrow(/closed/);
  });
});
