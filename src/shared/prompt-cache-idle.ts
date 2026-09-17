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
  /**
   * Cached prefix *billed* on the last turn — a running session total, not a transcript size.
   *
   * The SDK sums `modelUsage` across a streaming session, so a long chat reports tens of
   * millions against a context window of one. It is a usable floor for "has this session
   * cached anything worth losing" and nothing more; never show it as a number.
   */
  billedPrefixTokens?: number;
  /**
   * Context the last turn actually held — the figure that may be displayed.
   *
   * Measured from one API call's own `usage` rather than summed (see
   * `TurnUsage.contextTokens`). Absent for a turn recorded before PPM measured this, so the
   * notice has to read correctly without it.
   */
  contextTokens?: number;
  /**
   * When this session was compacted, if it has been since its last cache write.
   *
   * A compaction replaces the conversation with a summary, so the cached prefix no longer
   * matches anything that will be sent — the cache is gone regardless of how recently it was
   * written. Cleared again by the first API call after the boundary, which caches the new
   * prefix; it therefore only survives a compaction that nothing followed, which is exactly
   * the `/compact` the user is about to type into.
   */
  compactedAt?: number;
}

/** Why a session's cache is gone. */
export type ColdReason = "expired" | "compacted";

export interface IdleCacheNotice {
  /** How long since the last turn, or since the compaction, for the wording. */
  idleMs: number;
  reason: ColdReason;
  /**
   * Transcript that the next message re-sends, when PPM measured it.
   *
   * Never set for a compaction: what will be re-cached then is the summary the compaction
   * produced, which no API call has reported a size for yet. Claude Code hardcodes the same
   * `undefined` for that branch.
   */
  contextTokens?: number;
}

/**
 * The notice to show, or null for nothing worth saying.
 *
 * Silent in three cases, all of them deliberate. Before the TTL, because the cache really is
 * still warm and a countdown to a cost that has not happened is just noise. Below
 * `PREFIX_WARN_TOKENS`, because a session that has never billed even that much has nothing
 * worth warning about — the same floor the after-the-fact warning uses, so the two cannot
 * disagree about what is worth mentioning. And with no state at all, because "PPM has not
 * measured this" and "this session has nothing cached" must not be reported as the same thing.
 */
export function idleCacheNotice(
  state: PromptCacheState | null | undefined,
  now: number,
): IdleCacheNotice | null {
  const status = promptCacheStatus(state, now);
  if (status.kind !== "cold") return null;
  return {
    idleMs: status.idleMs,
    reason: status.reason,
    ...(status.contextTokens != null && { contextTokens: status.contextTokens }),
  };
}

/**
 * The cache's clock, for a countdown that is on screen the whole time.
 *
 * Same three gates as the notice, deliberately: a chip that turns red at the hour while no
 * banner appears — or the reverse — asks the user to reconcile two readings of one fact.
 * `unknown` means PPM has not measured this session, which must render as nothing rather
 * than as a full or empty timer.
 */
export type PromptCacheStatus =
  | { kind: "unknown" }
  | { kind: "warm"; remainingMs: number }
  | { kind: "cold"; reason: ColdReason; idleMs: number; contextTokens?: number };

export function promptCacheStatus(
  state: PromptCacheState | null | undefined,
  now: number,
): PromptCacheStatus {
  if (!state) return { kind: "unknown" };

  // Before every other question, including whether anything has been measured at all. A
  // compaction does not make the cache *stale*, it makes it inapplicable — the prefix it
  // holds is not the conversation any more — so a turn that finished ten seconds ago is
  // still cold. Ordered exactly as Claude Code orders it, and it also settles the floor
  // below: a session large enough to have been compacted is never a trivial one.
  if (state.compactedAt != null) {
    return { kind: "cold", reason: "compacted", idleMs: Math.max(0, now - state.compactedAt) };
  }

  // No completed turn means nothing has been cached, so there is nothing to lose yet.
  if (state.lastTurnEndedAt == null || state.billedPrefixTokens == null) return { kind: "unknown" };
  if (state.billedPrefixTokens < PREFIX_WARN_TOKENS) return { kind: "unknown" };

  const idleMs = now - state.lastTurnEndedAt;
  // A clock that disagrees between server and browser can make this negative; a turn that
  // just finished is the warmest case there is, so it reads as "not idle" either way.
  if (idleMs < state.ttlMs) {
    // Clamped, so a skewed clock shows a full window rather than one longer than the TTL.
    return { kind: "warm", remainingMs: Math.min(state.ttlMs, state.ttlMs - idleMs) };
  }

  return {
    kind: "cold",
    reason: "expired",
    idleMs,
    ...(state.contextTokens != null && { contextTokens: state.contextTokens }),
  };
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

/**
 * Time left on the cache, for the composer's countdown chip.
 *
 * Rounded **up**, so a fresh turn reads the install's whole window (`60m`, not `59m`) and the
 * last partial minute reads `1m` rather than `0m` — a zero here would say expired while the
 * cache is still warm, which is the one reading the chip must never give.
 *
 * Minutes throughout, with no hours branch: the longest window PPM has is the subscription's
 * hour, so the only thing an hours branch could ever render is the full window as `1h` — one
 * more unit for the eye to parse, in the single case the chip is least interesting.
 */
export function formatCacheCountdown(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / MINUTE_MS))}m`;
}

/**
 * A measured context size, at the precision the decision needs.
 *
 * Whole thousands: the user is deciding whether to carry on in this chat or start a fresh
 * one, and no part of that turns on the difference between 58.7k and 59k.
 */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}
