/** Scheduler singleton — wires the real runner into SchedulerService for server boot.
 * Logic lives in scheduler-core.ts (constructor-injected runner keeps tests mock-free). */
import { SchedulerService, nextFireAt } from "./scheduler-core.ts";
import { ensureScheduleSession, runScheduleOnce } from "./scheduler-runner.ts";
import { AlwaysOnSupervisor } from "./schedule-script/always-on-supervisor.ts";
import { runScriptTick } from "./schedule-script/tick-runner.ts";

export { nextFireAt };

/** The processes of always-on script schedules. */
export const alwaysOnSupervisor = new AlwaysOnSupervisor();

/** Singleton scheduler — started from server boot. */
export const schedulerService = new SchedulerService(
  { ensureScheduleSession, runScheduleOnce, runScriptTick: (schedule) => runScriptTick(schedule) },
  alwaysOnSupervisor,
);
