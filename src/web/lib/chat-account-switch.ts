/**
 * The accounts the chat's ··· menu offers under "Switch account", in the order and grouping the
 * person reads them: the account serving this chat first, then the usable ones with the most
 * headroom, and every account that cannot take a turn folded away under "Out of usage" with the
 * reason it cannot.
 *
 * Pure, and the same for both providers: Claude's accounts and Codex's arrive in different
 * shapes and are refused for different reasons, so each is turned into a `SwitchAccount` by its
 * own function and everything after that is shared.
 */
import type { AccountInfo, AccountUsageEntry, OAuthProfileData } from "./api-settings";
import type { ClaudeLimitResets, LimitBucket, ResetCredits } from "../../types/chat";
import { bucketResetsAt } from "@/components/settings/accounts/account-usage-format";

export interface SwitchAccount {
  id: string;
  label: string;
  /** "Max", "Pro", "Plus"… when the provider says. */
  plan: string | null;
  fiveHourPct: number | null;
  weekPct: number | null;
  /** When each window resets (ISO), shown under its bar; null when the provider did not say. */
  fiveHourResetsAt: string | null;
  weekResetsAt: string | null;
  /** Why this account cannot take a turn now. Present means it is not selectable. */
  refusal: string | null;
  /** The login was refused: signing in again is the way back, and the row offers it. */
  signedOut: boolean;
  /** Free limit resets the account holds and when the nearest expires; 0 when it holds none. */
  resets?: { count: number; nextExpiresAt: string | null };
}

/** Earliest of these ISO times. */
function earliest(times: Array<string | null | undefined>): string | null {
  return times.filter((t): t is string => !!t).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

export function claudeResetsSummary(r: ClaudeLimitResets | undefined): { count: number; nextExpiresAt: string | null } {
  const grants = (r?.grants ?? []).filter((g) => g.resetsLeft > 0);
  return { count: grants.reduce((n, g) => n + g.resetsLeft, 0), nextExpiresAt: earliest(grants.map((g) => g.endsAt)) };
}

export function codexResetsSummary(c: ResetCredits | undefined): { count: number; nextExpiresAt: string | null } {
  if (!c?.available) return { count: 0, nextExpiresAt: null };
  return { count: c.available, nextExpiresAt: earliest([...(c.credits ?? []).map((x) => x.expiresAt), c.nextExpiresAt]) };
}

/** Whole percent of a 0–1 utilisation, the figure the bars and the ring show. */
export function percent(util: number | null | undefined): number | null {
  return util == null ? null : Math.round(util * 100);
}

/** Matches the whole-percent figure the bars show, so a refusal agrees with the bar. */
function atCap(util: number | null | undefined): boolean {
  return (percent(util) ?? 0) >= 100;
}

/**
 * Reached, not approaching: the router steers away from 95% to spread load early, but an account
 * at 96% still answers. At 100% the next turn fails outright, which is where saying no is true.
 * When it comes back is said under the full bar, so the refusal names only the window.
 */
function limitRefusal(session?: LimitBucket, weekly?: LimitBucket): string | null {
  if (atCap(session?.utilization)) return "5-hour limit reached";
  if (atCap(weekly?.utilization)) return "Weekly limit reached";
  return null;
}

export function claudePlanLabel(profile: OAuthProfileData | null | undefined): string | null {
  if (profile?.account?.has_claude_max) return "Max";
  if (profile?.account?.has_claude_pro) return "Pro";
  return null;
}

/** A Claude account, refused for the reasons the server itself refuses one. */
export function claudeSwitchAccount(entry: AccountUsageEntry, info?: AccountInfo): SwitchAccount {
  let refusal: string | null = null;
  let signedOut = false;
  const status = info?.status ?? entry.accountStatus;
  if (status === "disabled") refusal = "Disabled";
  else if (info?.reauthRequired) { refusal = "Signed out · sign in again"; signedOut = true; }
  else if (info && !info.hasRefreshToken && info.expiresAt && info.expiresAt < Math.floor(Date.now() / 1000)) {
    refusal = "Token expired · sign in again";
    signedOut = true;
  }
  refusal ??= limitRefusal(entry.usage.session, entry.usage.weekly);
  return {
    id: entry.accountId,
    label: entry.accountLabel ?? info?.label ?? info?.email ?? entry.accountId.slice(0, 8),
    plan: claudePlanLabel(info?.profileData),
    fiveHourPct: percent(entry.usage.session?.utilization),
    weekPct: percent(entry.usage.weekly?.utilization),
    fiveHourResetsAt: bucketResetsAt(entry.usage.session),
    weekResetsAt: bucketResetsAt(entry.usage.weekly),
    refusal,
    signedOut,
    resets: claudeResetsSummary(entry.usage.limitResets),
  };
}

export interface CodexAccountLike {
  id: string;
  label: string;
  type: string;
  status?: "active" | "disabled";
  signedOut?: boolean;
}
export interface CodexUsageLike {
  fiveHour?: number;
  sevenDay?: number;
  session?: LimitBucket;
  weekly?: LimitBucket;
  resetCredits?: ResetCredits;
}

/** A Codex account. A plan may have only one of the two windows, and whichever it has refuses. */
export function codexSwitchAccount(account: CodexAccountLike, usage: CodexUsageLike, plan: string | null): SwitchAccount {
  let refusal: string | null = null;
  let signedOut = false;
  if (account.status === "disabled") refusal = "Disabled";
  else if (account.signedOut) { refusal = "Signed out · sign in again"; signedOut = account.type === "chatgpt"; }
  refusal ??= limitRefusal(
    usage.session ?? (usage.fiveHour != null ? { utilization: usage.fiveHour } as LimitBucket : undefined),
    usage.weekly ?? (usage.sevenDay != null ? { utilization: usage.sevenDay } as LimitBucket : undefined),
  );
  return {
    id: account.id,
    label: account.label,
    plan,
    fiveHourPct: percent(usage.session?.utilization ?? usage.fiveHour),
    weekPct: percent(usage.weekly?.utilization ?? usage.sevenDay),
    fiveHourResetsAt: bucketResetsAt(usage.session),
    weekResetsAt: bucketResetsAt(usage.weekly),
    refusal,
    signedOut,
    resets: codexResetsSummary(usage.resetCredits),
  };
}

/** The window closest to its cap — what the ring shows and what headroom is measured against. */
export function highestPct(a: Pick<SwitchAccount, "fiveHourPct" | "weekPct">): number | null {
  if (a.fiveHourPct == null && a.weekPct == null) return null;
  return Math.max(a.fiveHourPct ?? 0, a.weekPct ?? 0);
}

/**
 * Current first, then usable accounts by most headroom, then the refused ones folded away.
 * The current account leads even when it is out of usage: it is the answer to "which one is
 * this chat on", and the person looks for it first.
 */
export function orderSwitchAccounts(accounts: readonly SwitchAccount[], currentId: string | null): {
  usable: SwitchAccount[];
  outOfUsage: SwitchAccount[];
} {
  const current = accounts.find((a) => a.id === currentId);
  const rest = accounts.filter((a) => a !== current);
  const usable = rest
    .filter((a) => !a.refusal)
    .sort((a, b) => (highestPct(a) ?? 0) - (highestPct(b) ?? 0) || a.label.localeCompare(b.label));
  return {
    usable: current ? [current, ...usable] : usable,
    outOfUsage: rest.filter((a) => a.refusal),
  };
}

/** Case-insensitive search by name or plan. */
export function matchesAccountQuery(a: SwitchAccount, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || a.label.toLowerCase().includes(q) || (a.plan ?? "").toLowerCase().includes(q);
}

/** Colour band of a usage figure: quiet below 70%, a warning to 90%, an error above. */
export function usageTone(pct: number | null): "ok" | "warn" | "error" {
  if (pct == null || pct < 70) return "ok";
  return pct >= 90 ? "error" : "warn";
}
