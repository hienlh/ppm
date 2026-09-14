import { useEffect, useState } from "react";
import { Clock } from "@/lib/icons";
import type { PromptCacheState } from "../../../shared/prompt-cache-idle";
import { idleCacheNotice, formatIdleDuration } from "../../../shared/prompt-cache-idle";

/**
 * How long the session has been idle, when that has stopped being free.
 *
 * Sits above the composer rather than in the transcript: it describes what the *next*
 * message will cost, not anything that has happened, and the transcript is a record of
 * what did. It disappears on its own the moment a turn starts, because by then the
 * decision it exists to inform has been made.
 *
 * Deliberately gives no token figure. Claude Code's own version of this notice names one,
 * but nothing the SDK reports at the end of a turn is the size of the live context —
 * `modelUsage` is a running session total, so quoting it printed "1.0M tokens" against a
 * window of the same size. The consequence is the actionable half anyway.
 *
 * Owns its outer padding so that "no notice" costs no layout: the caller renders this
 * unconditionally, and a wrapper with padding around nothing is a gap above the composer
 * that appears for no reason.
 */
export function IdleCacheNotice({ promptCache }: { promptCache: PromptCacheState | null }) {
  // Re-read the clock rather than count: a phone that slept for six hours throttles or
  // drops timers entirely, so an accumulated count would come back six hours short.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const notice = idleCacheNotice(promptCache, now);
  if (!notice) return null;

  return (
    // Same `px-4 pt-4 pb-4` as the approval/thinking block below, so the notice keeps the
    // composer's breathing room instead of sitting on top of it.
    <div className="px-4 pt-4 pb-4 select-none">
      {/* `w-fit` rather than a full-width row: this is one sentence, and a thin bordered
          box stretched across an ultrawide reads as a broken layout. It still falls back
          to the available width — and wraps — on a phone. */}
      <div className="flex w-fit items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-[11px] text-text-secondary">
        <Clock className="mt-px size-3.5 shrink-0 text-text-subtle" />
        <span>
          Idle <span className="tabular-nums">{formatIdleDuration(notice.idleMs)}</span>. The
          prompt cache has likely expired, so your next message re-sends the whole transcript
          at full price.
        </span>
      </div>
    </div>
  );
}
