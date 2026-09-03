/**
 * One teammate row: who it is, whether it is working, and what it is doing.
 *
 * The status dot is driven by `workState` (derived from transcript writes), not
 * by the inbox — an inbox-derived status reads "active" for every member forever,
 * which is exactly the display that made it impossible to tell who was running.
 */

import { Loader2, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TeamMemberActivity } from "@/hooks/use-team-activity-feed";
import { currentStep, formatDuration, shortAgentType } from "./team-member-activity-format";

interface TeamMemberActivityRowProps {
  member: TeamMemberActivity;
  /** Opens the teammate's full work session. */
  onOpen: (name: string) => void;
}

const STATE_LABEL: Record<string, string> = {
  working: "working",
  paused: "paused",
  "no-transcript": "no session",
};

export function TeamMemberActivityRow({ member, onOpen }: TeamMemberActivityRowProps) {
  const working = member.workState === "working";
  const step = currentStep(member);
  const elapsed = formatDuration(member.startedAt, working ? undefined : member.lastEventAt);
  const agentType = shortAgentType(member.agentType);

  return (
    <button
      type="button"
      onClick={() => onOpen(member.name)}
      // 44px min height keeps the row a valid touch target on mobile.
      className="w-full text-left min-h-[44px] px-1.5 py-1 rounded-md hover:bg-surface-elevated transition-colors group"
    >
      <div className="flex items-center gap-2 text-xs">
        {working ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-success" />
        ) : (
          <span
            className={cn(
              "size-1.5 rounded-full shrink-0",
              member.workState === "paused" ? "bg-warning" : "bg-text-3",
            )}
          />
        )}
        <span className="font-medium truncate">{member.name}</span>
        {agentType && <span className="text-text-subtle text-[10px] truncate">{agentType}</span>}
        {member.model && <span className="text-text-subtle text-[10px]">({member.model})</span>}
        <span className="ml-auto flex items-center gap-1 shrink-0 text-[10px] text-text-subtle">
          {elapsed && <span>{elapsed}</span>}
          <span className={cn(working && "text-success")}>{STATE_LABEL[member.workState]}</span>
          <ChevronRight className="size-3 opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      </div>
      {step && (
        <div className="mt-0.5 pl-5 text-[11px] text-text-subtle truncate font-mono">{step}</div>
      )}
    </button>
  );
}
