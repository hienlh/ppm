/**
 * Claude's free limit resets — the "Reset for free" claude.ai and Claude Code's `/limit-reset`
 * offer (Anthropic's `cedar_ember` program): parsed from the usage read, grouped and explained
 * the way Claude Code 2.1.322 does it, so the card, the confirmation and the server's refusal
 * all say the same thing.
 *
 * Anthropic lists the grants only to the apps it offers them in (`ineligible_reason: "surface"`
 * to anything else), which is why PPM's usage read and claim go out as Claude Code's CLI
 * (`claude-cli-identity.ts`).
 *
 * Pure and dependency-free so both the server and the browser can use it.
 */
import type { ClaudeLimitResetGrant, ClaudeLimitResets } from "../types/chat.ts";

export type ClaudeResetKind = ClaudeLimitResetGrant["kind"];

/** Anthropic's grant ids, as Claude Code checks them before claiming. */
export const CLAUDE_RESET_GRANT_ID = /^[a-z0-9_-]{1,40}$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** Claude Code's grouping: a grant that gives Fable's week back is a Fable reset whatever its type. */
function kindOf(g: Record<string, any>, clears: string[]): ClaudeResetKind {
  if (g.gives_back_weekly === true) return "fable";
  if (g.type === "session" || g.type === "weekly" || g.type === "full") return g.type;
  const fiveHour = clears.includes("five_hour");
  const other = clears.some((c) => c !== "five_hour");
  return fiveHour && !other ? "session" : other && !fiveHour ? "weekly" : "full";
}

/**
 * The `cedar_ember` block of a usage read → the account's resets.
 *
 * Undefined when there is nothing to offer: no block, not eligible, or no grant left. Kept
 * are the grants Claude Code would list — not paused, and either one left or usable now —
 * that have not lapsed.
 */
export function parseClaudeLimitResets(raw: unknown, now = Date.now()): ClaudeLimitResets | undefined {
  const block = (raw as { cedar_ember?: unknown })?.cedar_ember as Record<string, any> | null | undefined;
  if (!block || typeof block !== "object" || block.eligible !== true || !Array.isArray(block.grants)) return undefined;
  const grants: ClaudeLimitResetGrant[] = [];
  for (const g of block.grants as Array<Record<string, any>>) {
    if (!g || typeof g !== "object" || typeof g.id !== "string" || !CLAUDE_RESET_GRANT_ID.test(g.id)) continue;
    const endsAt = str(g.ends_at);
    if (endsAt && Date.parse(endsAt) <= now) continue;
    const clears = strList(g.clears);
    const grant: ClaudeLimitResetGrant = {
      id: g.id,
      label: str(g.label) ?? "Limit reset",
      kind: kindOf(g, clears),
      resetsLeft: count(g.resets_left),
      resetsTotal: count(g.resets_total),
      ...(endsAt ? { endsAt } : {}),
      clears,
      givesBackWeekly: g.gives_back_weekly === true,
      paused: g.paused === true,
      usableNow: g.usable_now === true,
      useRequiresLimit: g.use_requires_limit !== false,
      blocking: strList(g.blocking),
      percentUsed: Object.fromEntries(
        Object.entries(g.percent_used && typeof g.percent_used === "object" ? g.percent_used : {})
          .filter(([, v]) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100),
      ) as Record<string, number>,
      ...(str(g.unavailable_reason) ? { unavailableReason: g.unavailable_reason } : {}),
    };
    if (!grant.paused && (grant.resetsLeft > 0 || grant.usableNow)) grants.push(grant);
  }
  if (!grants.length) return undefined;
  grants.sort((a, b) => (a.endsAt ? Date.parse(a.endsAt) : Infinity) - (b.endsAt ? Date.parse(b.endsAt) : Infinity));
  return {
    grants,
    atLimit: block.at_limit === true,
    exhausted: strList(block.exhausted),
    ...(str(block.cooldown_until) ? { cooldownUntil: block.cooldown_until } : {}),
    ...(str(block.weekly_resets_at) ? { weeklyResetsAt: block.weekly_resets_at } : {}),
  };
}

/** How many resets the account holds in all. */
export function claudeResetsLeft(r: ClaudeLimitResets | undefined): number {
  return (r?.grants ?? []).reduce((n, g) => n + g.resetsLeft, 0);
}

const KIND_NAME: Record<ClaudeResetKind, string> = {
  session: "5-hour reset",
  fable: "Fable reset",
  full: "full reset",
  weekly: "weekly reset",
};
/** Display order, the most useful first. */
const KIND_ORDER: ClaudeResetKind[] = ["full", "fable", "session", "weekly"];

export const claudeResetKindName = (kind: ClaudeResetKind, capital = false): string =>
  capital ? KIND_NAME[kind][0]!.toUpperCase() + KIND_NAME[kind].slice(1) : KIND_NAME[kind];

const LIMIT_NAME: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "Opus weekly limit",
  seven_day_sonnet: "Sonnet weekly limit",
};

/** Whether a grant would refill the limit named — Fable's give-back counts for the week. */
const refills = (g: ClaudeLimitResetGrant, limit: string) =>
  g.clears.includes(limit) || (limit === "seven_day" && g.givesBackWeekly);

/** Why a grant cannot be used now, in Claude Code's words; null when it can. */
export function claudeResetBlockedReason(g: ClaudeLimitResetGrant, r: ClaudeLimitResets): string | null {
  if (g.usableNow && !g.paused && g.resetsLeft > 0 && !r.cooldownUntil) return null;
  if (g.paused) return "it is paused";
  if (g.resetsLeft === 0) return "none left";
  const reason = g.unavailableReason
    ?? (r.cooldownUntil ? "cooldown" : undefined)
    ?? g.blocking.map((b) => ({ five_hour: "blocked_five_hour", seven_day: "blocked_seven_day", seven_day_opus: "blocked_opus", seven_day_sonnet: "blocked_sonnet" })[b]).find(Boolean)
    ?? (g.blocking.length ? "blocked_other" : undefined)
    ?? (r.atLimit && !r.exhausted.some((e) => refills(g, e)) ? "cannot_clear" : undefined)
    ?? (g.useRequiresLimit ? "needs_limit" : "unavailable");
  switch (reason) {
    case "cooldown": return "a reset was just used, try again in a minute";
    case "blocked_five_hour": return `can't be used while you're at your ${LIMIT_NAME.five_hour}`;
    case "blocked_seven_day": return `can't be used while you're at your ${LIMIT_NAME.seven_day}`;
    case "blocked_opus": return `can't be used while you're at your ${LIMIT_NAME.seven_day_opus}`;
    case "blocked_sonnet": return `can't be used while you're at your ${LIMIT_NAME.seven_day_sonnet}`;
    case "blocked_other": return "can't be used while you're at another limit it doesn't refill";
    case "cannot_clear": return "doesn't refill the limit you've reached";
    case "needs_limit": return "usable once you reach a limit it refills";
    default: return "can't be used right now";
  }
}

/** "5-hour and weekly limits", "Fable and 5-hour limits" — what using the grant refills. */
export function claudeResetRefills(g: ClaudeLimitResetGrant): string {
  const names = new Set<string>();
  if (g.givesBackWeekly) names.add("Fable");
  for (const c of g.clears) {
    if (c === "five_hour") names.add("5-hour");
    else if (c === "seven_day") names.add("weekly");
    else if (c === "seven_day_overage_included") names.add(g.givesBackWeekly ? "Fable" : "weekly");
    else if (c === "seven_day_opus") names.add("Opus weekly");
    else if (c === "seven_day_sonnet") names.add("Sonnet weekly");
  }
  const list = [...names];
  const last = list.pop();
  if (!last) return "limits";
  return list.length ? `${list.join(", ")} and ${last} limits` : `${last} limit`;
}

/**
 * Used before any limit it refills is reached, a reset throws away what was left of them.
 * The confirmation says how much, as Claude Code does; null when a limit it refills is reached.
 */
export function claudeResetEarlyWarning(g: ClaudeLimitResetGrant, r: ClaudeLimitResets): string | null {
  if (r.exhausted.some((e) => refills(g, e))) return null;
  const kind = claudeResetKindName(g.kind);
  let most: { limit: string; used: number } | null = null;
  for (const limit of g.clears) {
    const used = g.percentUsed[limit];
    if (used !== undefined && (most === null || used > most.used)) most = { limit, used };
  }
  const name = most && LIMIT_NAME[most.limit];
  if (most && name && most.used < 100) return `You still have ${100 - most.used}% of your ${name} left. Use your ${kind} anyway?`;
  return `You haven't reached a limit yet. Use your ${kind} anyway?`;
}

export interface ClaudeResetGroup {
  kind: ClaudeResetKind;
  grants: ClaudeLimitResetGrant[];
  resetsLeft: number;
  /** The grant "Reset for free" spends: the first usable one, soonest to lapse. */
  target?: ClaudeLimitResetGrant;
  /** Why none can be used now, when there is no target. */
  blockedReason?: string;
}

/** Grants by kind, as the reset list shows them. */
export function claudeResetGroups(r: ClaudeLimitResets, now = Date.now()): ClaudeResetGroup[] {
  const groups = new Map<ClaudeResetKind, ClaudeResetGroup>();
  for (const g of r.grants) {
    const group = groups.get(g.kind) ?? { kind: g.kind, grants: [], resetsLeft: 0 };
    groups.set(g.kind, group);
    group.grants.push(g);
    group.resetsLeft += g.resetsLeft;
    const lapsed = g.endsAt ? Date.parse(g.endsAt) <= now : false;
    if (!group.target && !lapsed && claudeResetBlockedReason(g, r) === null) group.target = g;
  }
  for (const group of groups.values()) {
    if (!group.target) group.blockedReason = claudeResetBlockedReason(group.grants[0]!, r) ?? "can't be used right now";
  }
  return [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** What a claim answered, as `POST /reset_rate_limits` reports it plus the two transport failures. */
export type ClaudeResetResult =
  | "reset" | "already_used" | "not_limited" | "cooldown" | "ineligible" | "unavailable"
  | "rate_limited" | "auth_error" | "error";

/** The line shown after a claim. */
export function claudeResetResultMessage(
  account: string,
  result: ClaudeResetResult,
  opts: { kind?: ClaudeResetKind; reason?: string | null; resetsLeft?: number | null; weeklyResetsAt?: string | null } = {},
): string {
  const kind = opts.kind ? claudeResetKindName(opts.kind) : "reset";
  switch (result) {
    case "reset": {
      const done = opts.kind === "fable"
        ? "Fable reset used. What Fable used is back in your weekly limit"
        : opts.kind === "session" ? "5-hour limit reset" : opts.kind === "weekly" ? "Weekly limits reset" : "Limits reset";
      const week = opts.weeklyResetsAt
        ? ` Your weekly reset day stays ${new Date(opts.weeklyResetsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`
        : "";
      const left = typeof opts.resetsLeft === "number" ? ` ${opts.resetsLeft === 0 ? "No" : opts.resetsLeft} ${kind}${opts.resetsLeft === 1 ? "" : "s"} left.` : "";
      return `${account}: ${done}.${week}${left}`;
    }
    case "already_used": return `${account}: that ${kind} had already been used.`;
    case "not_limited": return `${account}: nothing needed resetting, so the ${kind} was kept.`;
    case "cooldown": return `${account}: a reset was used moments ago. Nothing was used; try again in a minute.`;
    case "ineligible": return `${account}: Anthropic no longer offers this account limit resets. Nothing was used.`;
    case "rate_limited": return `${account}: Anthropic is turning requests away for now. Nothing was used; try again in a minute.`;
    case "auth_error": return `${account}: Anthropic refused the account's sign-in. Nothing was used; sign in again and retry.`;
    case "unavailable":
      if (opts.reason === "reset_unconfirmed" || opts.reason === "stamp_indeterminate") {
        return `${account}: couldn't confirm the reset went through. If the limits are not refilled in a moment, try again.`;
      }
      return `${account}: couldn't reset the limits${opts.reason ? ` (${opts.reason.replace(/_/g, " ")})` : ""}. Nothing was used; try again in a moment.`;
    default: return `${account}: couldn't tell whether the reset went through. Check the limits in a moment before trying again.`;
  }
}
