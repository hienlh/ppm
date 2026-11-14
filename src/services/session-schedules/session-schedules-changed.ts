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
  void import("../scheduler.service.ts")
    .then(({ schedulerService }) => {
      schedulerService.rearm();
      broadcastToOpenPpms();
    })
    .catch((e) => log.warn(`could not announce a schedule change: ${(e as Error).message}`));
}

/** Changes within this long go out as one `schedules:changed`: a delivery is several writes. */
const COALESCE_MS = 50;
let pendingBroadcast: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
/** Set while delivery runs in a server; a unit test drives the same code with nobody to tell. */
let broadcaster: (() => void) | null = null;

/** Tells every open PPM through the app-wide socket. */
export function broadcastToOpenPpms(): void {
  import("../../server/ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: "schedules:changed" }))
    .catch((e) => log.warn(`could not announce a schedule change: ${(e as Error).message}`));
}

/** Who {@link broadcastSchedulesChanged} tells; null tells nobody. */
export function setSchedulesChangedBroadcaster(fn: (() => void) | null): void {
  broadcaster = fn;
}

/** Hears every {@link broadcastSchedulesChanged} at once, before it is coalesced; for tests. */
export function onServerScheduleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The server changed what a schedule shows on its own: a fire came due or was delivered, a run
 * ended, a one-shot went, a schedule paused, followed a renamed chat or went with a deleted one.
 * The scheduler's timer is not involved (it made the change, or the change does not move a next
 * fire), so open PPMs are only told to read their schedules again — the footer chip and Settings
 * would otherwise show the old state until something else made them look.
 */
export function broadcastSchedulesChanged(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch (e) { log.warn(`schedule change listener failed: ${(e as Error).message}`); }
  }
  if (!broadcaster || pendingBroadcast) return;
  pendingBroadcast = setTimeout(() => {
    pendingBroadcast = null;
    broadcaster?.();
  }, COALESCE_MS);
  (pendingBroadcast as { unref?: () => void }).unref?.();
}
