/**
 * Chat history for an agent team: the lead's task assignments merged with the
 * replies teammates sent back.
 *
 * Split out of the panel so Members and Messages each own their own scroll
 * container — sharing one made the member list scroll away as soon as the
 * conversation grew.
 */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { TeamMessageItem } from "@/hooks/use-chat";
import { TYPE_BADGES } from "./team-message-badges";
import { previewTeamMessage } from "./team-message-preview";

interface TeamMessageListProps {
  messages: TeamMessageItem[];
  className?: string;
}

export function TeamMessageList({ messages, className }: TeamMessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  if (messages.length === 0) {
    return <p className={cn("text-xs text-text-subtle text-center py-4", className)}>No messages yet</p>;
  }

  return (
    <div className={cn("overflow-y-auto", className)}>
      <div className="space-y-2">
        {messages.map((msg, i) => {
          const badge = msg.parsedType ? TYPE_BADGES[msg.parsedType] : null;
          const { title, detail, taskId } = previewTeamMessage(msg.text, msg.summary);
          return (
            <div key={`${msg.timestamp}-${i}`} className="text-xs">
              <div className="flex items-center gap-1 text-text-subtle">
                <span className="font-medium" style={safeColor(msg.color)}>
                  {msg.from}
                </span>
                <span>→</span>
                <span>{msg.to}</span>
                <span className="ml-auto text-[10px]">{formatTime(msg.timestamp)}</span>
              </div>
              <div className="mt-0.5 text-foreground/90 break-words">
                {badge && (
                  <span className={cn("inline-block px-1 py-0 rounded text-[9px] mr-1", badge.className)}>
                    {badge.label}
                  </span>
                )}
                {taskId && (
                  <span className="inline-block px-1 py-0 rounded text-[9px] mr-1 bg-surface-elevated text-text-subtle">
                    #{taskId}
                  </span>
                )}
                {title}
              </div>
              {detail && (
                <div className="mt-0.5 text-[11px] text-text-subtle break-words line-clamp-2">{detail}</div>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

/** Sanitize color value to prevent CSS injection */
function safeColor(color?: string): React.CSSProperties | undefined {
  if (!color) return undefined;
  if (/^#[0-9a-fA-F]{3,8}$/.test(color) || /^[a-zA-Z]{3,20}$/.test(color)) {
    return { color };
  }
  return undefined;
}
