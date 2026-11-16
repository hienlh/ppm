/**
 * Background work of the task store, started once by the server: the daily history compaction, the
 * live link states (registered as the store's link-state source, refreshed every 15 minutes) and
 * the handed-off work checker. Every timer is unref'd so none holds the process open.
 */
import { createLogger } from "../logger.ts";
import { compactHistory } from "./ppm-tasks-compaction.ts";
import { setTaskLinkStateSource } from "./ppm-tasks-link-state-source.ts";
import { createLinkStateService, type LinkStateService } from "./link-state/ppm-tasks-link-state.service.ts";
import { createChildCheckRunner, type ChildCheckRunner } from "./child-check/child-check-runner.ts";
// Registers the listener that lifts a paused wake budget when the user writes in a manager chat.
import "./ppm-tasks-wake-budget.ts";

const log = createLogger("ppm-tasks");
const DAY = 86_400_000;
let timer: ReturnType<typeof setInterval> | null = null;
let linkStates: LinkStateService | null = null;
let childChecks: ChildCheckRunner | null = null;

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
}

export function stopPpmTasks(): void {
  if (timer) clearInterval(timer);
  timer = null;
  linkStates?.stop();
  linkStates = null;
  setTaskLinkStateSource(null);
  childChecks?.stop();
  childChecks = null;
}
