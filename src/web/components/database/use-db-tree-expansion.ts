import { useMemo, useCallback } from "react";
import { useSettingsStore, type DbSidebarExpanded } from "@/stores/settings-store";

/** Table nodes are keyed `${connId}:${schema}.${table}`. */
export function tableKey(connId: number, schemaName: string, tableName: string): string {
  return `${connId}:${schemaName}.${tableName}`;
}

function connIdOfTableKey(key: string): number {
  return Number(key.slice(0, key.indexOf(":")));
}

/**
 * Expansion state of the Database sidebar tree, backed by the server-synced
 * `dbSidebarExpanded` UI pref so it survives reloads, sidebar tab switches,
 * and origin changes (new tunnel URL).
 */
export function useDbTreeExpansion() {
  const expanded = useSettingsStore((s) => s.dbSidebarExpanded);
  const setExpanded = useSettingsStore((s) => s.setDbSidebarExpanded);

  const expandedConns = useMemo(() => new Set(expanded.conns), [expanded.conns]);
  const expandedGroups = useMemo(() => new Set(expanded.groups), [expanded.groups]);
  const expandedTables = useMemo(() => new Set(expanded.tables), [expanded.tables]);

  // Read through getState() so rapid successive toggles never write a stale set.
  const update = useCallback(
    (fn: (current: DbSidebarExpanded) => DbSidebarExpanded) => {
      const current = useSettingsStore.getState().dbSidebarExpanded;
      const next = fn(current);
      // Returning `current` means "no change" — skipping the write keeps effects
      // that call this (pruning) from re-triggering themselves via a new identity.
      if (next === current) return;
      setExpanded(next);
    },
    [setExpanded],
  );

  const toggleConn = useCallback((id: number) => {
    update((cur) => ({
      ...cur,
      conns: cur.conns.includes(id) ? cur.conns.filter((c) => c !== id) : [...cur.conns, id],
    }));
  }, [update]);

  const toggleGroup = useCallback((group: string) => {
    update((cur) => ({
      ...cur,
      groups: cur.groups.includes(group) ? cur.groups.filter((g) => g !== group) : [...cur.groups, group],
    }));
  }, [update]);

  const setTableExpanded = useCallback((key: string, isExpanded: boolean) => {
    update((cur) => ({
      ...cur,
      tables: isExpanded
        ? (cur.tables.includes(key) ? cur.tables : [...cur.tables, key])
        : cur.tables.filter((t) => t !== key),
    }));
  }, [update]);

  /** Drop entries for connections that no longer exist so the pref cannot grow forever. */
  const pruneDeletedConns = useCallback((existingIds: number[]) => {
    const alive = new Set(existingIds);
    update((cur) => {
      const conns = cur.conns.filter((id) => alive.has(id));
      const tables = cur.tables.filter((k) => alive.has(connIdOfTableKey(k)));
      if (conns.length === cur.conns.length && tables.length === cur.tables.length) return cur;
      return { ...cur, conns, tables };
    });
  }, [update]);

  return { expandedConns, expandedGroups, expandedTables, toggleConn, toggleGroup, setTableExpanded, pruneDeletedConns };
}
