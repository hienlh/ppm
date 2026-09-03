/**
 * Agent-team panel: the team's roster and its conversation, as two tabs.
 *
 * They are deliberately not one scroll. A team runs ~20 members and produces a
 * long conversation, so a single list pushed the roster — the part that answers
 * "who is working right now" — off screen the moment messages accumulated.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TeamMessageItem } from "@/hooks/use-chat";
import { useTeamActivityFeed } from "@/hooks/use-team-activity-feed";
import { useOpenTeamMember } from "./use-open-team-member";
import { usePrefersCoarsePointer } from "@/components/os-explorer/use-coarse-long-press";
import { TeamMemberList } from "./team-member-list";
import { TeamMessageList } from "./team-message-list";

type TeamTab = "members" | "messages";

interface TeamActivityPanelProps {
  teamNames: string[];
  messages: TeamMessageItem[];
  /** Current session id — the implicit team is named after it */
  sessionId?: string | null;
  /** Passed to a member window so its steps resolve project-relative paths. */
  projectName?: string;
}

/** Implicit teams are named after the session, which is an unreadable uuid. */
function teamLabel(name: string, sessionId?: string | null): string {
  return name === sessionId ? "Team (current session)" : name;
}

export function TeamActivityPanel({ teamNames, messages, sessionId, projectName }: TeamActivityPanelProps) {
  const [selectedTeam, setSelectedTeam] = useState(teamNames[0] ?? "");
  const [tab, setTab] = useState<TeamTab>("members");
  const openMember = useOpenTeamMember();
  // Touch needs the 44px minimum even at desktop width; a mouse does not.
  const coarse = usePrefersCoarsePointer();

  // Sync selected team when teamNames changes
  useEffect(() => {
    if (teamNames.length > 0 && !teamNames.includes(selectedTeam)) {
      setSelectedTeam(teamNames[0]!);
    }
  }, [teamNames, selectedTeam]);

  // The panel only renders while open, so mounting is the right poll gate.
  const { members, outbound, loading, refresh } = useTeamActivityFeed(selectedTeam, Boolean(selectedTeam));

  const openMemberSession = useCallback(
    (memberName: string) => {
      openMember({ teamName: selectedTeam, memberName, projectName });
    },
    [openMember, selectedTeam, projectName],
  );

  /**
   * Inbox messages are lead → member only. A teammate's own reports live in its
   * transcript as SendMessage calls, so both directions are merged here — without
   * it the panel shows tasks going out and nothing ever coming back.
   */
  const displayMessages = useMemo(() => {
    const replies = outbound.map((m) => ({
      from: m.from,
      to: m.to,
      text: m.text,
      timestamp: m.timestamp,
      ...(m.summary ? { summary: m.summary } : {}),
    })) as TeamMessageItem[];
    return [...messages, ...replies]
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-200);
  }, [messages, outbound]);

  const workingCount = members.filter((m) => m.workState === "working").length;

  const tabClass = (active: boolean) =>
    cn(
      "flex items-center gap-1.5 px-2.5 rounded-md text-[11px] whitespace-nowrap transition-colors",
      coarse ? "min-h-[44px]" : "py-1",
      active ? "bg-primary/10 text-primary font-medium" : "text-text-subtle hover:text-text-primary",
    );

  return (
    <div className="flex flex-col min-h-0">
      {/* Team selector — only meaningful when a session tracks more than one team */}
      {teamNames.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto min-w-0 mb-1.5">
          {teamNames.map((name) => (
            <button
              key={name}
              onClick={() => setSelectedTeam(name)}
              className={cn(
                "px-2 py-0.5 text-[11px] rounded-md whitespace-nowrap transition-colors",
                selectedTeam === name
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-text-subtle hover:text-text-primary",
              )}
            >
              {teamLabel(name, sessionId)}
            </button>
          ))}
        </div>
      )}

      {/* Members / Messages tabs + refresh */}
      <div className="flex items-center gap-1 mb-1.5 shrink-0" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "members"}
          onClick={() => setTab("members")}
          className={tabClass(tab === "members")}
        >
          <span>Members</span>
          <span className="text-text-subtle">{members.length}</span>
          {workingCount > 0 && (
            <span className="flex items-center gap-1 text-success">
              <span className="size-1.5 rounded-full bg-success animate-pulse" />
              {workingCount}
            </span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === "messages"}
          onClick={() => setTab("messages")}
          className={tabClass(tab === "messages")}
        >
          <span>Messages</span>
          <span className="text-text-subtle">{displayMessages.length}</span>
        </button>
        <button
          onClick={refresh}
          className={cn("ml-auto text-text-subtle hover:text-foreground shrink-0", coarse ? "p-3" : "p-1")}
          aria-label="Refresh"
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
        </button>
      </div>

      {tab === "members" ? (
        <TeamMemberList
          members={members}
          loading={loading}
          onOpenMember={openMemberSession}
          className="max-h-56"
        />
      ) : (
        <TeamMessageList messages={displayMessages} className="max-h-56" />
      )}
    </div>
  );
}
