/**
 * Loads the three things the accounts pane needs — usages, account records, and which
 * account is active — and tracks which accounts' numbers just changed.
 *
 * Each result is applied the moment it lands, on its own: one endpoint failing (usage often
 * does, it depends on an upstream API) must not blank the whole pane, and one that is slow must
 * not hold back the two that answered.
 *
 * The last answer is kept for the next mount. The chat's usage panel is mounted afresh on every
 * open, so without it the panel opened on "Loading..." every time — and stayed there for as long
 * as the server took, which while the server was stalled meant most of a minute.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAccounts, getActiveAccount, getAllAccountUsages, patchAccount,
  type AccountInfo, type AccountUsageEntry,
} from "../../../lib/api-settings";
import { useSettingsChanged } from "@/hooks/use-settings-changed";

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

/** What the last load answered, shown straight away by the next component to mount. */
const lastLoaded: { usages: AccountUsageEntry[] | null; accounts: AccountInfo[]; activeAccountId: string | null } = {
  usages: null, accounts: [], activeAccountId: null,
};

/**
 * How long a load shows itself as loading. A request still out after this is not abandoned —
 * it lands when it lands — but the panel stops claiming to load and shows what it has.
 */
const LOAD_WAIT_MS = 10_000;

/** Utilisation across all four buckets, as a comparable string. */
function utilisationKey(entry: AccountUsageEntry): string {
  const u = entry.usage;
  return [
    u.session?.utilization, u.weekly?.utilization, u.weeklyOpus?.utilization, u.weeklySonnet?.utilization,
    ...(u.weeklyScoped ?? []).map((b) => `${b.label}:${b.utilization}`),
  ].join("|");
}

export function useAccountsData(enabled = true): AccountsData {
  const [usages, setUsages] = useState<AccountUsageEntry[]>(() => lastLoaded.usages ?? []);
  const [accounts, setAccounts] = useState<AccountInfo[]>(() => lastLoaded.accounts);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() => lastLoaded.activeAccountId);
  const [initialLoading, setInitialLoading] = useState(() => lastLoaded.usages === null);
  const [refreshing, setRefreshing] = useState(false);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const prevUsages = useRef<AccountUsageEntry[]>(lastLoaded.usages ?? []);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(async () => {
    const isRefresh = prevUsages.current.length > 0;
    if (isRefresh) setRefreshing(true);
    else setInitialLoading(true);

    const applyUsages = (next: AccountUsageEntry[]) => {
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
      lastLoaded.usages = next;
      setUsages(next);
    };

    const landed = Promise.all([
      getAllAccountUsages().then(applyUsages),
      getAccounts().then((a) => { lastLoaded.accounts = a; setAccounts(a); }),
      getActiveAccount().then((active) => {
        lastLoaded.activeAccountId = active?.id ?? null;
        setActiveAccountId(lastLoaded.activeAccountId);
      }),
    ].map((p) => p.catch(() => {})));
    let waited: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([landed, new Promise<void>((done) => { waited = setTimeout(done, LOAD_WAIT_MS); })]);
    clearTimeout(waited);

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
  // An account renamed, switched, re-checked or removed elsewhere (`ppm accounts`, another device).
  useSettingsChanged("accounts", () => { if (enabled) void reload(); });

  return { usages, accounts, activeAccountId, initialLoading, refreshing, flashIds, reload, toggle, togglingId };
}
