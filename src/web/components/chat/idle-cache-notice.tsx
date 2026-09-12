import { useEffect, useState } from "react";
import { Clock } from "@/lib/icons";
import type { PromptCacheState } from "../../../shared/prompt-cache-idle";
import { idleCacheNotice, formatIdleDuration } from "../../../shared/prompt-cache-idle";
import { fmtTokens } from "../../../shared/turn-usage";

/**
 * How long the session has been idle, when that has stopped being free.
 *
 * Sits above the composer rather than in the transcript: it describes what the *next*
 * message will cost, not anything that has happened, and the transcript is a record of
 * what did. It disappears on its own the moment a turn starts, because by then the
 * decision it exists to inform has been made.
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
    <div className="flex items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-[11px] text-text-secondary">
      <Clock className="mt-px size-3.5 shrink-0 text-text-subtle" />
      <span className="flex-1">
        Idle <span className="tabular-nums">{formatIdleDuration(notice.idleMs)}</span>. The prompt
        cache has likely expired, so your next message will re-cache about{" "}
        <span className="tabular-nums">{fmtTokens(notice.prefixTokens)}</span> tokens.
      </span>
    </div>
  );
}
