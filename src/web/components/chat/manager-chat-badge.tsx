/**
 * The "Manager" chip beside a session's title: this is the chat PPM Assistant talks to about the
 * project. A label, not a control — what the role means is said where it is set.
 */
import { cn } from "@/lib/utils";
import { useIsManagerChat } from "@/hooks/use-manager-chats";

export function ManagerChatBadge({ session, className }: { session: { id: string; manager?: boolean }; className?: string }) {
  if (!useIsManagerChat(session)) return null;
  return (
    <span
      data-manager-badge={session.id}
      title="PPM Assistant talks to this chat about the project"
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10.5px] font-semibold tracking-wide",
        "bg-primary/12 text-primary",
        className,
      )}
    >
      Manager
    </span>
  );
}
