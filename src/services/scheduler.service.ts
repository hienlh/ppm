/** Scheduler singleton — wires the real runner into SchedulerService for server boot.
 * Logic lives in scheduler-core.ts (constructor-injected runner keeps tests mock-free). */
import { SchedulerService, nextFireAt } from "./scheduler-core.ts";
import { ensureScheduleSession, runScheduleOnce } from "./scheduler-runner.ts";
import { createLogger } from "./logger.ts";

export { nextFireAt };

const log = createLogger("scheduler");

/**
 * A run ending changes what Settings → Schedules shows (its status, output, last run), and no
 * route write announces it. The same `schedules:changed` the routes send makes an open run
 * history read again. The hub is imported on first use: it pulls in the file watcher and the
 * rest of `/ws/global`, which this module's importers do not need at load time.
 */
function announceRunFinished(): void {
  import("../server/ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: "schedules:changed" }))
    .catch((e) => log.warn(`could not announce a finished run: ${(e as Error).message}`));
}

/** Singleton scheduler — started from server boot. */
export const schedulerService = new SchedulerService({ ensureScheduleSession, runScheduleOnce }, announceRunFinished);
