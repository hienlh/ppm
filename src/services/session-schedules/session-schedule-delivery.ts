/**
 * Turns session-schedule delivery on in a running server: the deliverer listens to the chats'
 * events, the scheduler hands it every fire that comes due, and stored schedules follow chats a
 * provider renames. Started before the scheduler, so the fires it hands over at its own start —
 * those still pending from before a restart — find someone to take them.
 */
import { SessionScheduleDispatcher } from "./session-schedule-dispatcher.ts";
import type { SessionScheduleDispatchEnv } from "./session-schedule-dispatch-types.ts";
import { setSessionScheduleDueHandler } from "./session-schedule-due.ts";
import { followRenamedChats } from "./session-schedule-lifecycle.ts";
import { broadcastToOpenPpms, setSchedulesChangedBroadcaster } from "./session-schedules-changed.ts";

/** Starts delivery; the returned function stops it again. */
export async function startSessionScheduleDelivery(env?: SessionScheduleDispatchEnv): Promise<() => void> {
  const resolvedEnv = env ?? (await import("./session-schedule-dispatch-env.ts")).liveDispatchEnv();
  const dispatcher = new SessionScheduleDispatcher(resolvedEnv);
  dispatcher.start();
  setSessionScheduleDueHandler((scheduleId) => dispatcher.due(scheduleId));
  // In a running server, what delivery changes on its own reaches every open PPM.
  if (!env) setSchedulesChangedBroadcaster(broadcastToOpenPpms);
  const unfollow = followRenamedChats(resolvedEnv.lifecycle);
  return () => {
    if (!env) setSchedulesChangedBroadcaster(null);
    setSessionScheduleDueHandler(null);
    unfollow();
    dispatcher.stop();
  };
}
