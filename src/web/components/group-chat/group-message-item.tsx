import { memo, type ReactNode } from "react";
import { ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/adaptive-context-menu";
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
    // The bus stores created_at in SECONDS (SQLite unixepoch()); Date expects ms.
    // Normalize second-scale values so timestamps don't all collapse to one minute.
    const ms = ts < 1e12 ? ts * 1000 : ts;
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Render body text with @mentions tinted in the mentioned member's color
 *  (falls back to the primary accent) so it's obvious who is being addressed. */
function withMentions(text: string, colorFor: (n: string) => string | null): ReactNode[] {
  return text.split(/(@[\p{L}\p{N}_]+)/gu).map((part, i) => {
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
 *  bar, "You" for the user, leader badge, highlighted @mentions. */
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
  const summary = message.summary ?? "";
  const target = message.toMember && message.toMember !== "all" ? message.toMember : null;

  const row = (
    <div
      className={cn(
        "group relative flex gap-2.5 px-3 py-2 transition-colors hover:bg-surface-elevated/50",
        isUser && "bg-primary/5",
      )}
      style={{ boxShadow: `inset 3px 0 0 0 ${accent}` }}
    >
      {/* Transcript (AI raw thinking / debug) — top-right icon, POINTER DEVICES ONLY,
          revealed on hover. On touch it's hidden; use long-press → context menu instead. */}
      {message.fullSessionRef && (
        <button
          type="button"
          onClick={() => onViewFull(message)}
          title="View full transcript (AI's raw thinking / debug)"
          aria-label="View full transcript"
          className="absolute right-1.5 top-1.5 hidden items-center rounded p-1 text-text-subtle/60 hover:bg-surface-elevated hover:text-text-secondary can-hover:group-hover:inline-flex"
        >
          <ScrollText className="size-3.5" />
        </button>
      )}
      <div
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-background"
        style={{ backgroundColor: accent }}
        aria-hidden
      >
        {initials(displayName)}
      </div>

      <div className="min-w-0 flex-1 can-hover:pr-6">
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
          <span className="text-[11px] text-text-subtle">{formatTime(message.createdAt)}</span>
        </div>

        <div className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary">
          {withMentions(summary, colorFor)}
        </div>
      </div>
    </div>
  );

  // No transcript → plain row. Otherwise wrap so long-press (mobile) / right-click
  // (desktop) opens a menu with the transcript action; the hover icon covers pointer.
  if (!message.fullSessionRef) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onViewFull(message)}>
          <ScrollText className="size-4" /> View full transcript
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
