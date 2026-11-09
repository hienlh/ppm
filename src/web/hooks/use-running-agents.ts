/**
 * Every agent of this chat that is really still working, plus the finished ones launched beside
 * them — what the footer's activity chip counts and its Agents tab lists.
 *
 * Liveness is entirely disk-derived on the server (the transcript hub's `agent-activity` feed,
 * merged with the team panel's richer per-member poll for agent type and elapsed time), never chat
 * state in memory, so a replayed old session shows nothing even though its cards are still in the
 * transcript. A finished agent stays listed while one launched beside it still runs.
 */
import { useEffect, useMemo, useState } from "react";
import { useAgentActivity } from "@/hooks/use-agent-activity";
import type { TeamMemberActivity } from "@/hooks/use-team-activity-feed";
import { buildRunningRows, findCardLabel, finishedSiblingRows, type RunningAgentRow } from "@/lib/running-agent-rows";
import { formatDuration, shortAgentType } from "@/components/chat/team-member-activity-format";
import { useOpenAgentSession } from "@/components/chat/use-open-agent-session";
import type { ChatMessage } from "../../types/chat";
import type { AgentTranscriptProviderId } from "../../shared/agent-transcript-protocol";

/** What a row shows, resolved once from the hub row and the chat's own card. */
export interface AgentView {
  row: RunningAgentRow;
  name: string;
  prompt?: string;
  step?: string;
  elapsed?: string;
}

export interface RunningAgents {
  /** Running ones first, then the finished ones launched beside them. */
  views: AgentView[];
  running: number;
  done: number;
  /** Open that agent's own session (a window on a desktop, a sheet on a phone). */
  openView: (view: AgentView) => void;
}

export function useRunningAgents({ projectName, providerId, sessionId, messages, teamName, teamMembers }: {
  projectName: string;
  providerId: AgentTranscriptProviderId;
  sessionId: string | null;
  /** For labelling a card row from what the chat already knows about it. */
  messages: ChatMessage[];
  /** The session's implicit team name, for a member row's `source`. */
  teamName: string;
  teamMembers: TeamMemberActivity[];
}): RunningAgents {
  const running = useAgentActivity({ projectName, providerId, sessionId });
  const openAgentSession = useOpenAgentSession();
  const runningRows = useMemo(() => buildRunningRows(running, teamMembers), [running, teamMembers]);
  const doneRows = useMemo(() => finishedSiblingRows(messages, runningRows), [messages, runningRows]);
  // Labels scan the whole transcript; the elapsed tick re-renders every second, so read them
  // only when the transcript or the rows change.
  const labels = useMemo(() => new Map(
    [...runningRows, ...doneRows].filter((r) => r.cardId).map((r) => [r.cardId!, findCardLabel(messages, r.cardId!)]),
  ), [messages, runningRows, doneRows]);
  useElapsedTick(runningRows.length > 0);

  if (!sessionId || runningRows.length === 0) return { views: [], running: 0, done: 0, openView: () => {} };

  const view = (row: RunningAgentRow): AgentView => {
    const label = row.cardId ? labels.get(row.cardId) : null;
    const name = row.memberName ?? label?.handle ?? (label?.description || "Agent");
    const startedAt = row.startedAt ?? label?.launchedAt;
    return {
      row,
      name,
      prompt: label?.description || undefined,
      step: row.lastStep ?? shortAgentType(row.agentType),
      elapsed: row.done || !startedAt ? undefined : formatDuration(startedAt),
    };
  };

  return {
    views: [...runningRows, ...doneRows].map(view),
    running: runningRows.length,
    done: doneRows.length,
    openView: (v) => openAgentSession({
      projectName,
      providerId,
      sessionId,
      source: v.row.cardId ? { kind: "card", cardId: v.row.cardId } : { kind: "member", teamName, memberName: v.row.memberName! },
      title: `Session — ${v.name}`,
      prompt: v.prompt,
    }),
  };
}

/** Re-render once a second while something runs, so elapsed times keep counting. */
function useElapsedTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}
