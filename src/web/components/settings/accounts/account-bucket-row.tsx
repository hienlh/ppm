/**
 * The usage bar, and the rate-limit-bucket adapter over it.
 *
 * `AccountUsageBar` is the shared visual, so Claude and Codex rows read the same; it takes
 * the reset text already formatted, because a caller may hold a percentage whose bucket is
 * missing and must render the bar without inventing a reset time. `AccountBucketRow` is the
 * adapter for callers that do have a whole bucket, and it drops the row when they do not.
 */

import type { LimitBucket } from "../../../../types/chat";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { barColor, formatResetAt, formatResetTime, pctColor } from "./account-usage-format";

export function AccountUsageBar({ label, pct, reset, resetsAt }: {
  label: string;
  /** 0-100. Null renders the row with an em dash instead of a bar. */
  pct: number | null;
  /** "Resets in" text, when the source knows it. */
  reset?: string | null;
  /** The same moment as an absolute timestamp, shown on hover. Optional: a caller holding
   *  only a percentage has no bucket to take it from. */
  resetsAt?: string | null;
}) {
  const resetOn = formatResetAt(resetsAt);
  return (
    <div className="space-y-1" data-testid="account-usage-bar">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-primary">{label}</span>
        {reset && (
          // The relative figure stays on the card and the exact moment sits behind it: one
          // answers "can I keep going", the other "will it be back by three", and only the
          // first is worth the width.
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] text-text-subtle cursor-default">↻ {reset}</span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {resetOn ? `Resets ${resetOn}` : "Resets in"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-border overflow-hidden">
          {pct != null && (
            <div
              className={`h-full rounded-full transition-all ${barColor(pct)}`}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          )}
        </div>
        <span className={`text-xs font-medium tabular-nums w-10 text-right ${pct != null ? pctColor(pct) : "text-text-subtle"}`}>
          {pct != null ? `${pct}%` : "—"}
        </span>
      </div>
    </div>
  );
}

/** A Claude rate-limit bucket as a usage bar. Renders nothing when the bucket is absent. */
export function AccountBucketRow({ label, bucket }: { label: string; bucket?: LimitBucket }) {
  if (!bucket) return null;
  return (
    <AccountUsageBar
      label={label}
      pct={Math.round(bucket.utilization * 100)}
      reset={formatResetTime(bucket)}
      resetsAt={bucket.resetsAt}
    />
  );
}
