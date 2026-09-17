/** State and requests for the Codex accounts pane, including cancellable login flows. */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getAuthToken } from "@/lib/api-client";
import type { LimitBucket } from "../../../../types/chat";
import type { CodexStrategy } from "./codex-rotation-dialog";

export type Strategy = CodexStrategy;
export interface CodexAccount { id: string; label: string; type: string; planType?: string | null; status?: "active" | "disabled"; dailyGuardEnabled?: boolean }
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
interface BrowserPending { id: string; authUrl: string }
type LoginMethod = "device" | "browser";
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
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [device, setDevice] = useState<DevicePending | null>(null);
  const [deviceWaiting, setDeviceWaiting] = useState(false);
  const [browser, setBrowser] = useState<BrowserPending | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submittingCallback, setSubmittingCallback] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const stopPollRef = useRef<(() => void) | null>(null);
  /** Id of the login still owed a result, so unmount can release it. */
  const pendingLoginRef = useRef<{ id: string; method: LoginMethod } | null>(null);
  const loginGenerationRef = useRef(0);
  const startingRef = useRef(false);
  const addingRef = useRef(false);
  const submittingRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

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
    if (!apiKey.trim() || addingRef.current || startingRef.current || pendingLoginRef.current) return;
    addingRef.current = true;
    setAdding(true); setErr(null);
    try {
      await api.post("/api/codex-accounts/api-key", { apiKey: apiKey.trim(), label: label.trim() || undefined });
      setApiKey(""); setLabel(""); onDone(); await load();
    } catch (e) { setErr((e as Error).message); } finally { addingRef.current = false; setAdding(false); }
  };

  const releaseLogin = useCallback(() => {
    loginGenerationRef.current += 1;
    startingRef.current = false;
    submittingRef.current = false;
    stopPollRef.current?.();
    stopPollRef.current = null;
    const pending = pendingLoginRef.current;
    pendingLoginRef.current = null;
    if (pending) void api.del(`/api/codex-accounts/${pending.method}-login/${pending.id}`).catch(() => {});
  }, []);

  const cancelLogin = useCallback(() => {
    releaseLogin();
    setDevice(null); setDeviceWaiting(false); setBrowser(null);
    setLoginStarting(false); setCallbackUrl(""); setSubmittingCallback(false);
  }, [releaseLogin]);

  const pollLogin = useCallback((id: string, method: LoginMethod) => {
    const deadline = Date.now() + (method === "browser" ? 610_000 : DEVICE_POLL_DEADLINE_MS);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    stopPollRef.current = () => { stopped = true; clearTimeout(timer); };
    const tick = async () => {
      if (stopped) return;
      let status: DeviceStatus | null = null;
      // Transient network failures must not discard an authorization in progress.
      try { status = await api.get<DeviceStatus>(`/api/codex-accounts/${method}-login/${id}/status`); } catch { /* retry */ }
      if (stopped) return;
      if (status?.state === "done") {
        cancelLogin(); setLabel(""); onDoneRef.current(); await load(); return;
      }
      if (status?.state === "error" || Date.now() > deadline) {
        cancelLogin();
        setErr(status?.state === "error" ? status.error : `${method === "browser" ? "Browser" : "Device"} login timed out.`);
        return;
      }
      timer = setTimeout(tick, DEVICE_POLL_MS);
    };
    void tick();
  }, [cancelLogin, load]);

  useEffect(() => releaseLogin, [releaseLogin]);

  const startLogin = async (method: LoginMethod) => {
    if (startingRef.current || pendingLoginRef.current || addingRef.current) return;
    startingRef.current = true;
    const generation = ++loginGenerationRef.current;
    setLoginStarting(true); setErr(null);
    try {
      const result = await api.post<DevicePending | BrowserPending>(`/api/codex-accounts/${method}-login`, { label: label.trim() || undefined });
      // Closing the dialog while startup is in flight still owes the server a cancel.
      if (generation !== loginGenerationRef.current) {
        void api.del(`/api/codex-accounts/${method}-login/${result.id}`).catch(() => {});
        return;
      }
      pendingLoginRef.current = { id: result.id, method };
      if (method === "device") { setDevice(result as DevicePending); setDeviceWaiting(true); }
      else setBrowser(result as BrowserPending);
      pollLogin(result.id, method);
    } catch (e) {
      if (generation === loginGenerationRef.current) setErr((e as Error).message);
    } finally {
      if (generation === loginGenerationRef.current) { startingRef.current = false; setLoginStarting(false); }
    }
  };

  const submitCallback = async () => {
    const pending = pendingLoginRef.current;
    if (pending?.method !== "browser" || !callbackUrl.trim() || submittingRef.current) return;
    const generation = loginGenerationRef.current;
    submittingRef.current = true; setSubmittingCallback(true); setErr(null);
    const submittedUrl = callbackUrl.trim();
    setCallbackUrl("");
    try {
      await api.post(`/api/codex-accounts/browser-login/${pending.id}/callback`, { callbackUrl: submittedUrl });
    } catch (e) {
      if (generation === loginGenerationRef.current) setErr((e as Error).message);
    } finally {
      if (generation === loginGenerationRef.current) { submittingRef.current = false; setSubmittingCallback(false); }
    }
  };

  const remove = async (id: string) => { await api.del(`/api/codex-accounts/${id}`); await load(); };

  /**
   * Switch an account on or off.
   *
   * Tracked per account rather than with one shared flag: the pane shows every account side
   * by side, and a single flag would grey out all of them while one is changing.
   */
  const toggle = async (id: string, status: string) => {
    const next = status === "disabled" ? "active" : "disabled";
    setToggling((prev) => new Set(prev).add(id));
    setErr(null);
    try {
      await api.patch(`/api/codex-accounts/${id}`, { status: next });
      await load();
    } catch (e) {
      setErr((e as Error).message || "Could not change the account");
    } finally {
      setToggling((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  };
  const toggleDailyGuard = async (id: string, enabled: boolean) => {
    setToggling((prev) => new Set(prev).add(id));
    setErr(null);
    try {
      await api.patch(`/api/codex-accounts/${id}`, { dailyGuardEnabled: !enabled });
      await load();
    } catch (e) {
      setErr((e as Error).message || "Could not change Daily guard");
    } finally {
      setToggling((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  };
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
    toggling,
    load, addApiKey, startDevice: () => startLogin("device"), startBrowser: () => startLogin("browser"),
    browser, loginStarting, callbackUrl, setCallbackUrl, submittingCallback, submitCallback, cancelLogin, remove, toggle, toggleDailyGuard, changeStrategy, doExport, doImport,
  };
}
