import { memo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { GroupMessage } from "../../../types/group-chat";

interface GroupMessageItemProps {
  message: GroupMessage;
  /** Member name → color, for the sender avatar/name accent. */
  colorFor: (name: string) => string | null;
  /** Whether a sender name is the group leader (adds a badge). */
  isLeader: (name: string) => boolean;
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

/** Render body text with @mentions tinted in the mentioned member's color
 *  (falls back to the primary accent) so it's obvious who is being addressed. */
function withMentions(text: string, colorFor: (n: string) => string | null): ReactNode[] {
  return text.split(/(@\w+)/g).map((part, i) => {
    if (part.startsWith("@") && part.length > 1) {
      const c = colorFor(part.slice(1));
      return (
        <span key={i} className={cn("font-semibold", !c && "text-primary")} style={c ? { color: c } : undefined}>
          {part}
        </span>
      );
    }
    return part;
  });
}

/** Slack-style feed row: colored avatar + name accent per speaker, left color
 *  bar, "You" for the user, leader badge, highlighted @mentions, final card. */
export const GroupMessageItem = memo(function GroupMessageItem({
  message,
  colorFor,
  isLeader,
  onViewFull,
}: GroupMessageItemProps) {
  const isUser = message.fromMember === "user";
  const displayName = isUser ? "You" : message.fromMember;
  const accent = isUser ? "var(--color-primary)" : (colorFor(message.fromMember) ?? "var(--accent)");
  const leader = !isUser && isLeader(message.fromMember);
  const isFinal = message.kind === "final";
  const summary = message.summary ?? "";
  const target = message.toMember && message.toMember !== "all" ? message.toMember : null;

  return (
    <div
      className={cn(
        "flex gap-2.5 px-3 py-2 transition-colors hover:bg-surface-elevated/50",
        isUser && "bg-primary/5",
      )}
      style={{ boxShadow: `inset 3px 0 0 0 ${accent}` }}
    >
      <div
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-background"
        style={{ backgroundColor: accent }}
        aria-hidden
      >
        {initials(displayName)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span
            className="text-sm font-semibold"
            style={{ color: isUser ? "var(--color-foreground)" : accent }}
          >
            {displayName}
          </span>
          {leader && (
            <span className="rounded bg-surface-elevated px-1.5 py-px text-[10px] font-medium text-text-secondary">
              leader
            </span>
          )}
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

        <div className={cn(
          "mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary",
          isFinal && "mt-1.5 rounded-md border border-accent-wash bg-accent-wash/40 px-3 py-2 text-foreground",
        )}>
          {withMentions(summary, colorFor)}
        </div>

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
