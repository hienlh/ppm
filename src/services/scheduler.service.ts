/** Scheduler singleton — wires the real runner into SchedulerService for server boot.
 * Logic lives in scheduler-core.ts (constructor-injected runner keeps tests mock-free). */
import { SchedulerService, nextFireAt } from "./scheduler-core.ts";
import { ensureScheduleSession, runScheduleOnce } from "./scheduler-runner.ts";

export { nextFireAt };

/** Singleton scheduler — started from server boot. */
export const schedulerService = new SchedulerService({ ensureScheduleSession, runScheduleOnce });
