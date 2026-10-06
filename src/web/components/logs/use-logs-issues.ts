/**
 * What AI made of recent errors and warnings, kept fresh by `logs:issues-changed` — which the
 * server sends when a run starts and ends and when an issue is dismissed, from any device.
 */
import { useCallback, useEffect, useState } from "react";
import { LOGS_ISSUES_CHANGED, type LogIssuesResult } from "../../../shared/logs-api";
import { analyzeIssues, dismissIssue, fetchIssues, setIssuesAuto, undismissAllIssues } from "./logs-client";

export interface LogsIssues {
  data: LogIssuesResult | null;
  /** The last read failed. */
  error: string | null;
  analyze(full: boolean): Promise<void>;
  setAuto(on: boolean): Promise<void>;
  setDismissed(id: string, dismissed: boolean): Promise<void>;
  undismissAll(): Promise<void>;
}

export function useLogsIssues(): LogsIssues {
  const [data, setData] = useState<LogIssuesResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchIssues());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener(LOGS_ISSUES_CHANGED, onChanged);
    return () => window.removeEventListener(LOGS_ISSUES_CHANGED, onChanged);
  }, [load]);

  const analyze = useCallback(async (full: boolean) => {
    setData((d) => (d ? { ...d, running: true, error: null } : d));
    await analyzeIssues(full);
  }, []);

  const setAuto = useCallback(async (on: boolean) => {
    setData((d) => (d ? { ...d, auto: on } : d));
    await setIssuesAuto(on);
    await load();
  }, [load]);

  const setDismissed = useCallback(async (id: string, dismissed: boolean) => {
    setData((d) => (d ? { ...d, issues: d.issues.map((i) => (i.id === id ? { ...i, dismissed } : i)) } : d));
    await dismissIssue(id, dismissed);
  }, []);

  const undismissAll = useCallback(async () => {
    setData((d) => (d ? { ...d, issues: d.issues.map((i) => ({ ...i, dismissed: false })) } : d));
    await undismissAllIssues();
  }, []);

  return { data, error, analyze, setAuto, setDismissed, undismissAll };
}
