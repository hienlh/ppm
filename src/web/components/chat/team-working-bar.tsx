/**
 * Teammates working right now, pinned under the conversation.
 *
 * A teammate only appears in the transcript when it is *spawned*; every later task
 * reaches it through SendMessage, which resumes the same agent and writes no new
 * card. So after the first round the conversation goes quiet while members are
 * still working, and the only way to notice was to open the team panel.
 *
 * This is deliberately a live overlay rather than chat events: work state is derived
 * from transcripts on disk within a 90s window, so replaying an old session must show
 * nothing here instead of claiming a long-finished teammate is still running.
 */

import { Users } from "lucide-react";
import type { TeamMemberActivity } from "@/hooks/use-team-activity-feed";
import { currentStep, formatDuration, shortAgentType } from "./team-member-activity-format";
import { useOpenTeamMember } from "./use-open-team-member";

interface TeamWorkingBarProps {
  teamName: string;
  members: TeamMemberActivity[];
  projectName?: string;
}

export function TeamWorkingBar({ teamName, members, projectName }: TeamWorkingBarProps) {
  const openMember = useOpenTeamMember();
  const working = members.filter((m) => m.workState === "working");
  if (!teamName || working.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-border bg-surface-elevated/60 px-2 py-1.5 space-y-1">
      {working.map((member) => {
        const step = currentStep(member);
        const elapsed = formatDuration(member.startedAt);
        const agentType = shortAgentType(member.agentType);
        return (
          <button
            key={member.name}
            type="button"
            onClick={() => openMember({ teamName, memberName: member.name, projectName })}
            className="flex w-full items-center gap-2 rounded px-1 py-1.5 min-h-[36px] text-left text-xs hover:bg-surface transition-colors"
            title={`Open ${member.name}'s work session`}
          >
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            <Users className="size-3.5 shrink-0 text-accent-2" />
            <span className="font-medium text-text-primary shrink-0">{member.name}</span>
            {!!agentType && <span className="text-text-3 shrink-0 hidden sm:inline">{agentType}</span>}
            {!!step && (
              <span className="flex-1 truncate text-text-subtle" title={step}>
                {step}
              </span>
            )}
            {!!elapsed && <span className="ml-auto shrink-0 text-text-3 font-mono">{elapsed}</span>}
          </button>
        );
      })}
    </div>
  );
}
