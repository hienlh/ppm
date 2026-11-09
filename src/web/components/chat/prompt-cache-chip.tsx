import { Clock } from "@/lib/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import type { PromptCacheState } from "../../../shared/prompt-cache-idle";
import { promptCacheStatus, formatIdleDuration, formatContextTokens } from "../../../shared/prompt-cache-idle";

/**
 * The prompt cache, beside the mic in the composer bar — only once it has gone cold.
 *
 * A cache still warm is not news: a countdown with nothing to do about it was one more chip in
 * the bar, and a red fill read as an error. So a warm or unmeasured cache shows nothing, and a
 * cold one is a red clock and how long ago it went ("1h 51m") with no fill or border — the fact
 * that the next message re-sends the transcript at full price, said where the Send button is.
 *
 * The hover text is the only part that is hover-only, and deliberately so: the number is on
 * screen and the banner above the composer says the rest, so touch loses phrasing, not a fact.
 */
export function PromptCacheChip({ promptCache }: { promptCache: PromptCacheState | null }) {
  const status = promptCacheStatus(promptCache, useMinuteClock());
  if (status.kind !== "cold") return null;

  const label = formatIdleDuration(status.idleMs);
  // No token figure for a compaction on purpose: what the next message re-caches is the summary
  // the compaction just produced, and no API call has reported its size yet.
  const detail = status.reason === "compacted"
    ? `Prompt cache does not cover the compacted conversation. Compacted ${label} ago, so your next message will re-cache it.`
    : `Prompt cache expired ${label} ago. Your next message re-sends ${
      status.contextTokens != null ? `about ${formatContextTokens(status.contextTokens)} tokens` : "the whole transcript"
    } at full price.`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-prompt-cache="cold"
          aria-label={detail}
          className="footer-fade-in inline-flex h-[30px] shrink-0 items-center gap-1 whitespace-nowrap px-1.5 text-[11px] text-error"
        >
          <Clock className="size-4 shrink-0" />
          {/* `tabular-nums` so a minute ticking over does not shift the buttons beside it. */}
          <span className="tabular-nums @max-[420px]/chat:hidden max-md:hidden">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-xs">
        {detail}
      </TooltipContent>
    </Tooltip>
  );
}
