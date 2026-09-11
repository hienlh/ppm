import type { UsageInfo } from "../../types/chat.ts";

/**
 * What one provider must supply for its quota to be polled, cached, and stored
 * by the shared usage layer.
 *
 * Everything scheduling-shaped — the background timer, the fetch timeout, the
 * per-account cache, negative caching, staggering, in-flight de-duplication,
 * writing to and reading back from the snapshot store — belongs to that layer,
 * not here. A new provider implements the two required methods and inherits all
 * of it; nothing in this interface knows about HTTP, JSON-RPC, or subprocesses.
 */
export interface ProviderUsageSource {
  /** Matches the AIProvider id, and is what a snapshot row is scoped by. */
  readonly providerId: string;

  /**
   * Accounts whose quota should be kept warm.
   *
   * An empty array is meaningful: it means this provider has no account store
   * configured and reads a single ambient login instead, which the layer keys
   * under {@link AMBIENT_ACCOUNT_KEY}.
   */
  listAccountIds(): string[];

  /**
   * Read one account's quota from the provider, live.
   *
   * Throw or reject on failure; do NOT return an empty object to signal one.
   * The layer distinguishes the two: a rejection is cached briefly so a broken
   * account cannot be retried on every request, while a resolved empty object
   * is stored as a genuine "this account has no limits to report".
   *
   * `accountId` is {@link AMBIENT_ACCOUNT_KEY} when the provider has no
   * account store.
   */
  fetch(accountId: string): Promise<UsageInfo>;

  /**
   * Skip this account on a background sweep without treating it as a failure —
   * an expired token, a cooldown after a rate-limit, a login that cannot
   * refresh. The last stored value stays readable.
   */
  shouldSkip?(accountId: string): boolean | Promise<boolean>;

  /** Poll period override. Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;

  /** Per-fetch ceiling override. Defaults to {@link FETCH_TIMEOUT_MS}. */
  readonly fetchTimeoutMs?: number;
}

/** Cache/store key for a provider that reads one ambient login, not an account list. */
export const AMBIENT_ACCOUNT_KEY = "";

/** Both providers refresh on the same cadence; a source may override it. */
export const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 min

/** Gap between accounts inside one sweep, so a sweep is not a burst. */
export const ACCOUNT_STAGGER_MS = 1_000;

/**
 * Ceiling on a single `fetch`. Codex spawns an app-server to answer, and that
 * subprocess has been observed to accept the spawn and then never reply — with
 * no ceiling the sweep waits forever, the HTTP route behind it never answers,
 * and the subprocess is never closed. Claude's HTTP call has its own timeout
 * but is covered here too, so one hung account cannot stall the whole sweep.
 */
export const FETCH_TIMEOUT_MS = 20_000;

/** How long a resolved value is served from memory before a re-read. */
export const USAGE_CACHE_TTL_MS = 300_000; // 5 min — matches the poll period

/**
 * How long a FAILURE is remembered.
 *
 * Short, because the cause is usually transient (a login being refreshed, a
 * subprocess losing a race). Non-zero, because without it every request that
 * misses re-attempts a fetch: for codex that meant spawning another app-server
 * per request, and the ones that hung were never reaped.
 */
export const USAGE_FAILURE_TTL_MS = 30_000;
