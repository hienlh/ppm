/**
 * The usage bar, and the rate-limit-bucket adapter over it.
 *
 * Two callers with different data: a Claude bucket knows its reset time and window, a Codex
 * usage figure is a bare percentage. `AccountUsageBar` is the shared visual so both read the
 * same; the bucket adapter adds what only a bucket has. Fabricating a reset time to force
 * Codex through the bucket shape would have put invented data on screen.
 */

import type { LimitBucket } from "../../../../types/chat";
import { barColor, formatResetTime, pctColor } from "./account-usage-format";

export function AccountUsageBar({ label, pct, reset }: {
  label: string;
  /** 0-100. Null renders the row with an em dash instead of a bar. */
  pct: number | null;
  /** "Resets in" text, when the source knows it. */
  reset?: string | null;
}) {
  return (
    <div className="space-y-1" data-testid="account-usage-bar">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-primary">{label}</span>
        {reset && (
          <span className="text-[10px] text-text-subtle" title="Resets in">↻ {reset}</span>
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
    />
  );
}
