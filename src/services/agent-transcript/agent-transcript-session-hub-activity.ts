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
  void tickActivityForClient(hub, ws, [subId]);
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

/** Push the current running list to one client's given activity subscriptions. */
async function tickActivityForClient(hub: SessionHub, ws: AgentTranscriptWsLike, subIds: string[]): Promise<void> {
  if (!hub.tokenStillValid(ws)) {
    hub.onSendFailure(ws);
    return;
  }
  const now = agentTranscriptClock.now();
  const running = await computeRunningAgents(hub.owned, now);
  for (const subId of subIds) {
    const msg: AgentActivityMsg = { type: "agent-activity", subId, running };
    if (!sendWsMessage(ws, msg)) {
      hub.onSendFailure(ws);
      return;
    }
  }
}

/** One 3s wake: push every activity subscriber on this hub. */
export async function tickActivity(hub: SessionHub): Promise<void> {
  const clients = [...hub.activitySubs.entries()];
  await Promise.all(clients.map(([ws, subIds]) => tickActivityForClient(hub, ws, [...subIds])));
}
