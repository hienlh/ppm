/**
 * State and requests for the Codex accounts pane.
 *
 * Split from the pane the way `use-accounts-data` is on the Claude side, so both panes are
 * render-only and the two providers stay comparable.
 *
 * The device-code login is the reason the cleanup here matters: it holds a server-side
 * app-server until it resolves, so leaving the pane has to release it rather than let it age
 * out. That cleanup belongs to the pane's lifetime, not to a dialog being closed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getAuthToken } from "@/lib/api-client";
import type { LimitBucket } from "../../../../types/chat";
import type { CodexStrategy } from "./codex-rotation-dialog";

export type Strategy = CodexStrategy;
export interface CodexAccount { id: string; label: string; type: string; planType?: string | null }
/**
 * One account's quota. The two percentages are what the bars read; the buckets carry the
 * reset clock the server already sends, so the Codex card can show "resets in" the way the
 * Claude card does.
 */
export interface Usage {
  fiveHour?: number;
  sevenDay?: number;
  session?: LimitBucket;
  weekly?: LimitBucket;
}
interface DevicePending { id: string; userCode: string; verificationUrl: string }
type DeviceStatus = { state: "pending" } | { state: "done" } | { state: "error"; error: string };

/** Gap between status polls. Each poll answers immediately, so a request lost to
 * a flaky proxy costs one tick instead of the whole login. */
const DEVICE_POLL_MS = 2000;
/** Give up a little after the server's own reap window so its message wins. */
const DEVICE_POLL_DEADLINE_MS = 210_000;

export function useCodexAccounts(onDone: () => void) {
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [strategy, setStrategy] = useState<Strategy>("round-robin");
  const [usages, setUsages] = useState<Record<string, Usage>>({});
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [device, setDevice] = useState<DevicePending | null>(null);
  const [deviceWaiting, setDeviceWaiting] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const stopPollRef = useRef<(() => void) | null>(null);
  /** Id of the login still owed a result, so unmount can release it. */
  const devicePendingIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ accounts: CodexAccount[]; strategy: Strategy }>("/api/codex-accounts");
      setAccounts(d.accounts);
      setStrategy(d.strategy);
      api.get<Record<string, Usage>>("/api/codex-accounts/usage").then(setUsages).catch(() => {});
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const addApiKey = async () => {
    if (!apiKey.trim()) return;
    setAdding(true); setErr(null);
    try {
      await api.post("/api/codex-accounts/api-key", { apiKey: apiKey.trim(), label: label.trim() || undefined });
      setApiKey(""); setLabel(""); onDone(); await load();
    } catch (e) { setErr((e as Error).message); } finally { setAdding(false); }
  };

  const pollDevice = useCallback((id: string) => {
    const deadline = Date.now() + DEVICE_POLL_DEADLINE_MS;
    let stopped = false;
    stopPollRef.current = () => { stopped = true; };
    const finish = (message?: string) => {
      stopped = true; stopPollRef.current = null; devicePendingIdRef.current = null;
      if (message) setErr(message);
      setDevice(null); setDeviceWaiting(false);
    };
    const tick = async () => {
      if (stopped) return;
      let s: DeviceStatus | null = null;
      // A failed poll is not a failed login — the outcome is held server-side,
      // so keep asking until the deadline instead of aborting the flow.
      try { s = await api.get<DeviceStatus>(`/api/codex-accounts/device-login/${id}/status`); } catch { /* retry */ }
      if (stopped) return;
      if (s?.state === "done") { finish(); setLabel(""); onDone(); await load(); return; }
      if (s?.state === "error") { finish(s.error); return; }
      if (Date.now() > deadline) { finish("Device login timed out."); return; }
      setTimeout(tick, DEVICE_POLL_MS);
    };
    void tick();
  }, [load]);

  // Abandoning the panel mid-login stops the polling and releases the
  // server-side app-server instead of leaving it to age out.
  useEffect(() => () => {
    stopPollRef.current?.();
    const id = devicePendingIdRef.current;
    if (id) api.del(`/api/codex-accounts/device-login/${id}`).catch(() => {});
  }, []);

  const startDevice = async () => {
    setErr(null);
    try {
      const d = await api.post<DevicePending>("/api/codex-accounts/device-login", { label: label.trim() || undefined });
      setDevice(d); setDeviceWaiting(true); devicePendingIdRef.current = d.id;
      pollDevice(d.id);
    } catch (e) { setErr((e as Error).message); }
  };

  const remove = async (id: string) => { await api.del(`/api/codex-accounts/${id}`); await load(); };
  const changeStrategy = async (s: Strategy) => { setStrategy(s); try { await api.put("/api/codex-accounts/strategy", { strategy: s }); } catch { /* revert on reload */ } };

  const doExport = async () => {
    if (!backupPassword.trim()) { setErr("Set a backup password first."); return; }
    setExporting(true); setErr(null); setMsg(null);
    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/codex-accounts/export", { method: "POST", headers, body: JSON.stringify({ password: backupPassword }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})) as { error?: string }; throw new Error(j.error ?? `Export failed: ${res.status}`); }
      const text = await res.text();
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "ppm-codex-accounts-backup.json";
      a.click();
      URL.revokeObjectURL(a.href);
      setMsg("Backup downloaded.");
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setExporting(false); }
  };

  const doImport = async (file: File) => {
    if (!backupPassword.trim()) { setErr("Enter the backup password first."); return; }
    setImporting(true); setErr(null); setMsg(null);
    try {
      const data = await file.text();
      const r = await api.post<{ imported: number; skipped: number }>("/api/codex-accounts/import", { data, password: backupPassword });
      setMsg(`Imported ${r.imported}${r.skipped ? `, skipped ${r.skipped}` : ""}.`);
      onDone();
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setImporting(false); }
  };


  return {
    accounts, strategy, usages, loading, apiKey, setApiKey, label, setLabel, adding,
    err, setErr, device, deviceWaiting, backupPassword, setBackupPassword,
    exporting, importing, msg, setMsg,
    load, addApiKey, startDevice, remove, changeStrategy, doExport, doImport,
  };
}
