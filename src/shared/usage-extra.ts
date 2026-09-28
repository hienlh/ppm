/**
 * Usage details that have no fixed column: parsed from the provider's payload, stored as
 * one JSON column on the limit snapshot, and read back into `UsageInfo`.
 *
 * Two things live here today, and both would otherwise vanish whenever usage is served from
 * the stored snapshot rather than a live fetch:
 *
 * - Claude's per-model weekly limits. Anthropic stopped filling `seven_day_opus` /
 *   `seven_day_sonnet` (both null now) and reports a model's own weekly cap as a
 *   `limits[]` entry of kind `weekly_scoped` with the model's display name — that is how
 *   "Fable" arrives. Read by name, so the next model shows up without a code change.
 * - Codex's free rate-limit reset credits (`rateLimitResetCredits`), which say how many
 *   "reset my limits" grants the account still holds and when they lapse.
 *
 * Pure and dependency-free so both the server and the browser can use it.
 */
import type { ResetCredits, ScopedLimitBucket } from "../types/chat.ts";

/** A per-model limit as stored: no countdown fields, those are recomputed on read. */
export interface StoredScopedLimit {
  label: string;
  utilization: number;
  resetsAt: string;
}

export interface UsageExtra {
  scoped?: StoredScopedLimit[];
  resetCredits?: ResetCredits;
}

const WEEK_HOURS = 168;

/** Recompute a weekly bucket's countdown against the current clock. */
export function scopedBucket(s: StoredScopedLimit): ScopedLimitBucket {
  const diff = s.resetsAt ? new Date(s.resetsAt).getTime() - Date.now() : 0;
  const totalMins = diff > 0 ? Math.ceil(diff / 60_000) : 0;
  return {
    label: s.label,
    utilization: s.utilization,
    resetsAt: s.resetsAt,
    resetsInMinutes: null,
    resetsInHours: Math.round((totalMins / 60) * 100) / 100,
    windowHours: WEEK_HOURS,
  };
}

/**
 * Claude `limits[]` → per-model weekly limits.
 *
 * `percent` is 0–100 like the rest of that payload; stored as a 0–1 fraction like every other
 * bucket. Entries without a model name are skipped: an unlabelled row would read as a second
 * "Weekly" bar that disagrees with the real one.
 */
export function parseClaudeScopedLimits(raw: unknown): StoredScopedLimit[] {
  const limits = (raw as { limits?: unknown })?.limits;
  if (!Array.isArray(limits)) return [];
  const out: StoredScopedLimit[] = [];
  for (const l of limits as Array<Record<string, any>>) {
    if (l?.kind !== "weekly_scoped") continue;
    const label = l?.scope?.model?.display_name;
    if (typeof label !== "string" || !label.trim() || typeof l.percent !== "number") continue;
    out.push({ label: label.trim(), utilization: l.percent / 100, resetsAt: typeof l.resets_at === "string" ? l.resets_at : "" });
  }
  return out;
}

/**
 * Codex `rateLimitResetCredits` → how many free resets are left and when the next lapses.
 *
 * Only credits Codex marks `available` count; a used or expired one is history. Returns
 * undefined when the payload has no credits block at all, so "none reported" and "0 left"
 * stay distinguishable.
 */
export function parseCodexResetCredits(raw: unknown): ResetCredits | undefined {
  const block = (raw as { rateLimitResetCredits?: unknown })?.rateLimitResetCredits as
    { credits?: Array<Record<string, any>> } | null | undefined;
  if (!block || !Array.isArray(block.credits)) return undefined;
  const available = block.credits
    .filter((c) => c?.status === "available")
    .filter((c) => typeof c.expiresAt !== "number" || c.expiresAt * 1000 > Date.now())
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  const next = available[0];
  return {
    available: available.length,
    ...(typeof next?.expiresAt === "number" ? { nextExpiresAt: new Date(next.expiresAt * 1000).toISOString() } : {}),
    ...(typeof next?.title === "string" ? { title: next.title } : {}),
    ...(typeof next?.id === "string" ? { nextCreditId: next.id } : {}),
  };
}

/**
 * Whether a limit has actually been reached — at 100% of a window, as the card rounds it.
 *
 * The one rule both the "Use reset" button and the server's refusal follow, so the button can
 * never offer what the server would turn down. Reached, not approaching: spending a reset at
 * 90% throws away the 10% left *and* moves the weekly reset date (OpenAI: the next weekly reset
 * is counted from when you continue, and the original one is not also granted).
 */
export function usageLimitReached(u: { session?: { utilization: number }; weekly?: { utilization: number } }): boolean {
  const atCap = (util?: number) => Math.round((util ?? 0) * 100) >= 100;
  return atCap(u.session?.utilization) || atCap(u.weekly?.utilization);
}

/** A reset may be offered: a limit is reached and a credit is left to spend on it. */
export function canUseResetCredit(u: { session?: { utilization: number }; weekly?: { utilization: number }; resetCredits?: ResetCredits }): boolean {
  return usageLimitReached(u) && (u.resetCredits?.available ?? 0) > 0;
}

/** The extra fields of a `UsageInfo`, as the JSON column holds them — null when there are none. */
export function serializeUsageExtra(u: { weeklyScoped?: ScopedLimitBucket[]; resetCredits?: ResetCredits }): string | null {
  const extra: UsageExtra = {};
  if (u.weeklyScoped?.length) {
    extra.scoped = u.weeklyScoped.map((b) => ({ label: b.label, utilization: b.utilization, resetsAt: b.resetsAt }));
  }
  if (u.resetCredits) extra.resetCredits = u.resetCredits;
  return extra.scoped || extra.resetCredits ? JSON.stringify(extra) : null;
}

/** The JSON column back into `UsageInfo` fields. Malformed JSON reads as nothing, not a throw. */
export function deserializeUsageExtra(json: string | null | undefined): { weeklyScoped?: ScopedLimitBucket[]; resetCredits?: ResetCredits } {
  if (!json) return {};
  let extra: UsageExtra;
  try { extra = JSON.parse(json) as UsageExtra; } catch { return {}; }
  return {
    ...(extra.scoped?.length ? { weeklyScoped: extra.scoped.map(scopedBucket) } : {}),
    ...(extra.resetCredits ? { resetCredits: extra.resetCredits } : {}),
  };
}

/**
 * What counts as a change worth a new snapshot row.
 *
 * Reset timestamps are left out on purpose: Claude's carry microseconds that differ on every
 * call ("08:59:59.720048" then "09:00:00.363882"), so comparing them would write a row per
 * sweep. A utilization moving or a credit being granted/used is what matters.
 */
export function usageExtraSignature(json: string | null | undefined): string {
  const e = deserializeUsageExtra(json);
  const scoped = (e.weeklyScoped ?? []).map((b) => `${b.label}:${b.utilization.toFixed(3)}`).sort().join(",");
  const credits = e.resetCredits ? `${e.resetCredits.available}@${e.resetCredits.nextExpiresAt ?? ""}` : "";
  return `${scoped}|${credits}`;
}
