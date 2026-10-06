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

export interface RunningAgentRow {
  key: string;
  cardId?: string;
  memberName?: string;
  lastStep?: string;
  agentType?: string;
  /** ISO timestamp — only known for a teammate the team panel has already polled. */
  startedAt?: string;
  lastWriteAt?: number;
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
}

function addressableName(input: unknown): string | null {
  const name = input && typeof input === "object" ? (input as Record<string, unknown>).name : undefined;
  return typeof name === "string" && name.trim() ? name.trim() : null;
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
      };
    }
  }
  return null;
}
