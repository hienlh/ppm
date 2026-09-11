import type { UsageInfo, LimitBucket } from "../../types/chat.ts";
import {
  insertLimitSnapshot,
  getLatestLimitSnapshot,
  getLatestSnapshotForAccount,
  touchSnapshotTimestamp,
  cleanupOldLimitSnapshots,
  type LimitSnapshotRow,
} from "../db.service.ts";
import { AMBIENT_ACCOUNT_KEY } from "./usage-source.ts";

/**
 * The durable half of the usage layer: turning a provider's `UsageInfo` into a
 * snapshot row and back, for any provider.
 *
 * Persistence is what lets the toolbar show a number the moment the server comes
 * back up, before the first background sweep has finished. Without it a restart
 * blanks every percentage for as long as the first fetch takes.
 *
 * A row is only written when something actually moved. Otherwise the newest row
 * has its timestamp touched, so "last fetched" stays honest without growing a
 * row per account per sweep forever.
 */

/** Recompute a bucket's countdown against the current clock. */
function toBucket(util: number, resetsAt: string, windowHours: number): LimitBucket {
  const diff = resetsAt ? new Date(resetsAt).getTime() - Date.now() : 0;
  const totalMins = diff > 0 ? Math.ceil(diff / 60_000) : 0;
  return {
    utilization: util,
    resetsAt,
    resetsInMinutes: windowHours <= 5 ? totalMins : null,
    resetsInHours: windowHours > 5 ? Math.round((totalMins / 60) * 100) / 100 : null,
    windowHours,
  };
}

/** Snapshot row → UsageInfo, with the flat mirror fields the chat toolbar reads. */
export function snapshotToUsage(row: LimitSnapshotRow): UsageInfo & { lastFetchedAt?: string } {
  // SQLite's datetime('now') is UTC but carries no Z, which JS would read as local time.
  const iso = row.recorded_at.endsWith("Z")
    ? row.recorded_at
    : row.recorded_at.replace(" ", "T") + "Z";
  const usage: UsageInfo & { lastFetchedAt?: string } = { lastFetchedAt: iso };
  if (row.five_hour_util != null) {
    usage.session = toBucket(row.five_hour_util, row.five_hour_resets_at ?? "", 5);
    usage.fiveHour = row.five_hour_util;
    if (row.five_hour_resets_at) usage.fiveHourResetsAt = row.five_hour_resets_at;
  }
  if (row.weekly_util != null) {
    usage.weekly = toBucket(row.weekly_util, row.weekly_resets_at ?? "", 168);
    usage.sevenDay = row.weekly_util;
    if (row.weekly_resets_at) usage.sevenDayResetsAt = row.weekly_resets_at;
  }
  if (row.weekly_opus_util != null) {
    usage.weeklyOpus = toBucket(row.weekly_opus_util, row.weekly_opus_resets_at ?? "", 168);
  }
  if (row.weekly_sonnet_util != null) {
    usage.weeklySonnet = toBucket(row.weekly_sonnet_util, row.weekly_sonnet_resets_at ?? "", 168);
  }
  return usage;
}

/** Read the newest stored snapshot for one provider account, or undefined. */
export function readStoredUsage(
  providerId: string,
  accountId: string,
): (UsageInfo & { lastFetchedAt?: string }) | undefined {
  const row = accountId === AMBIENT_ACCOUNT_KEY
    ? getLatestLimitSnapshot(providerId)
    : getLatestSnapshotForAccount(accountId, providerId);
  return row ? snapshotToUsage(row) : undefined;
}

/**
 * True when any stored bucket differs from the freshly fetched one.
 *
 * Utilizations compare with a tolerance rather than exactly: they are floats
 * that round-trip through SQLite, and treating a last-digit wobble as a change
 * would write a row on every single sweep.
 */
function hasChanged(usage: UsageInfo, last: LimitSnapshotRow | null): boolean {
  if (!last) return true;
  const moved = (fresh: number | null | undefined, stored: number | null) =>
    fresh != null && (stored == null || Math.abs(fresh - stored) > 0.001);
  if (moved(usage.session?.utilization, last.five_hour_util)) return true;
  if (moved(usage.weekly?.utilization, last.weekly_util)) return true;
  if (moved(usage.weeklyOpus?.utilization, last.weekly_opus_util)) return true;
  if (moved(usage.weeklySonnet?.utilization, last.weekly_sonnet_util)) return true;
  if (usage.session?.resetsAt && usage.session.resetsAt !== (last.five_hour_resets_at ?? "")) return true;
  if (usage.weekly?.resetsAt && usage.weekly.resetsAt !== (last.weekly_resets_at ?? "")) return true;
  return false;
}

/**
 * Persist a freshly fetched value, writing a row only when a bucket moved.
 *
 * An account with nothing to report (every bucket absent) is not written at all:
 * a row of nulls is indistinguishable from "never fetched" on read, so storing
 * one buys nothing and only makes the history noisier.
 */
export function writeStoredUsage(providerId: string, accountId: string, usage: UsageInfo): void {
  const hasAnyBucket = usage.session != null || usage.weekly != null
    || usage.weeklyOpus != null || usage.weeklySonnet != null;
  if (!hasAnyBucket) return;

  const id = accountId === AMBIENT_ACCOUNT_KEY ? null : accountId;
  const last = id ? getLatestSnapshotForAccount(id, providerId) : getLatestLimitSnapshot(providerId);
  if (!hasChanged(usage, last)) {
    if (id) touchSnapshotTimestamp(id, providerId);
    return;
  }
  insertLimitSnapshot({
    provider: providerId,
    account_id: id,
    five_hour_util: usage.session?.utilization ?? null,
    five_hour_resets_at: usage.session?.resetsAt ?? null,
    weekly_util: usage.weekly?.utilization ?? null,
    weekly_resets_at: usage.weekly?.resetsAt ?? null,
    weekly_opus_util: usage.weeklyOpus?.utilization ?? null,
    weekly_opus_resets_at: usage.weeklyOpus?.resetsAt ?? null,
    weekly_sonnet_util: usage.weeklySonnet?.utilization ?? null,
    weekly_sonnet_resets_at: usage.weeklySonnet?.resetsAt ?? null,
  });
  cleanupOldLimitSnapshots();
}
