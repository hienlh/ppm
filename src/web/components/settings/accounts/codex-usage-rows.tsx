/**
 * The two quota rows of a Codex account card.
 *
 * Split out so the wiring is testable on its own: the reset clock is the part that keeps
 * getting dropped, because the percentages render fine without it.
 *
 * Unlike the Claude card's `AccountBucketRow`, a row here stays on screen with an em dash
 * when the quota read failed instead of disappearing — a card that silently loses half its
 * height reads as a broken account rather than as missing data.
 */

import { AccountUsageBar } from "./account-bucket-row";
import { formatResetTime } from "./account-usage-format";
import type { Usage } from "./use-codex-accounts";

/** Usage arrives as a 0-1 fraction; the shared bar wants whole percent. */
function toPct(v?: number): number | null { return v != null ? Math.round(v * 100) : null; }

export function CodexUsageRows({ usage }: { usage: Usage }) {
  return (
    <div className="space-y-2">
      <AccountUsageBar label="5-Hour Session" pct={toPct(usage.fiveHour)} reset={formatResetTime(usage.session)} />
      <AccountUsageBar label="Weekly" pct={toPct(usage.sevenDay)} reset={formatResetTime(usage.weekly)} />
    </div>
  );
}
