/**
 * Activity-subscription half of a session hub: "who is running right now",
 * pushed every 3s while at least one client is watching. Independent of the
 * transcript ticker — a running bar costs nothing extra when no window is
 * open, and a window being open costs nothing extra for the bar.
 */
import { computeRunningAgents } from "./agent-transcript-activity.ts";
import { agentTranscriptClock, agentTranscriptTimers } from "./agent-transcript-hub-clock.ts";
import { sendWsMessage, type AgentTranscriptWsLike } from "./agent-transcript-ws-like.ts";
import type { SessionHub } from "./agent-transcript-session-hub-types.ts";
import { ACTIVITY_TICK_MS, type AgentActivityMsg } from "../../shared/agent-transcript-protocol.ts";

function ensureActivityTicker(hub: SessionHub): void {
  if (hub.activityHandle !== null) return;
  hub.activityHandle = agentTranscriptTimers.setInterval(() => {
    void tickActivity(hub);
  }, ACTIVITY_TICK_MS);
}

function stopActivityTickerIfEmpty(hub: SessionHub): void {
  if (hub.activitySubs.size > 0 || hub.activityHandle === null) return;
  agentTranscriptTimers.clearInterval(hub.activityHandle);
  hub.activityHandle = null;
}

export function addActivitySubscription(hub: SessionHub, ws: AgentTranscriptWsLike, subId: string): void {
  let subIds = hub.activitySubs.get(ws);
  if (!subIds) {
    subIds = new Set();
    hub.activitySubs.set(ws, subIds);
  }
  subIds.add(subId);
  ensureActivityTicker(hub);
  // Guarded the same way `tickActivity` is below: this runs un-awaited, so a
  // throw anywhere in `computeRunningAgents` (a descendant read racing a
  // delete, a locked rollout) would otherwise become an unhandled rejection
  // rather than something this function can react to.
  void (async () => {
    try {
      const now = agentTranscriptClock.now();
      const running = await computeRunningAgents(hub.owned, now);
      if (!hub.tokenStillValid(ws) || !pushActivity(ws, [subId], running)) hub.onSendFailure(ws);
    } catch {
      console.warn(`[agent-activity] hub=${hub.key} subId=${subId} initial compute failed`);
    }
  })();
}

export function removeActivitySubscription(hub: SessionHub, ws: AgentTranscriptWsLike, subId: string): boolean {
  const subIds = hub.activitySubs.get(ws);
  if (!subIds?.delete(subId)) return false;
  if (subIds.size === 0) hub.activitySubs.delete(ws);
  stopActivityTickerIfEmpty(hub);
  return true;
}

export function dropAllActivityForWs(hub: SessionHub, ws: AgentTranscriptWsLike): number {
  const subIds = hub.activitySubs.get(ws);
  if (!subIds) return 0;
  hub.activitySubs.delete(ws);
  stopActivityTickerIfEmpty(hub);
  return subIds.size;
}

export function activitySubIdsForWs(hub: SessionHub, ws: AgentTranscriptWsLike): string[] {
  return [...(hub.activitySubs.get(ws)?.values() ?? [])];
}

/** Push an already-computed running list to one client's given subscriptions. */
function pushActivity(ws: AgentTranscriptWsLike, subIds: string[], running: AgentActivityMsg["running"]): boolean {
  for (const subId of subIds) {
    const msg: AgentActivityMsg = { type: "agent-activity", subId, running };
    if (!sendWsMessage(ws, msg)) return false;
  }
  return true;
}

/**
 * One 3s wake: compute the running list once for the whole hub and fan it
 * out to every subscriber — a per-session scan (Codex especially) is not
 * cheap enough to repeat once per client watching the same session.
 *
 * Wrapped in its own try/catch because this is invoked as `void tickActivity(hub)`
 * (fire-and-forget, from an un-awaited `setInterval` callback): a throw
 * anywhere in `computeRunningAgents` — a descendant rollout that disappears
 * or locks up between the stat and the read that bounds it — would otherwise
 * surface as an unhandled promise rejection, counted the same way an
 * uncaught exception is, on a 3s timer instead of the 250ms one C1 fixed.
 */
export async function tickActivity(hub: SessionHub): Promise<void> {
  if (hub.activitySubs.size === 0) return;
  try {
    const now = agentTranscriptClock.now();
    const running = await computeRunningAgents(hub.owned, now);
    const failed: AgentTranscriptWsLike[] = [];
    for (const [ws, subIds] of hub.activitySubs) {
      if (!hub.tokenStillValid(ws) || !pushActivity(ws, [...subIds], running)) failed.push(ws);
    }
    for (const ws of failed) hub.onSendFailure(ws);
  } catch {
    console.warn(`[agent-activity] hub=${hub.key} tick failed`);
  }
}
