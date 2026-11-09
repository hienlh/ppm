/**
 * A linked session's live status as a dot — the only status the footer's linked-sessions chip
 * shows, and the first thing in each row of the list it opens.
 */
import { cn } from "@/lib/utils";
import type { LinkedSessionStatus } from "@/lib/linked-sessions";

const DOT: Record<LinkedSessionStatus, string> = {
  running: "bg-success",
  idle: "bg-text-3",
  needs_approval: "bg-error",
  new_message: "bg-info",
};

export function LinkedStatusDot({ status }: { status: LinkedSessionStatus }) {
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden="true" data-linked-dot={status}>
      {status === "running" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-55 motion-reduce:animate-none" />}
      <span className={cn("relative inline-flex size-2 rounded-full", DOT[status])} />
    </span>
  );
}
