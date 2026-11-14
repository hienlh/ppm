/**
 * After a write the REST router did not carry out (the AI's schedule tool, say): the scheduler
 * re-arms for the new next fire, and every open PPM re-reads its schedules on `schedules:changed`,
 * as after a write through `/api/schedules`.
 *
 * Imported late: the scheduler's own modules reach the session-schedule ones, and the chat socket
 * module reaches nearly everything, so a static import here would close a cycle.
 */
import { createLogger } from "../logger.ts";

const log = createLogger("scheduler");

export function announceSchedulesChanged(): void {
  void Promise.all([import("../scheduler.service.ts"), import("../../server/ws/global.ts")])
    .then(([{ schedulerService }, { broadcastGlobalEvent }]) => {
      schedulerService.rearm();
      broadcastGlobalEvent({ type: "schedules:changed" });
    })
    .catch((e) => log.warn(`could not announce a schedule change: ${(e as Error).message}`));
}
