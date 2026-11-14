/**
 * A scheduled message in flight, checked now and then against its chat's live state, so nothing
 * PPM failed to hear can hold the chat's schedules forever:
 * - a started turn whose chat is idle ended without its `turn_ended` reaching the deliverer;
 * - a queued message the chat no longer holds, with no turn running, was lost — Stop killed the
 *   provider with the message still in its queue — and its fire, still pending, goes again.
 */
import type { ChatControl } from "../chat-control/chat-control.ts";
import { chatIsIdle, type Flight } from "./session-schedule-dispatch-types.ts";

/** Idle looks a message still said to be queued survives before it is taken as lost. */
const QUEUED_IDLE_CHECKS = 3;

/** What the deliverer does with a flight a look found over. */
export interface FlightWatchHost {
  /** The chat the flight is now keyed under (a renamed chat moves it); null once it is gone. */
  keyOf(flight: Flight): string | null;
  control(): ChatControl | null;
  flightCheckMs: number;
  /** Its turn ended with no end heard. */
  endedUnheard(sessionId: string, flight: Flight): void;
  /** Its queued message is gone without opening a turn. */
  lost(sessionId: string, flight: Flight): void;
}

/** Look at the flight's chat again after `ms`, replacing any look already planned. */
export function watchFlight(flight: Flight, ms: number, host: FlightWatchHost): void {
  if (flight.check) clearTimeout(flight.check);
  flight.check = setTimeout(() => lookAtFlight(flight, host), ms);
  (flight.check as { unref?: () => void }).unref?.();
}

function lookAtFlight(flight: Flight, host: FlightWatchHost): void {
  const sessionId = host.keyOf(flight);
  if (!sessionId) return;
  flight.check = undefined;
  const control = host.control();
  const idle = chatIsIdle(control?.liveState(sessionId) ?? null);
  if (flight.phase === "started") {
    if (idle) host.endedUnheard(sessionId, flight);
    else watchFlight(flight, host.flightCheckMs, host);
    return;
  }
  if (flight.phase !== "queued") return;
  if (!idle) {
    flight.idleChecks = 0;
    return watchFlight(flight, host.flightCheckMs, host);
  }
  const queued = control?.messageQueued?.(sessionId, flight.clientMessageId) ?? null;
  // A provider that cannot say, or one that still claims the message with nothing running to
  // hold it behind, is believed for a few looks only: an idle chat starts a queued message at once.
  if (queued !== false && ++flight.idleChecks < QUEUED_IDLE_CHECKS) return watchFlight(flight, host.flightCheckMs, host);
  host.lost(sessionId, flight);
}
