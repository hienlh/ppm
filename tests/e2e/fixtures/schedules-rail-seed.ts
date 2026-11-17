/**
 * The demo data of the Schedules window e2e: two projects with tasks switched on and a manager chat
 * each, and one schedule of every shape the window has to show. Times are relative to the moment
 * the fixture starts, so every run sees the same groups whatever the clock says.
 */
import { getDb, setSessionMetadata, setSessionPermissionMode, setSessionProvider, setSessionTitle } from "../../../src/services/db.service";
import { projectKey } from "../../../src/services/project-name-for-path";
import { createTask } from "../../../src/services/ppm-tasks/ppm-tasks.service";
import { enableOnManagerAssigned, setTasksEnabled } from "../../../src/services/ppm-tasks/ppm-tasks-projects.service";
import { insertSchedule, insertScheduleRun, updateSchedule, updateScheduleRun } from "../../../src/services/scheduler-db.service";
import { createSessionSchedule } from "../../../src/services/session-schedules/session-schedule-save";
import { createTaskReminder } from "../../../src/services/task-reminders/task-reminders.service";
import { nextFireAt } from "../../../src/services/scheduler-timing";
import { localMomentText } from "../../../src/shared/task-reminder";
import type { WriteContext } from "../../../src/shared/ppm-tasks";

const USER: WriteContext = { actor: { kind: "user", label: "You" }, via: "ppm" };
const H = 3_600_000;

function chat(project: string, path: string, title: string, mode: string): string {
  const id = crypto.randomUUID();
  setSessionMetadata(id, project, path);
  setSessionProvider(id, "claude");
  setSessionTitle(id, title);
  setSessionPermissionMode(id, mode);
  return id;
}

function manager(path: string, sessionId: string): void {
  const key = projectKey(path);
  getDb().query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES (?, ?, ?, 'claude', 'user', 1)")
    .run(key, path, sessionId);
  enableOnManagerAssigned(key, path);
}

/** A daily cron whose next fire is `ms` from now, on this machine's clock. */
function dailyIn(ms: number): string {
  const at = new Date(Date.now() + ms);
  return `${at.getMinutes()} ${at.getHours()} * * *`;
}

export function seedSchedulesRail({ alpha, beta }: { alpha: string; beta: string }) {
  for (const p of [alpha, beta]) setTasksEnabled(p, true, USER);
  const qlAlpha = chat("alpha", alpha, "QL alpha", "bypassPermissions");
  const qlBeta = chat("beta", beta, "QL beta", "bypassPermissions");
  manager(alpha, qlAlpha);
  manager(beta, qlBeta);
  const review = createTask({ projectKey: projectKey(beta), title: "Review PR #412: payment retries" }, USER);
  createTask({ projectKey: projectKey(alpha), title: "Fix flaky login test" }, USER);

  // A nightly sweep in Bypass whose last run failed: needs attention.
  const nightly = insertSchedule({
    name: "Nightly test sweep", cron_expr: dailyIn(7 * H),
    provider_id: "claude", project_path: alpha, permission_mode: "bypassPermissions",
    prompt: "Run the full test suite on main. If anything fails, open a task with the failing test names and the first error, then post a one-line summary to the manager chat.",
  });
  const failed = insertScheduleRun(nightly, null, "error");
  updateScheduleRun(failed, { error: "Timed out after 30m\n(at the e2e suite)", ended_at: new Date(Date.now() - 9 * H).toISOString() });

  // A chat reminder in UK time that came due and is still waiting for its chat: needs attention.
  const scan = createSessionSchedule({
    target_session_id: qlAlpha, name: "Review queue scan", cron_expr: "*/5 * * * *", timezone: "Europe/London",
    prompt: "Look at the review queue and tell me what is waiting on me.",
  });
  updateSchedule(scan.id, { pending_since: new Date(Date.now() - 14 * 60_000).toISOString() });

  // The task page's reminder: one-shot, UK time, owned by the task.
  const remindAt = localMomentText(new Date(Date.now() + 5 * H), "Europe/London").replace(/\d$/, "0");
  const reminder = createTaskReminder(review.id, { at: remindAt, timezone: "Europe/London", note: "Ask Minh if it is not approved." });

  // An Edits-mode digest that ran fine, due tomorrow morning.
  const digest = insertSchedule({
    name: "Daily standup digest", cron_expr: dailyIn(15 * H), provider_id: "claude", project_path: beta,
    permission_mode: "acceptEdits", prompt: "Summarise yesterday's commits and open PRs for the standup.",
  });
  const ok = insertScheduleRun(digest, null, "done");
  updateScheduleRun(ok, { ended_at: new Date(Date.now() - 20 * H).toISOString() });

  // Weekly, days away, and one turned off.
  const weekly = insertSchedule({
    name: "Release notes draft", cron_expr: "0 16 * * 5", provider_id: "claude", project_path: alpha,
    prompt: "Draft the release notes from this week's merged PRs.",
  });
  const off = insertSchedule({
    name: "Weekly dependency audit", cron_expr: "0 9 * * 1", provider_id: "claude", project_path: beta, enabled: false,
    permission_mode: "default", prompt: "Audit the dependencies for known vulnerabilities.",
  });
  for (const id of [nightly, digest, weekly]) {
    const row = getDb().query("SELECT cron_expr FROM schedules WHERE id = ?").get(id) as { cron_expr: string };
    updateSchedule(id, { next_fire_at: nextFireAt(row.cron_expr) });
  }
  return { qlAlpha, qlBeta, taskId: review.id, ids: { nightly, scan: scan.id, reminder: reminder.id, digest, weekly, off } };
}
