import { Layers } from "@/lib/icons";
import type { CompactionInfo } from "../../../types/chat";
import { fmtTokens } from "../../../shared/turn-usage";

/**
 * The rule above a compact summary, saying what that compaction did.
 *
 * Compaction is the largest thing that happens to a chat and the only one with no
 * visible cause: most of the history stops being sent, the next turn's prefix
 * collapses, and all the transcript shows for it is a long summary message that
 * reads like something the assistant chose to write. Naming it — and how much it
 * dropped — is what makes the rest of the conversation legible.
 *
 * Deliberately not interactive. Loading the messages it replaced is already the job
 * of the scroll-to-top expansion right above it, and a second control for the same
 * thing would be two affordances competing over one gesture.
 */
export function CompactionDivider({ compaction }: { compaction: CompactionInfo }) {
  const { trigger, preTokens, postTokens, savedTokens, durationMs } = compaction;

  const detail = [
    trigger === "manual" ? "Ran with /compact" : "Ran automatically on a full context window",
    `${fmtTokens(preTokens)} → ${fmtTokens(postTokens)} tokens`,
    ...(durationMs != null ? [`took ${formatDuration(durationMs)}`] : []),
  ].join(" · ");

  return (
    <div className="flex items-center gap-2 pt-2 text-[11px] text-text-subtle" title={detail}>
      <div className="h-px flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-1.5">
        <Layers className="size-3.5" />
        {/* `tabular-nums` so the figure does not jitter when a re-read changes it. */}
        <span className="tabular-nums">
          Compacted session · saved {fmtTokens(savedTokens)} tokens
        </span>
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Coarse on purpose: this is a footnote, and a compaction is never sub-second. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
