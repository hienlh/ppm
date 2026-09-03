/**
 * Formatting shared by every surface that shows a teammate's activity — the roster
 * row in the team panel and the working bar pinned under the conversation.
 *
 * Kept apart from the components so both read the same answer to "who is this and
 * what is it doing right now" instead of drifting into two phrasings.
 */

import type { TeamMemberActivity } from "@/hooks/use-team-activity-feed";

/** Trailing agent-type segment — `ak-engineer:tester` reads as `tester`. */
export function shortAgentType(agentType?: string): string | undefined {
  if (!agentType) return undefined;
  const tail = agentType.split(":").pop();
  return tail && tail !== "general-purpose" ? tail : agentType;
}

/** `1h 4m` / `12m` / `45s` — compact enough for a dense row. */
export function formatDuration(fromIso?: string, toIso?: string): string | undefined {
  if (!fromIso) return undefined;
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return undefined;
  const totalSeconds = Math.floor((to - from) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

/** Best one-line answer to "what is it doing" from the transcript tail. */
export function currentStep(member: TeamMemberActivity): string | undefined {
  if (member.lastTool) {
    return member.lastToolArg ? `${member.lastTool}: ${member.lastToolArg}` : member.lastTool;
  }
  return member.lastNarrative ?? member.description;
}
