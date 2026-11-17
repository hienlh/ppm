/**
 * Background work of the task store, started once by the server: the daily history compaction, the
 * live link states (registered as the store's link-state source, refreshed every 15 minutes), the
 * handed-off work checker and the snooze sweep (every minute, and whenever a link's state moves).
 * Every timer is unref'd so none holds the process open.
 */
import { createLogger } from "../logger.ts";
import { compactHistory } from "./ppm-tasks-compaction.ts";
import { setTaskLinkStateSource } from "./ppm-tasks-link-state-source.ts";
import { createLinkStateService, type LinkStateService } from "./link-state/ppm-tasks-link-state.service.ts";
import { createChildCheckRunner, type ChildCheckRunner } from "./child-check/child-check-runner.ts";
import { ppmTasksEvents } from "./ppm-tasks-events.ts";
import { resurfaceDueTasks } from "./ppm-tasks-snooze.ts";
// Registers the listener that lifts a paused wake budget when the user writes in a manager chat.
import "./ppm-tasks-wake-budget.ts";

const log = createLogger("ppm-tasks");
const DAY = 86_400_000;
let timer: ReturnType<typeof setInterval> | null = null;
let linkStates: LinkStateService | null = null;
let childChecks: ChildCheckRunner | null = null;
let snoozeTimer: ReturnType<typeof setInterval> | null = null;
let offLinkStates: (() => void) | null = null;

/** How often snoozed tasks are checked for their day; a link change is acted on as it lands. */
export const SNOOZE_SWEEP_MS = 60_000;

function runCompaction(): void {
  try {
    const removed = compactHistory();
    if (removed > 0) log.info(`compacted ${removed} task history rows older than 90 days`);
  } catch (e) {
    log.warn(`task history compaction failed: ${(e as Error).message}`);
  }
}

export function startPpmTasks(): void {
  if (timer) return;
  // Once shortly after start (off the boot path), then daily.
  setTimeout(runCompaction, 60_000).unref?.();
  timer = setInterval(runCompaction, DAY);
  timer.unref?.();
  linkStates = createLinkStateService();
  setTaskLinkStateSource(linkStates.source);
  linkStates.start();
  childChecks = createChildCheckRunner();
  childChecks.start();
  setTimeout(() => resurfaceDueTasks(), 5_000).unref?.();
  snoozeTimer = setInterval(() => resurfaceDueTasks(), SNOOZE_SWEEP_MS);
  snoozeTimer.unref?.();
  offLinkStates = ppmTasksEvents.on((e) => {
    // After the listener returns: the checker emits before its next batch, and a sweep writes.
    if (e.type === "link_states") queueMicrotask(() => resurfaceDueTasks(Date.now(), e.projectKeys));
  });
}

export function stopPpmTasks(): void {
  if (timer) clearInterval(timer);
  timer = null;
  linkStates?.stop();
  linkStates = null;
  setTaskLinkStateSource(null);
  childChecks?.stop();
  childChecks = null;
  if (snoozeTimer) clearInterval(snoozeTimer);
  snoozeTimer = null;
  offLinkStates?.();
  offLinkStates = null;
}
