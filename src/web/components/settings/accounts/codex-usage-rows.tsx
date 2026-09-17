/**
 * The quota rows of a Codex account card.
 *
 * Split out so the wiring is testable on its own: the reset clock is the part that keeps
 * getting dropped, because the percentages render fine without it.
 *
 * Which rows appear follows what the account reports, because not every plan has the same
 * windows. A Plus account has a 5-hour quota and a weekly one; a ChatGPT Business account
 * has the weekly quota alone, and drawing an empty "5-Hour" row for it claimed a limit that
 * does not exist.
 *
 * A read that returned nothing at all is a different thing, and still shows both rows with
 * an em dash: a card that silently loses all its height reads as a broken account rather
 * than as missing data.
 */

import { AccountUsageBar } from "./account-bucket-row";
import { formatResetTime } from "./account-usage-format";
import type { Usage } from "./use-codex-accounts";

/** Usage arrives as a 0-1 fraction; the shared bar wants whole percent. */
function toPct(v?: number): number | null { return v != null ? Math.round(v * 100) : null; }

export function CodexUsageRows({ usage }: { usage: Usage }) {
  // Nothing was read — show the shape of the answer rather than an empty card.
  const unread = usage.session == null && usage.weekly == null;
  return (
    <div className="space-y-2">
      {(unread || usage.session != null) && (
        <AccountUsageBar label="5-Hour Session" pct={toPct(usage.fiveHour)} reset={formatResetTime(usage.session)} resetsAt={usage.session?.resetsAt} />
      )}
      {(unread || usage.weekly != null) && (
        <AccountUsageBar label="Weekly" pct={toPct(usage.sevenDay)} reset={formatResetTime(usage.weekly)} resetsAt={usage.weekly?.resetsAt} />
      )}
    </div>
  );
}
