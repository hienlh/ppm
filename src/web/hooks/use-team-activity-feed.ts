/**
 * Poll a team's per-member activity while the panel is open.
 *
 * The team inboxes cannot say who is working — every member reads "active"
 * forever there. `/api/teams/:name/activity` derives it from the agent
 * transcripts instead, and also returns the replies teammates sent back, which
 * no inbox holds. Polling only runs while `enabled`, so a closed panel costs
 * nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";

/** Fast enough that a working teammate looks live, slow enough to stay cheap. */
const POLL_INTERVAL_MS = 5_000;

export type MemberWorkState = "working" | "paused" | "no-transcript";

export interface TeamMemberActivity {
  name: string;
  workState: MemberWorkState;
  agentType?: string;
  model?: string;
  description?: string;
  toolUseId?: string;
  startedAt?: string;
  lastEventAt?: string;
  lastTool?: string;
  lastToolArg?: string;
  lastNarrative?: string;
  sizeBytes: number;
}

export interface OutboundTeamMessage {
  from: string;
  to: string;
  text: string;
  summary?: string;
  timestamp: string;
}

export interface TeamActivityFeed {
  members: TeamMemberActivity[];
  outbound: OutboundTeamMessage[];
  loading: boolean;
  /** Re-fetch now, for the panel's refresh button. */
  refresh: () => void;
}

export function useTeamActivityFeed(teamName: string, enabled: boolean): TeamActivityFeed {
  const [members, setMembers] = useState<TeamMemberActivity[]>([]);
  const [outbound, setOutbound] = useState<OutboundTeamMessage[]>([]);
  const [loading, setLoading] = useState(false);
  // Survives re-renders so a poll that resolves after teardown is discarded.
  const cancelledRef = useRef(false);

  const fetchActivity = useCallback(async (team: string) => {
    if (!team) return;
    setLoading(true);
    try {
      const res = await api.get<{ members?: TeamMemberActivity[]; outbound?: OutboundTeamMessage[] }>(
        `/api/teams/${encodeURIComponent(team)}/activity`,
      );
      if (cancelledRef.current) return;
      setMembers(res?.members ?? []);
      setOutbound(res?.outbound ?? []);
    } catch {
      /* keep the last good snapshot rather than blanking the list */
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled || !teamName) {
      // Drop the previous team's rows so a reopen never shows stale members.
      setMembers([]);
      setOutbound([]);
      return () => { cancelledRef.current = true; };
    }
    void fetchActivity(teamName);
    const timer = setInterval(() => void fetchActivity(teamName), POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
    };
  }, [teamName, enabled, fetchActivity]);

  const refresh = useCallback(() => void fetchActivity(teamName), [fetchActivity, teamName]);
  return { members, outbound, loading, refresh };
}
