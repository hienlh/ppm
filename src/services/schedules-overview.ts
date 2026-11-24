/**
 * The Schedules window's list: every schedule as a view, plus what the window shows beside it —
 * its newest run, the project it belongs to, the permission mode its turns really run in, and
 * the task a reminder belongs to. Read in one request so the window and the rail's count need
 * nothing else; the newest runs and the chat titles are indexed lookups, and the per-row reads
 * (the chat's mode, the task) touch only the rows that have one.
 */
import type { Schedule, ScheduleOverview, ScheduleTaskLink, ScheduleView } from "../types/scheduler.ts";
import { formatTaskRef } from "../shared/ppm-tasks-refs.ts";
import { configService } from "./config.service.ts";
import { getSessionTitles, getStoredPermissionModeAnyAlias } from "./db.service.ts";
import { projectNameForPath } from "./project-name-for-path.ts";
import { getTask } from "./ppm-tasks/ppm-tasks-read.ts";
import { lastRunsFor } from "./scheduler-db.service.ts";
import { nextFireAt } from "./scheduler-timing.ts";
import { taskProjectName } from "./task-reminders/task-project-name.ts";
import { toScheduleView } from "./scheduler-view.ts";

/** Views with each session schedule's chat title and each owning chat's title, read in one query. */
export function withChatTitles(views: ScheduleView[]): ScheduleView[] {
  const ids = [...new Set(views.flatMap((v) => [
    ...(v.kind === "session" && v.target_session_id ? [v.target_session_id] : []),
    ...(v.created_by_session_id ? [v.created_by_session_id] : []),
  ]))];
  if (ids.length === 0) return views;
  const titles = getSessionTitles(ids);
  return views.map((v) => ({
    ...v,
    ...(v.kind === "session" ? { target_title: titles[v.target_session_id ?? ""] ?? null } : {}),
    ...(v.created_by_session_id ? { owner_title: titles[v.created_by_session_id] ?? null } : {}),
  }));
}

/**
 * The mode a message would run in now in a chat. The routes pass the chat socket's own answer
 * (`chatTargetMode`: a running subprocess's mode, else the stored one, else the provider's default);
 * without one, the stored mode and the provider's configured default stand in.
 */
export type ChatModeResolver = (sessionId: string, providerId: string) => string;

const storedOrDefaultMode: ChatModeResolver = (sessionId, providerId) => {
  const stored = getStoredPermissionModeAnyAlias(sessionId);
  if (stored) return stored;
  try {
    return configService.get("ai")?.providers?.[providerId]?.permission_mode ?? "bypassPermissions";
  } catch {
    return "bypassPermissions";
  }
};

/**
 * The mode a schedule's turns run in. A session schedule's turn is an ordinary turn of its chat,
 * so the chat's mode decides, whatever the row's own (unused) column says.
 */
export function effectivePermissionMode(
  s: Pick<Schedule, "kind" | "permission_mode" | "target_session_id" | "provider_id">, chatMode: ChatModeResolver = storedOrDefaultMode,
): string {
  if (s.kind !== "session") return s.permission_mode;
  return s.target_session_id ? chatMode(s.target_session_id, s.provider_id) : storedOrDefaultMode("", s.provider_id);
}

/**
 * The next `count` fires, computed on the host where the scheduler reads the cron (its own zone,
 * else the host's), so a browser in another zone shows the instants the schedule really fires at.
 */
export function nextFires(s: Pick<Schedule, "mode" | "enabled" | "cron_expr" | "timezone" | "kind" | "recurring" | "next_fire_at">, count = 3): string[] {
  if (s.mode !== "tick" || !s.enabled || !s.next_fire_at) return [];
  const fires = [s.next_fire_at];
  if (s.kind === "session" && !s.recurring) return fires;
  try {
    while (fires.length < count) {
      const next = nextFireAt(s.cron_expr, s.timezone, new Date(Date.parse(fires.at(-1)!) + 1000));
      if (!next) break;
      fires.push(next);
    }
  } catch { /* a cron that no longer parses has only the fire already stored */ }
  return fires;
}

/** The task a reminder belongs to; null when it has none or the task is gone. */
export function taskLinkOf(taskId: string | null): ScheduleTaskLink | null {
  if (!taskId) return null;
  const task = getTask(taskId);
  if (!task) return null;
  const project = taskProjectName(task.projectKey);
  return {
    id: task.id,
    ref: formatTaskRef(task.number, project),
    title: task.title,
    project,
    closed: task.baseGroup === "closed" || task.deletedAt !== null,
  };
}

export function toScheduleOverviews(rows: Schedule[], chatMode?: ChatModeResolver): ScheduleOverview[] {
  const views = withChatTitles(rows.map(toScheduleView));
  const runs = lastRunsFor(rows.map((r) => r.id));
  const names = new Map<string, string | null>();
  const nameOf = (path: string): string | null => {
    if (!names.has(path)) {
      // A config that cannot be read names no project; the row is still listed, by its folder.
      let name: string | null = null;
      try { name = projectNameForPath(path); } catch { /* unreadable config */ }
      names.set(path, name);
    }
    return names.get(path) ?? null;
  };
  return views.map((v) => ({
    ...v,
    last_run: runs.get(v.id) ?? null,
    project_name: nameOf(v.project_path),
    effective_permission_mode: effectivePermissionMode(v, chatMode),
    next_fires: nextFires(v),
    task: taskLinkOf(v.task_id),
  }));
}
