/**
 * Roster for an agent team, working members first.
 *
 * Own scroll container so the roster stays put while the conversation grows —
 * the two used to share one scroll and the members were pushed out of view.
 */

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TeamMemberActivity } from "@/hooks/use-team-activity-feed";
import { TeamMemberActivityRow } from "./team-member-activity-row";

interface TeamMemberListProps {
  members: TeamMemberActivity[];
  loading: boolean;
  onOpenMember: (name: string) => void;
  className?: string;
}

export function TeamMemberList({ members, loading, onOpenMember, className }: TeamMemberListProps) {
  if (members.length === 0) {
    return (
      <div className={cn("flex items-center justify-center gap-2 text-xs text-text-subtle py-4", className)}>
        {loading ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            Reading member sessions…
          </>
        ) : (
          "No member sessions recorded"
        )}
      </div>
    );
  }

  return (
    <div className={cn("overflow-y-auto space-y-0.5", className)}>
      {members.map((member) => (
        <TeamMemberActivityRow key={member.name} member={member} onOpen={onOpenMember} />
      ))}
    </div>
  );
}
