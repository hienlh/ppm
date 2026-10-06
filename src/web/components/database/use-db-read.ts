/**
 * One read a database tab shows — a table's structure, an object's SQL — from its target's routes.
 * It is read again when the tab is shown after another one was, which is how DBGate keeps these
 * tabs current after the table was changed somewhere else; right away when a structure change is
 * saved on its connection while the tab is in view; and once a missing driver is installed. Only
 * the latest read lands.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { missingDbDriverOf, type MissingDbDriver } from "@/lib/db-drivers";
import { useDbDriverInstalled } from "@/hooks/use-db-driver-installed";
import { targetUrl, type DbTarget } from "@/lib/db-tabs";
import { usePanelStore } from "@/stores/panel-store";
import { useDbExplorer } from "./explorer/db-explorer-store";

export interface DbRead<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  driver: MissingDbDriver | null;
}

export function useDbRead<T>(target: DbTarget | null, path: string | null, tabId: string | undefined): DbRead<T> & { reload: () => Promise<void> } {
  const url = target && path ? targetUrl(target, path) : null;
  const [state, setState] = useState<DbRead<T>>({ data: null, error: null, loading: url !== null, driver: null });
  const seq = useRef(0);
  /** Reloads waiting for the latest read to land, which is never older than the one each asked for. */
  const waiting = useRef<(() => void)[]>([]);

  const read = useCallback(async () => {
    if (!url) {
      for (const resolve of waiting.current.splice(0)) resolve();
      return;
    }
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    let next: DbRead<T>;
    try {
      next = { data: await api.get<T>(url), error: null, loading: false, driver: null };
    } catch (e) {
      next = { data: null, error: (e as Error).message, loading: false, driver: missingDbDriverOf(e) };
    }
    if (n !== seq.current) return;
    setState(next);
    for (const resolve of waiting.current.splice(0)) resolve();
  }, [url]);

  /**
   * Resolves once what it asked for is on screen — which may be a later read's answer, when another
   * read started meanwhile and this one's was dropped. The table editor waits for it before it lets
   * go of a saved change, so the table never shows as it was before the save.
   */
  const reload = useCallback(() => new Promise<void>((resolve) => {
    waiting.current.push(resolve);
    void read();
  }), [read]);

  useEffect(() => { void read(); }, [read]);

  const { active, shown } = useShownAgain(tabId);
  useEffect(() => { if (shown > 0) void read(); }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tab out of view reads again when it is shown, above.
  const connectionId = target?.kind === "connection" ? target.connectionId : null;
  const changes = useDbExplorer((s) => (connectionId === null ? 0 : s.structureChanges[connectionId] ?? 0));
  const seenChanges = useRef(changes);
  useEffect(() => {
    if (changes === seenChanges.current) return;
    seenChanges.current = changes;
    if (active) void read();
  }, [changes]); // eslint-disable-line react-hooks/exhaustive-deps

  useDbDriverInstalled((driverId) => { if (state.driver?.id === driverId) void read(); });

  return { ...state, reload };
}

/** Whether the tab is the one its panel shows, and the times it became that after another was; 0 until then. */
function useShownAgain(tabId: string | undefined): { active: boolean; shown: number } {
  const active = usePanelStore((s) => !!tabId && Object.values(s.panels).some((p) => p.activeTabId === tabId));
  const [count, setCount] = useState(0);
  const was = useRef(active);
  useEffect(() => {
    if (active && !was.current) setCount((c) => c + 1);
    was.current = active;
  }, [active]);
  return { active, shown: count };
}
