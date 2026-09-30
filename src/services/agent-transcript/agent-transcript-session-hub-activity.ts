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
  void (async () => {
    const now = agentTranscriptClock.now();
    const running = await computeRunningAgents(hub.owned, now);
    if (!hub.tokenStillValid(ws) || !pushActivity(ws, [subId], running)) hub.onSendFailure(ws);
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

/** One 3s wake: compute the running list once for the whole hub and fan it out
 *  to every subscriber — a per-session scan (Codex especially) is not cheap
 *  enough to repeat once per client watching the same session. */
export async function tickActivity(hub: SessionHub): Promise<void> {
  if (hub.activitySubs.size === 0) return;
  const now = agentTranscriptClock.now();
  const running = await computeRunningAgents(hub.owned, now);
  const failed: AgentTranscriptWsLike[] = [];
  for (const [ws, subIds] of hub.activitySubs) {
    if (!hub.tokenStillValid(ws) || !pushActivity(ws, [...subIds], running)) failed.push(ws);
  }
  for (const ws of failed) hub.onSendFailure(ws);
}
