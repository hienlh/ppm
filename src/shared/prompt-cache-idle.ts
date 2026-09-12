/**
 * Whether a session has sat idle long enough that its prompt cache is gone.
 *
 * The cost of a turn is dominated by the replayed transcript, and that replay is cheap only
 * while the prefix behind it is still cached (see `turn-usage.ts`). The cache is the one
 * part of that with a clock on it: it lapses on its own, silently, some time after the last
 * turn — so the first message of the next morning costs several times what the last message
 * of the night before did, for no reason visible in the conversation.
 *
 * `TurnCostWarning` reports that after the fact, on the turn that paid. This says it
 * *before*, while the user can still decide whether to carry on in this chat or start a
 * cheaper one. Pure and shared so the threshold is the same one the warning already uses.
 */

import { PREFIX_WARN_TOKENS } from "./turn-usage.ts";

/**
 * What the server knows about a session's cache.
 *
 * `ttlMs` alone is the state of a session that has not completed a turn yet — it is a
 * property of the install, not of the conversation, and sending it early is what lets a
 * long-lived tab arm this notice from its own turns without waiting for a reconnect.
 */
export interface PromptCacheState {
  /** This install's cache lifetime: an hour on a subscription, five minutes on an API key. */
  ttlMs: number;
  /** When the last turn completed — the moment the cache was last written. */
  lastTurnEndedAt?: number;
  /** Transcript replayed on that turn — what re-caching would cost again. */
  prefixTokens?: number;
}

export interface IdleCacheNotice {
  /** How long since the last turn, for the wording. */
  idleMs: number;
  /** Tokens the next message would re-cache. */
  prefixTokens: number;
}

/**
 * The notice to show, or null for nothing worth saying.
 *
 * Silent in three cases, all of them deliberate. Before the TTL, because the cache really is
 * still warm and a countdown to a cost that has not happened is just noise. Below
 * `PREFIX_WARN_TOKENS`, because a short transcript is cheap however it is billed — the same
 * floor the after-the-fact warning uses, so the two cannot disagree about what is worth
 * mentioning. And with no state at all, because "PPM has not measured this" and "this
 * session has nothing cached" must not be reported as the same thing.
 */
export function idleCacheNotice(
  state: PromptCacheState | null | undefined,
  now: number,
): IdleCacheNotice | null {
  if (!state) return null;
  // No completed turn means nothing has been cached, so there is nothing to lose yet.
  if (state.lastTurnEndedAt == null || state.prefixTokens == null) return null;
  if (state.prefixTokens < PREFIX_WARN_TOKENS) return null;

  const idleMs = now - state.lastTurnEndedAt;
  // A clock that disagrees between server and browser can make this negative; a turn that
  // just finished is the warmest case there is, so it reads as "not idle" either way.
  if (idleMs < state.ttlMs) return null;

  return { idleMs, prefixTokens: state.prefixTokens };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long the session has been idle, at the coarsest unit that still says something.
 *
 * Minutes are dropped past a day: "2d 7h 13m" is three figures to answer "is this stale",
 * which is the only question being asked.
 */
export function formatIdleDuration(ms: number): string {
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS);
    const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, Math.floor(ms / MINUTE_MS))}m`;
}
