import { cn } from "@/lib/utils";

/**
 * The "AI" badge of a terminal an AI typed a command into (`run_in_terminal`, the Assistant's
 * `terminal_type`). Such a shell keeps the AI-chat mark for its whole life, so a `ppm` command the
 * user runs there meets the rules PPM applies to an AI chat; the badge is how they know why.
 * The tab chip carries the badge; the terminal's own status bar spells the reason out, since a
 * phone has no hover to show a tooltip.
 */

export const TERMINAL_AI_MARK_EXPLANATION =
  "Typed by an AI. This terminal runs as part of an AI chat, so ppm commands here follow the AI-chat rules. A terminal you open yourself does not.";

/** Whether a dock or panel tab is a terminal an AI typed into. */
export function isAiMarkedTerminalTab(tab: { type: string; metadata?: Record<string, unknown> }): boolean {
  return tab.type === "terminal" && tab.metadata?.aiMark === true;
}

export function TerminalAiMarkBadge({ className }: { className?: string }) {
  return (
    <span
      title={TERMINAL_AI_MARK_EXPLANATION}
      aria-label="Typed by an AI"
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1 text-[9px] font-semibold leading-[14px] tracking-wide",
        "bg-primary/15 text-primary",
        className,
      )}
    >
      AI
    </span>
  );
}
