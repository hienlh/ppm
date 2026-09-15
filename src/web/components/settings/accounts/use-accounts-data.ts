/**
 * Loads the three things the accounts pane needs — usages, account records, and which
 * account is active — and tracks which accounts' numbers just changed.
 *
 * `Promise.allSettled`, not `all`: one endpoint failing (usage often does, it depends on an
 * upstream API) must not blank the whole pane. Each result is applied on its own.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAccounts, getActiveAccount, getAllAccountUsages, patchAccount,
  type AccountInfo, type AccountUsageEntry,
} from "../../../lib/api-settings";

export interface AccountsData {
  usages: AccountUsageEntry[];
  accounts: AccountInfo[];
  activeAccountId: string | null;
  /** True only for the very first load, so a refresh does not blank the list. */
  initialLoading: boolean;
  refreshing: boolean;
  /** Accounts whose utilisation changed on the last refresh — briefly highlighted. */
  flashIds: Set<string>;
  reload: () => Promise<void>;
  /** Switch an account on or off, reloading when it lands. Resolves to an error message, or null. */
  toggle: (id: string, status: string) => Promise<string | null>;
  /** Account whose switch is mid-flight, or null. */
  togglingId: string | null;
}

/** Utilisation across all four buckets, as a comparable string. */
function utilisationKey(entry: AccountUsageEntry): string {
  const u = entry.usage;
  return [u.session?.utilization, u.weekly?.utilization, u.weeklyOpus?.utilization, u.weeklySonnet?.utilization].join("|");
}

export function useAccountsData(enabled = true): AccountsData {
  const [usages, setUsages] = useState<AccountUsageEntry[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const prevUsages = useRef<AccountUsageEntry[]>([]);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(async () => {
    const isRefresh = prevUsages.current.length > 0;
    if (isRefresh) setRefreshing(true);
    else setInitialLoading(true);

    const [u, a, active] = await Promise.allSettled([
      getAllAccountUsages(), getAccounts(), getActiveAccount(),
    ]);

    if (u.status === "fulfilled") {
      const next = u.value;
      if (isRefresh) {
        const before = new Map(prevUsages.current.map((e) => [e.accountId, utilisationKey(e)]));
        const changed = new Set(
          next.filter((e) => before.get(e.accountId) !== utilisationKey(e)).map((e) => e.accountId),
        );
        if (changed.size > 0) {
          setFlashIds(changed);
          clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlashIds(new Set()), 1500);
        }
      }
      prevUsages.current = next;
      setUsages(next);
    }
    if (a.status === "fulfilled") setAccounts(a.value);
    if (active.status === "fulfilled") setActiveAccountId(active.value?.id ?? null);

    setInitialLoading(false);
    setRefreshing(false);
  }, []);

  /**
   * Switch an account on or off.
   *
   * Lives here rather than in either pane so Settings and the chat toolbar drive one
   * implementation. Two of them is how those screens drifted apart before, and the drift is
   * invisible until someone notices the same switch behaving differently in two places.
   *
   * Returns the server's message instead of throwing: enabling a parked account makes the
   * server prove its token first, which can take most of a minute and can come back 400 with
   * a message worth reading — "sign in again" and "could not reach Anthropic" call for
   * different actions, and swallowing the difference leaves the switch silently snapping back.
   */
  const toggle = useCallback(async (id: string, status: string): Promise<string | null> => {
    setTogglingId(id);
    let error: string | null = null;
    try {
      await patchAccount(id, { status: status === "disabled" ? "active" : "disabled" });
    } catch (e) {
      error = (e as Error).message;
    }
    setTogglingId(null);
    await reload();
    return error;
  }, [reload]);

  useEffect(() => {
    if (enabled) void reload();
    return () => clearTimeout(flashTimer.current);
  }, [enabled, reload]);

  return { usages, accounts, activeAccountId, initialLoading, refreshing, flashIds, reload, toggle, togglingId };
}
