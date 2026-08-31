/**
 * Per-turn token accounting.
 *
 * A resumed session re-sends its entire transcript on every turn, so the bill for a turn is
 * dominated by that replayed prefix rather than by anything the user typed. Cached prefix
 * tokens cost a fraction of fresh ones, which makes the cache hit rate — not the message
 * length — the number that decides whether a turn was cheap or expensive.
 *
 * That is the whole reason this module exists: the SDK already reports the split, PPM was
 * throwing it away, and a session whose prefix stops being cached gets an order of magnitude
 * more expensive with nothing in the UI to show why.
 */

/** Shape of one entry in the SDK result's `modelUsage`, narrowed to the fields used here. */
export interface ModelUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  costUSD?: number;
}

export interface TurnUsage {
  /** Model that carried the largest share of the prefix (subagents report separately). */
  model: string;
  /** Fresh, uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Prefix served from cache — an order of magnitude cheaper than `inputTokens`. */
  cacheReadTokens: number;
  /** Prefix written into the cache, billed above the fresh-input rate. */
  cacheWriteTokens: number;
  contextWindow: number;
  costUsd: number;
  /** Share of the replayed prefix served from cache, 0–1. */
  cacheHitRate: number;
  /** The turn re-sent an existing transcript on a subprocess spawned for it. */
  coldStart: boolean;
  /** Why the previous subprocess went away, when PPM knows. */
  coldReason?: string;
}

/** Total prefix replayed to the API this turn, cached or not. */
export function prefixTokens(u: TurnUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

/** Prefix tokens paid for at full rate — what a warm cache would have discounted. */
export function uncachedPrefixTokens(u: TurnUsage): number {
  return u.inputTokens + u.cacheWriteTokens;
}

/**
 * Aggregate the SDK's per-model usage into one turn.
 *
 * Token counts are summed because every model in the map is billed, while the label takes the
 * model holding the largest prefix so a turn is not attributed to a subagent's cheap helper.
 */
export function buildTurnUsage(
  modelUsage: Record<string, ModelUsageLike> | undefined,
  opts: { coldReason?: string } = {},
): TurnUsage | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return undefined;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let model = "";
  let contextWindow = 0;
  let topPrefix = -1;

  for (const [name, u] of entries) {
    const input = u.inputTokens ?? 0;
    const read = u.cacheReadInputTokens ?? 0;
    const write = u.cacheCreationInputTokens ?? 0;
    inputTokens += input;
    outputTokens += u.outputTokens ?? 0;
    cacheReadTokens += read;
    cacheWriteTokens += write;
    costUsd += u.costUSD ?? 0;

    const prefix = input + read + write;
    if (prefix > topPrefix) {
      topPrefix = prefix;
      model = name;
      contextWindow = u.contextWindow ?? 0;
    }
  }

  const prefix = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    contextWindow,
    costUsd,
    cacheHitRate: prefix > 0 ? cacheReadTokens / prefix : 0,
    coldStart: !!opts.coldReason,
    ...(opts.coldReason && { coldReason: opts.coldReason }),
  };
}

/**
 * A prefix smaller than this is cheap however it is billed, so a poor hit rate on it is not
 * worth interrupting the user over. Short sessions legitimately start cold.
 */
export const PREFIX_WARN_TOKENS = 20_000;

/** Below this share of the prefix cached, the turn cost materially more than a warm one. */
const HIT_RATE_BAD = 0.5;
/** Above `HIT_RATE_BAD` but under this, part of the prefix was still re-sent at full price. */
const HIT_RATE_WARN = 0.9;

export type TurnCostLevel = "ok" | "warn" | "bad";

export interface TurnCostVerdict {
  level: TurnCostLevel;
  /** Prefix tokens that a warm cache would have discounted. */
  wastedTokens: number;
  /** Why this turn cost more than it had to, phrased for the user. */
  reason: string;
}

const COLD_REASON_TEXT: Record<string, string> = {
  idle_timeout: "the session sat idle with no tab open long enough for PPM to release its subprocess",
  // Retained for turns recorded before the teardown moved to the idle timer.
  tab_closed: "PPM shut the session's subprocess down when the last tab disconnected",
  set_model: "the model was changed, which restarts the session",
  stream_ended: "the session's subprocess had already exited",
  resume: "the session was resumed on a new subprocess",
};

/**
 * Judge a turn on the only thing the user can act on: how much of an *existing* transcript
 * was paid for twice.
 *
 * A turn is only wasteful if there was a warm prefix to reuse. The first turn of a session
 * writes its system prompt and instruction files into the cache with nothing to read back,
 * which looks identical to the expensive case in the raw numbers but is unavoidable — so
 * `coldStart`, not the hit rate alone, gates the warning. The cost of that choice is that
 * mid-turn retries, which rebuild without recording a reason, go unflagged here; they remain
 * visible in the per-turn history and the server log.
 */
export function assessTurnCost(u: TurnUsage): TurnCostVerdict {
  const wastedTokens = uncachedPrefixTokens(u);
  const prefix = prefixTokens(u);

  if (!u.coldStart || prefix < PREFIX_WARN_TOKENS) {
    return { level: "ok", wastedTokens, reason: "" };
  }

  const level: TurnCostLevel =
    u.cacheHitRate < HIT_RATE_BAD ? "bad" : u.cacheHitRate < HIT_RATE_WARN ? "warn" : "ok";
  if (level === "ok") return { level, wastedTokens, reason: "" };

  const cause = u.coldReason ? COLD_REASON_TEXT[u.coldReason] ?? `the session restarted (${u.coldReason})` : null;
  const reason = cause
    ? `${fmtTokens(wastedTokens)} of this session's transcript was re-sent uncached because ${cause}.`
    : `${fmtTokens(wastedTokens)} of this session's transcript was re-sent uncached.`;

  return { level, wastedTokens, reason };
}

/**
 * Billing weights relative to a fresh input token, used only to compare a turn against
 * itself. Absolute cost comes from the SDK's `costUSD`; these exist to answer "how much
 * cheaper would this turn have been with a warm cache", which no reported field covers.
 */
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;

/**
 * How many times more the turn's prefix cost than the same prefix fully cached.
 *
 * Returns 1 when there is nothing to compare — a fully cached prefix is already the floor.
 */
export function prefixCostMultiplier(u: TurnUsage): number {
  const prefix = prefixTokens(u);
  if (prefix === 0) return 1;
  const actual =
    u.inputTokens + u.cacheWriteTokens * CACHE_WRITE_WEIGHT + u.cacheReadTokens * CACHE_READ_WEIGHT;
  const floor = prefix * CACHE_READ_WEIGHT;
  return floor > 0 ? Math.max(1, actual / floor) : 1;
}

/** Compact token count for logs and dense UI. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** One-line summary for the server log. */
export function formatTurnUsageLog(u: TurnUsage): string {
  const verdict = assessTurnCost(u);
  const pct = Math.round(u.cacheHitRate * 100);
  const ctx = u.contextWindow > 0
    ? ` ctx=${Math.min(100, Math.round((prefixTokens(u) + u.outputTokens) / u.contextWindow * 100))}%`
    : "";
  return [
    `model=${u.model}`,
    `cold=${u.coldStart ? (u.coldReason ?? "yes") : "no"}`,
    `in=${fmtTokens(u.inputTokens)}`,
    `cacheRead=${fmtTokens(u.cacheReadTokens)}`,
    `cacheWrite=${fmtTokens(u.cacheWriteTokens)}`,
    `out=${fmtTokens(u.outputTokens)}`,
    `hit=${pct}%${ctx}`,
    `cost=$${u.costUsd.toFixed(4)}`,
    `verdict=${verdict.level}`,
  ].join(" ");
}
