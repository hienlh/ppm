/**
 * One linked session in the linked-sessions bar: a "session" type badge (so it never reads as an
 * agent card), its provider and title, and a live status dot. A tap opens the session.
 */
import { cn } from "@/lib/utils";
import { LINKED_STATUS_TEXT, RELATION_TEXT, type LinkedSessionStatus } from "@/lib/linked-sessions";
import type { LinkedSessionView } from "@/hooks/use-linked-sessions";
import { ProviderBadge } from "./provider-selector";

const DOT: Record<LinkedSessionStatus, string> = {
  running: "bg-success",
  idle: "bg-text-3",
  needs_approval: "bg-error",
  new_message: "bg-info",
};

export function LinkedStatusDot({ status }: { status: LinkedSessionStatus }) {
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden="true">
      {status === "running" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-55 motion-reduce:animate-none" />}
      <span className={cn("relative inline-flex size-2 rounded-full", DOT[status])} />
    </span>
  );
}

export function LinkedSessionChip({ session, onOpen, className }: {
  session: LinkedSessionView;
  onOpen: () => void;
  className?: string;
}) {
  const relation = RELATION_TEXT[session.relations[0] ?? "messaged"];
  const status = LINKED_STATUS_TEXT[session.status];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-linked-session={session.sessionId}
      data-linked-status={session.status}
      title={`${session.title} — ${relation} · ${status}`}
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg border border-info/30 bg-info/5 px-2 text-left text-xs text-text transition-colors md:min-h-8 can-hover:hover:bg-info/10",
        className,
      )}
    >
      <span className="shrink-0 rounded bg-info/15 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-info">session</span>
      <ProviderBadge providerId={session.providerId} />
      <span className="min-w-0 truncate font-medium">{session.title}</span>
      <LinkedStatusDot status={session.status} />
      <span className={cn("shrink-0 text-[11px]", session.status === "needs_approval" ? "text-error" : "text-text-3")}>{status}</span>
    </button>
  );
}
