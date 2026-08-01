import { memo } from "react";
import { Pencil, Trash2, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GroupMember, MemberStatus } from "../../../types/group-chat";

interface GroupMemberRosterProps {
  members: GroupMember[];
  /** memberId → live status (working/done/error) from the running burst. */
  liveStatus: Map<string, MemberStatus>;
  /** Member name → true when composing a turn. */
  typing: Record<string, boolean>;
  /** Disables actions while a mutation is in flight. */
  busy?: boolean;
  onAdd: () => void;
  onEdit: (member: GroupMember) => void;
  onRemove: (member: GroupMember) => void;
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

/** Editable roster: avatar + name + role/persona + live status; add/edit/remove. */
export const GroupMemberRoster = memo(function GroupMemberRoster({
  members, liveStatus, typing, busy, onAdd, onEdit, onRemove,
}: GroupMemberRosterProps) {
  return (
    <div className="flex flex-col gap-0.5 p-2">
      {members.map((m) => {
        const isTyping = typing[m.name];
        const status = liveStatus.get(m.id) ?? m.status;
        return (
          <div key={m.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5">
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-background"
              style={{ backgroundColor: m.color ?? "var(--accent)" }}
              aria-hidden
            >
              {m.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium" style={{ color: m.color ?? "var(--color-foreground)" }}>{m.name}</span>
                {m.role === "leader" && (
                  <span className="rounded-sm bg-accent-wash px-1 text-[9px] font-semibold uppercase text-primary">
                    lead
                  </span>
                )}
              </div>
              <span className="block truncate text-[10px] text-text-subtle">
                {isTyping ? "typing…" : (m.persona || STATUS_LABEL[status])}
              </span>
            </div>
            {/* Actions — always visible on touch; hover-reveal on pointer devices. */}
            <div className="flex shrink-0 items-center gap-0.5 can-hover:opacity-0 can-hover:group-hover:opacity-100">
              <button
                type="button"
                onClick={() => onEdit(m)}
                disabled={busy}
                aria-label={`Edit ${m.name}`}
                className="flex size-8 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground active:bg-surface-elevated disabled:opacity-40"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onRemove(m)}
                disabled={busy}
                aria-label={`Remove ${m.name}`}
                className="flex size-8 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-destructive active:bg-surface-elevated disabled:opacity-40"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <span
              className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])}
              title={STATUS_LABEL[status]}
              aria-hidden
            />
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAdd}
        disabled={busy}
        className="mt-1 flex items-center gap-2 rounded-md px-2 py-2 text-xs font-medium text-primary hover:bg-surface-elevated active:bg-surface-elevated disabled:opacity-40"
      >
        <UserPlus className="size-4" /> Add member
      </button>
    </div>
  );
});
