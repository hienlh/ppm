import { memo } from "react";
import { cn } from "@/lib/utils";
import type { MemberStatus } from "../../../types/group-chat";
import type { RosterMember } from "@/hooks/use-group-chat";

interface GroupMemberRosterProps {
  members: RosterMember[];
  /** Member name → true when composing a turn. */
  typing: Record<string, boolean>;
}

const STATUS_DOT: Record<MemberStatus, string> = {
  idle: "bg-text-subtle",
  working: "bg-primary animate-pulse",
  done: "bg-emerald-500",
  error: "bg-destructive",
};

const STATUS_LABEL: Record<MemberStatus, string> = {
  idle: "Idle",
  working: "Working",
  done: "Done",
  error: "Error",
};

/** Compact roster: avatar dot + name + role + live status; shows typing state. */
export const GroupMemberRoster = memo(function GroupMemberRoster({
  members,
  typing,
}: GroupMemberRosterProps) {
  if (members.length === 0) {
    return (
      <div className="p-3 text-xs text-text-subtle">No members yet.</div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 p-2">
      {members.map((m) => {
        const isTyping = typing[m.name];
        return (
          <li
            key={m.id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5"
          >
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white"
              style={{ backgroundColor: m.color ?? "var(--accent)" }}
              aria-hidden
            >
              {m.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium text-foreground">{m.name}</span>
                {m.role === "leader" && (
                  <span className="rounded-sm bg-accent-wash px-1 text-[9px] font-semibold uppercase text-primary">
                    lead
                  </span>
                )}
              </div>
              <span className="text-[10px] text-text-subtle">
                {isTyping ? "typing…" : STATUS_LABEL[m.status]}
              </span>
            </div>
            <span
              className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[m.status])}
              title={STATUS_LABEL[m.status]}
              aria-hidden
            />
          </li>
        );
      })}
    </ul>
  );
});
