/**
 * Recognising a Codex usage-limit refusal.
 *
 * Codex reports an exhausted quota as an ordinary `error` notification — the same shape it
 * uses for a malformed request or a dead sandbox — so the wording is the only thing that
 * separates "this account is out of credit until 4:21 PM" from a failure that switching
 * accounts cannot fix. Matching text is therefore load-bearing here rather than cosmetic:
 * it decides whether the turn moves to another account or stops in front of the user.
 *
 * The patterns are deliberately narrow. A false positive parks a working account for
 * hours, so a match needs the phrase Codex actually uses and not the bare word "limit",
 * which also shows up in context-window and file-size errors.
 */

const USAGE_LIMIT_PATTERNS = [
  /hit\s+your\s+(?:usage|rate)\s+limit/i,
  /reached\s+your\s+usage\s+limit/i,
  /usage\s+limit\s+reached/i,
];

/** Whether this error text means the account's quota is spent. */
export function isCodexUsageLimit(message: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(message));
}

/** The message carried by a codex `error` notification, whatever shape it arrived in. */
export function codexErrorMessage(params: unknown): string {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const err = (p.error && typeof p.error === "object" ? p.error : {}) as Record<string, unknown>;
  if (typeof err.message === "string") return err.message;
  if (typeof p.message === "string") return p.message;
  return "";
}

/** Turn an hour/minute into the next epoch-ms at which the clock next reads that time. */
function nextOccurrence(hour: number, minute: number, ampm?: string): number | undefined {
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return undefined;
  let h = hour;
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  const now = new Date();
  const reset = new Date(now);
  reset.setHours(h, minute, 0, 0);
  // Already past today, so the refusal must be pointing at tomorrow.
  if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}

/**
 * When the refused account is worth trying again, read out of the refusal itself.
 *
 * Codex phrases it two ways — an absolute "try again at 4:21 PM" and a relative "try again
 * in 3 hours" — and both are parsed because the caller uses the answer to decide how long
 * to park the account. Returns null when the message says nothing about a reset, which the
 * caller treats as "park for the default window" rather than "do not park".
 */
export function parseCodexUsageLimitReset(message: string): { text?: string; atMs?: number } | null {
  const relative = /try\s+again\s+in\s+(\d+)\s*(second|minute|hour|day)s?/i.exec(message);
  if (relative) {
    const n = Number(relative[1]);
    const unitMs = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[relative[2]!.toLowerCase()]!;
    return { text: `in ${n} ${relative[2]!.toLowerCase()}${n === 1 ? "" : "s"}`, atMs: Date.now() + n * unitMs };
  }
  const absolute = /(?:try\s+again|resets?)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (!absolute) return null;
  const text = absolute[0].replace(/^(?:try\s+again|resets?)\s+(?:at\s+)?/i, "").trim();
  const atMs = nextOccurrence(Number(absolute[1]), absolute[2] ? Number(absolute[2]) : 0, absolute[3]?.toLowerCase());
  return { text: text || undefined, ...(atMs != null ? { atMs } : {}) };
}
