import { memo } from "react";
import { cn } from "@/lib/utils";
import type { GroupMessage } from "../../../types/group-chat";

interface GroupMessageItemProps {
  message: GroupMessage;
  /** Member name → color, for the sender avatar/dot. */
  colorFor: (name: string) => string | null;
  /** Open the full archived transcript for this message. */
  onViewFull: (message: GroupMessage) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Slack-style feed row: sender avatar + name + time, then summary. */
export const GroupMessageItem = memo(function GroupMessageItem({
  message,
  colorFor,
  onViewFull,
}: GroupMessageItemProps) {
  const color = colorFor(message.fromMember);
  const isFinal = message.kind === "final";
  const summary = message.summary ?? "";
  const target = message.toMember && message.toMember !== "all" ? message.toMember : null;

  return (
    <div className="flex gap-2.5 px-3 py-2 hover:bg-surface-elevated/50">
      <div
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white"
        style={{ backgroundColor: color ?? "var(--accent)" }}
        aria-hidden
      >
        {initials(message.fromMember)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-foreground">{message.fromMember}</span>
          {target && (
            <span className="text-[11px] text-text-subtle">→ {target}</span>
          )}
          {isFinal && (
            <span className="rounded-full bg-accent-wash px-1.5 py-px text-[10px] font-medium text-primary">
              final
            </span>
          )}
          <span className="text-[11px] text-text-subtle">{formatTime(message.createdAt)}</span>
        </div>

        <p className={cn(
          "mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary",
          isFinal && "text-foreground",
        )}>
          {summary}
        </p>

        {message.fullSessionRef && (
          <button
            type="button"
            onClick={() => onViewFull(message)}
            className="mt-1 inline-flex min-h-[44px] items-center text-xs font-medium text-primary hover:underline md:min-h-[32px]"
          >
            View full transcript
          </button>
        )}
      </div>
    </div>
  );
});
