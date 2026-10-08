/**
 * Pure row-building for the running-agents bar — merges the transcript hub's
 * liveness feed (`agent-activity`, disk-derived: card or teammate, last write
 * time, last step) with the team panel's own richer poll (`useTeamActivityFeed`:
 * agent type, started-at) and the chat's own in-memory state (a known card's
 * description/handle beats a bare id). Kept free of React so the merge and the
 * label lookup are directly unit-testable.
 */
import type { ChatEvent, ChatMessage } from "../../types/chat";
import type { TeamMemberActivity } from "../hooks/use-team-activity-feed";
import type { AgentTranscriptRunningEntry } from "../../shared/agent-transcript-protocol";
import { isAsyncAgentLaunchAck } from "../../shared/background-agent-status";

export interface RunningAgentRow {
  key: string;
  cardId?: string;
  memberName?: string;
  lastStep?: string;
  agentType?: string;
  /** ISO timestamp — only known for a teammate the team panel has already polled. */
  startedAt?: string;
  lastWriteAt?: number;
  /** A sibling that has finished, listed beside the agents of its batch still at work. */
  done?: boolean;
  failed?: boolean;
}

/**
 * Combine the hub feed with the team panel's poll. The hub decides *who is
 * running* (disk mtime within its activity window); the team poll only ever
 * adds metadata (agent type, started-at) for a name the hub already reported —
 * except when the poll is ahead of the hub's few-second cadence, in which case
 * a `workState === "working"` member the hub hasn't caught up to yet is added
 * too, so a teammate never visibly drops out of the bar between polls.
 */
export function buildRunningRows(
  running: AgentTranscriptRunningEntry[],
  teamMembers: TeamMemberActivity[],
): RunningAgentRow[] {
  const byMemberName = new Map(teamMembers.map((m) => [m.name, m]));
  const seenMembers = new Set<string>();
  const rows: RunningAgentRow[] = [];

  for (const entry of running) {
    const { cardId, memberName } = entry;
    if (!cardId && !memberName) continue;
    // A named card is a teammate too: one row, keyed by the card.
    if (memberName) seenMembers.add(memberName);
    const member = memberName ? byMemberName.get(memberName) : undefined;
    rows.push({
      key: cardId ? `card:${cardId}` : `member:${memberName}`,
      ...(cardId ? { cardId } : {}),
      ...(memberName ? { memberName } : {}),
      lastStep: entry.lastStep ?? (member ? currentStepOf(member) : undefined),
      agentType: member?.agentType,
      startedAt: member?.startedAt,
      lastWriteAt: entry.lastWriteAt,
    });
  }

  for (const member of teamMembers) {
    if (member.workState !== "working" || seenMembers.has(member.name)) continue;
    rows.push({
      key: `member:${member.name}`,
      memberName: member.name,
      lastStep: currentStepOf(member),
      agentType: member.agentType,
      startedAt: member.startedAt,
    });
  }

  return rows;
}

function currentStepOf(member: TeamMemberActivity): string | undefined {
  if (member.lastTool) return member.lastToolArg ? `${member.lastTool}: ${member.lastToolArg}` : member.lastTool;
  return member.lastNarrative ?? member.description;
}

/** A known card's label, read straight from the chat's own in-memory events —
 *  beats a bare id when the card is still in this tab's history. */
export interface CardLabel {
  handle: string | null;
  description: string;
  /** Timestamp of the message that launched the card — the nearest thing to a start time. */
  launchedAt?: string;
}

function addressableName(input: unknown): string | null {
  const name = input && typeof input === "object" ? (input as Record<string, unknown>).name : undefined;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function isAgentCall(ev: ChatEvent): ev is Extract<ChatEvent, { type: "tool_use" }> {
  return ev.type === "tool_use" && (ev.tool === "Agent" || ev.tool === "Task") && !!ev.toolUseId;
}

/**
 * Agents that finished beside ones still running: the other `Agent`/`Task` calls of any
 * message that launched a running card, so a fan-out reads "5 running · 1 done".
 *
 * The hub's feed is the only judge of who runs, so a sibling it does not report is done;
 * the call itself only says whether it failed. Agents of a launch with nothing left
 * running stay off the bar.
 */
export function finishedSiblingRows(messages: ChatMessage[], running: RunningAgentRow[]): RunningAgentRow[] {
  const runningCards = new Set(running.map((r) => r.cardId).filter(Boolean));
  if (runningCards.size === 0) return [];
  const rows: RunningAgentRow[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    const calls = (msg.events ?? []).filter(isAgentCall);
    if (!calls.some((c) => runningCards.has(c.toolUseId!))) continue;
    for (const call of calls) {
      const id = call.toolUseId!;
      if (runningCards.has(id) || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        key: `card:${id}`,
        cardId: id,
        ...(addressableName(call.input) ? { memberName: addressableName(call.input)! } : {}),
        done: true,
        failed: callFailed(msg.events!, call),
      });
    }
  }
  return rows;
}

function callFailed(events: ChatEvent[], call: Extract<ChatEvent, { type: "tool_use" }>): boolean {
  if (call.bgStatus) return call.bgStatus !== "completed";
  const result = events.find((e) => e.type === "tool_result" && e.toolUseId === call.toolUseId)
    ?? (call as { result?: { output?: string; isError?: boolean } }).result;
  if (!result) return false;
  const r = result as { output?: unknown; isError?: boolean };
  return !!r.isError && !isAsyncAgentLaunchAck(String(r.output ?? ""));
}

function findInEvents(events: ChatEvent[] | undefined, cardId: string): ChatEvent | undefined {
  if (!events) return undefined;
  for (const ev of events) {
    if (ev.type === "tool_use" && (ev.tool === "Agent" || ev.tool === "Task") && ev.toolUseId === cardId) return ev;
    if (ev.type === "tool_use" && ev.children?.length) {
      const nested = findInEvents(ev.children, cardId);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function findCardLabel(messages: ChatMessage[], cardId: string): CardLabel | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = findInEvents(messages[i]!.events, cardId);
    if (found && found.type === "tool_use") {
      const input = found.input && typeof found.input === "object" ? (found.input as Record<string, unknown>) : {};
      return {
        handle: addressableName(input),
        description: typeof input.description === "string" ? input.description
          : typeof input.prompt === "string" ? input.prompt : "",
        launchedAt: messages[i]!.timestamp,
      };
    }
  }
  return null;
}
