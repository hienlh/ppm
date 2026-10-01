import { Clock } from "@/lib/icons";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import type { PromptCacheState } from "../../../shared/prompt-cache-idle";
import { idleCacheNotice, formatIdleDuration, formatContextTokens } from "../../../shared/prompt-cache-idle";

/**
 * How long the session has been idle, when that has stopped being free.
 *
 * Sits above the composer rather than in the transcript: it describes what the *next*
 * message will cost, not anything that has happened, and the transcript is a record of
 * what did. It disappears on its own the moment a turn starts, because by then the
 * decision it exists to inform has been made.
 *
 * Says one of two things. A compaction replaced the conversation, so the cache holds a prefix
 * that will never be sent again — that is reported without a token figure, because the
 * summary it produced has not been through an API call yet and nothing has measured it.
 * Otherwise the cache simply lapsed, and the transcript still standing is what gets re-sent.
 *
 * Names a token figure only when one was measured. `modelUsage` cannot supply it — the SDK
 * accumulates it across the session and across subagents, which is what once printed "1.0M
 * tokens" against a window of the same size — so the number comes from the turn's last
 * top-level assistant message instead (`TurnUsage.contextTokens`). Turns recorded before PPM
 * measured that carry none, and the sentence has to stand without it.
 *
 * Owns its outer padding so that "no notice" costs no layout: the caller renders this
 * unconditionally, and a wrapper with padding around nothing is a gap above the composer
 * that appears for no reason.
 */
export function IdleCacheNotice({ promptCache }: { promptCache: PromptCacheState | null }) {
  const notice = idleCacheNotice(promptCache, useMinuteClock());
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
        {notice.reason === "compacted" ? (
          <span>
            The conversation was compacted{" "}
            <span className="tabular-nums">{formatIdleDuration(notice.idleMs)}</span> ago, so the
            prompt cache no longer covers it and your next message will re-cache it.
          </span>
        ) : (
          <span>
            Idle <span className="tabular-nums">{formatIdleDuration(notice.idleMs)}</span>. The
            prompt cache has likely expired, so your next message re-sends{" "}
            {notice.contextTokens != null ? (
              <>
                about{" "}
                <span className="tabular-nums">{formatContextTokens(notice.contextTokens)}</span>{" "}
                tokens
              </>
            ) : (
              "the whole transcript"
            )}{" "}
            at full price.
          </span>
        )}
      </div>
    </div>
  );
}
