/**
 * Snoozing on the server: the rules a write must keep (a closed task needs no snooze and loses
 * one it had; "until a link changes" needs a Jira or PR link to watch), and the sweep that brings
 * tasks back. Whether a snooze holds is worked out when tasks are read; the sweep is what records
 * the return — it clears the snooze, stamps `resurfaced_at` (the "Back today" label) and writes a
 * history row signed by PPM, which the manager chat reads as news at its next turn and the
 * morning digest lists. It runs every minute and whenever a link's cached state moves.
 */
import { getDb } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import {
  hasSnooze, hasWatchableLink, snoozeWakeReason, type HistoryChange, type ResurfaceReason, type Task, type WriteContext,
} from "../../shared/ppm-tasks.ts";
import { lastLinkChanges, linksFor, loadTask, rowToTask, statusById, type LinkChange, type TaskRow } from "./ppm-tasks-db.ts";
import { invalid } from "./ppm-tasks-errors.ts";
import { writeHistory } from "./ppm-tasks-history.ts";
import { ppmTasksEvents } from "./ppm-tasks-events.ts";
import { todayYmd } from "./ppm-tasks-today.ts";
import { applyChanges } from "./ppm-tasks-write.ts";

const log = createLogger("ppm-tasks");

/** PPM itself bringing a task back. */
export const PPM_SNOOZE_CTX: WriteContext = { actor: { kind: "ppm", label: "PPM" }, via: "ppm" };

/**
 * Checks and completes the snooze part of a write's values. `current` is the task before the
 * write (null when creating); `statusId` the status it ends in. Closing a snoozed task clears the
 * snooze in the same change; asking to snooze a closed task is refused. Removing the last Jira or
 * PR link of a task snoozed until a link changes stops that half of the snooze, which could
 * otherwise never end.
 */
export function applySnoozeRules(
  current: Pick<Task, "snoozedUntil" | "snoozeUntilChange" | "links"> | null, values: Map<string, unknown>, statusId: string | undefined,
): void {
  const untilAfter = values.has("snoozedUntil") ? values.get("snoozedUntil") as string | null : current?.snoozedUntil ?? null;
  const changeAfter = values.has("snoozeUntilChange") ? values.get("snoozeUntilChange") === true : current?.snoozeUntilChange ?? false;
  const asked = (values.has("snoozedUntil") && values.get("snoozedUntil") !== null) || values.get("snoozeUntilChange") === true;
  const closed = !!statusId && statusById(statusId)?.baseGroup === "closed";
  if (closed) {
    if (asked) throw invalid("A closed task is already out of the daily lists: it needs no snooze");
    if (untilAfter !== null) values.set("snoozedUntil", null);
    if (changeAfter) values.set("snoozeUntilChange", false);
    return;
  }
  if (!changeAfter) return;
  const links = (values.get("links") as Task["links"] | undefined) ?? current?.links ?? [];
  if (hasWatchableLink(links)) return;
  if (values.get("snoozeUntilChange") === true) throw invalid("Snoozing until a link changes needs a Jira or PR link on the task to watch");
  values.set("snoozeUntilChange", false);
}

/** Why a task came back, for its history row and the manager's news. */
export function resurfaceReasonText(reason: ResurfaceReason, link: Pick<LinkChange, "kind" | "ref"> | undefined): string {
  if (reason === "date") return "Snooze ended: its day came";
  return link ? `Snooze ended: ${link.kind === "jira" ? "Jira" : "PR"} ${link.ref} changed` : "Snooze ended: a link changed";
}

/**
 * Brings back every snoozed task whose day has come or whose watched link changed, in switched-on
 * projects (all, or these). Each return is its own change: revision bumped, history row, event.
 * Returns how many came back. Never throws.
 */
export function resurfaceDueTasks(now: number = Date.now(), projectKeys?: readonly string[]): number {
  if (projectKeys && projectKeys.length === 0) return 0;
  let rows: TaskRow[];
  try {
    const scope = projectKeys ? ` AND t.project_key IN (${projectKeys.map(() => "?").join(",")})` : "";
    rows = getDb().query(
      `SELECT t.* FROM tasks t JOIN task_projects p ON p.project_key = t.project_key AND p.enabled = 1
       WHERE t.deleted_at IS NULL AND (t.snoozed_until IS NOT NULL OR t.snooze_until_change = 1)${scope}`,
    ).all(...(projectKeys ?? [])) as TaskRow[];
  } catch (e) {
    log.warn(`snooze sweep could not read tasks: ${(e as Error).message}`);
    return 0;
  }
  if (rows.length === 0) return 0;
  const today = todayYmd(now);
  const links = linksFor(rows.map((r) => r.id));
  const tasks = rows.map((r) => rowToTask(r, links.get(r.id) ?? []));
  const changes = lastLinkChanges(tasks.filter((t) => t.snoozeUntilChange));
  let count = 0;
  for (const task of tasks) {
    const change = changes.get(task.id);
    if (!snoozeWakeReason(task, today, change?.at ?? null)) continue;
    try {
      if (resurface(task.id, today, now)) count++;
    } catch (e) {
      log.warn(`could not bring task ${task.id} back from its snooze: ${(e as Error).message}`);
    }
  }
  if (count > 0) log.info(`brought ${count} snoozed task(s) back`);
  return count;
}

/** One task back from its snooze, checked again inside the transaction. Whether it came back. */
function resurface(id: string, today: string, now: number): boolean {
  let historyId = 0;
  let projectKey = "";
  getDb().transaction(() => {
    const task = loadTask(id);
    if (!task || task.deletedAt !== null || !hasSnooze(task)) return;
    const change = task.snoozeUntilChange ? lastLinkChanges([task]).get(task.id) : undefined;
    const reason = snoozeWakeReason(task, today, change?.at ?? null);
    if (!reason) return;
    const changes: HistoryChange[] = [];
    if (task.snoozedUntil !== null) changes.push({ field: "snoozedUntil", before: task.snoozedUntil, after: null });
    if (task.snoozeUntilChange) changes.push({ field: "snoozeUntilChange", before: true, after: false });
    changes.push({ field: "resurfacedAt", before: task.resurfacedAt, after: now });
    applyChanges(task, changes, now);
    projectKey = task.projectKey;
    historyId = writeHistory({
      taskId: task.id, projectKey, ctx: { ...PPM_SNOOZE_CTX, reason: resurfaceReasonText(reason, change) }, kind: "resurfaced", changes, at: now,
    });
  })();
  if (!historyId) return false;
  ppmTasksEvents.emit({
    type: "task", projectKey, taskIds: [id], historyIds: [historyId], actor: PPM_SNOOZE_CTX.actor, via: "ppm", kind: "resurfaced", unattended: false,
  });
  return true;
}
