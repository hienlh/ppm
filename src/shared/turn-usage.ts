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
  /**
   * Account that served the turn. The prompt cache is scoped per account, so a turn's cost
   * is only comparable to turns on the same account — a session that moved accounts shows
   * a cold prefix here for a reason that has nothing to do with the transcript.
   */
  accountId?: string;
  accountLabel?: string;
  /**
   * Live context held at the end of the turn — what the next message actually replays.
   *
   * Not derivable from anything else on this type. Every other field here is summed out of
   * the result's `modelUsage`, which the SDK accumulates across a streaming session and
   * across subagents: one measured session reported 55.9M prefix tokens against a 200k
   * window, and per-turn deltas fare no better (one turn's delta was 4.2M — twenty-one
   * windows — because twenty subagents each replayed their own prefix into the same sum).
   *
   * This comes instead from the `usage` on the turn's last top-level assistant message,
   * which is one API call's own input side and so is a real context size. Absent when no
   * such message carried usage; never substitute a summed figure for it.
   */
  contextTokens?: number;
  /**
   * Cache window the API reported for this turn, when it reported one.
   *
   * Outranks the provider's credential-shaped guess wherever both exist — see
   * `messageCacheTtl`. Absent on a turn that only read the cache, and on every turn recorded
   * before PPM read this field.
   */
  cacheTtlMs?: number;
  /**
   * When a compaction invalidated this session's cache, if one did and nothing re-cached after.
   *
   * Not a timestamp of "the last compaction" — the provider clears it on the next API call,
   * so an auto-compact mid-turn never reaches here. What survives is a compaction the turn
   * ended on, which is the case where the user's next message pays to rebuild the prefix.
   */
  compactedAt?: number;
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
  opts: { coldReason?: string; accountId?: string; accountLabel?: string; contextTokens?: number; cacheTtlMs?: number; compactedAt?: number } = {},
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
    ...(opts.accountId && { accountId: opts.accountId }),
    ...(opts.accountLabel && { accountLabel: opts.accountLabel }),
    ...(opts.contextTokens != null && { contextTokens: opts.contextTokens }),
    ...(opts.cacheTtlMs != null && { cacheTtlMs: opts.cacheTtlMs }),
    ...(opts.compactedAt != null && { compactedAt: opts.compactedAt }),
  };
}

/**
 * Context size carried by one assistant message's `usage`, or undefined if it carried none.
 *
 * The input side of a single API call: what the model was actually given, whether it arrived
 * fresh or out of the cache. Output tokens are excluded — they are not in the context the
 * *next* call replays until they have been written back as a message, and counting them here
 * would inflate every turn by its own answer.
 */
export function messageContextTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const total = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
  // Zero is not a context, it is a frame that carried no input side — a usage object with
  // only output tokens, say. Returning it would render as "re-sends about 0 tokens" on a
  // full session. Matches Claude Code's own reader, which likewise sums all three fields
  // without requiring any one of them and rejects a zero total.
  return total > 0 ? total : undefined;
}

/** Which prompt-cache window the API wrote this turn's prefix into. */
export type PromptCacheTtl = "1h" | "5m";

/**
 * The cache lifetime the API itself reports, or undefined when it reported none.
 *
 * PPM otherwise *infers* this from the credential — an `sk-ant-oat` token means a
 * subscription and therefore an hour, anything else five minutes — which is a guess about
 * billing made from the shape of a string. It is wrong for a proxy, for a custom `base_url`,
 * and for a subscription past its usage limits, and being wrong is not cosmetic: the
 * countdown and the idle banner both measure against this, so a session whose cache really
 * lives an hour is declared cold at minute five.
 *
 * `usage.cache_creation` answers it outright. Mirrors Claude Code's own reader, including
 * the order: a prefix written into both windows is reported as the longer one, because that
 * is the one still standing. Returns the discriminant rather than milliseconds so this stays
 * free of the server's constants — `shared/` is imported by the browser bundle.
 */
export function messageCacheTtl(usage: unknown): PromptCacheTtl | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const cc = (usage as { cache_creation?: unknown }).cache_creation;
  if (!cc || typeof cc !== "object") return undefined;
  const c = cc as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (num(c.ephemeral_1h_input_tokens) > 0) return "1h";
  if (num(c.ephemeral_5m_input_tokens) > 0) return "5m";
  // A turn that only *read* the cache writes nothing, so it names no window. That is silence,
  // not five minutes: answering the short one here would expire a warm hour-long cache.
  return undefined;
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
  cache_expired: "the session's prompt cache had already lapsed, so PPM released its subprocess",
  idle_timeout: "the session sat idle with no tab open long enough for PPM to release its subprocess",
  warm_idle_cap: "too many idle sessions were holding a subprocess, so this one was released early",
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
    ...(u.accountLabel || u.accountId ? [`account=${u.accountLabel ?? u.accountId}`] : []),
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
