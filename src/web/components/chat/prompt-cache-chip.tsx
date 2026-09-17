import { Clock } from "@/lib/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import type { PromptCacheState } from "../../../shared/prompt-cache-idle";
import {
  promptCacheStatus,
  formatCacheCountdown,
  formatIdleDuration,
  formatContextTokens,
} from "../../../shared/prompt-cache-idle";

/**
 * How long this session's prompt cache has left, in the composer's chip row.
 *
 * The banner above the composer only appears once the cache is already gone, which answers
 * "why was that turn expensive" after the fact. This is the same fact while it can still be
 * acted on — a countdown says the next message is cheap *now*, and going red says it is not.
 *
 * Reads as a chip rather than a control because there is nothing to click: the cache's clock
 * is not a setting. Renders nothing at all when PPM has not measured the session, so a chat
 * with no completed turn shows a row unchanged from before.
 *
 * The hover text is the only part that is hover-only, and deliberately so: everything it
 * says is already on screen as the chip's own number and, once expired, as the banner. So
 * touch loses a sentence of phrasing rather than a fact — which is why this needs no tap
 * affordance and stays out of the composer's tab order.
 */
export function PromptCacheChip({ promptCache }: { promptCache: PromptCacheState | null }) {
  const status = promptCacheStatus(promptCache, useMinuteClock());
  if (status.kind === "unknown") return null;

  const cold = status.kind === "cold";
  const label = status.kind === "cold"
    ? formatIdleDuration(status.idleMs)
    : formatCacheCountdown(status.remainingMs);

  let detail: string;
  if (status.kind !== "cold") {
    detail = `Prompt cache warm, about ${label.replace(/m$/, " min")} left.`;
  } else if (status.reason === "compacted") {
    // No token figure here on purpose: what the next message re-caches is the summary the
    // compaction just produced, and no API call has reported its size yet.
    detail = `Prompt cache does not cover the compacted conversation. Compacted ${label} ago, so your next message will re-cache it.`;
  } else {
    detail = `Prompt cache expired ${label} ago. Your next message re-sends ${
      status.contextTokens != null
        ? `about ${formatContextTokens(status.contextTokens)} tokens`
        : "the whole transcript"
    } at full price.`;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // Same shape as `ModeChip` and `PriorityToggle` beside it; only the colour carries
          // the state, and only once the cache is gone — a countdown still running is not news.
          className={`inline-flex items-center gap-1.5 px-[9px] py-1 rounded-full text-[11.5px] border transition-colors ${
            cold
              ? "text-error border-error/40 bg-error/10"
              : "text-text-2 bg-panel-2 border-border-soft"
          }`}
        >
          <Clock className="size-3" />
          {/* `tabular-nums` so a minute ticking over does not shift the chips beside it. */}
          <span className="tabular-nums">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-xs">
        {detail}
      </TooltipContent>
    </Tooltip>
  );
}
