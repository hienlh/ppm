/**
 * Everything the connection tab does, apart from how it looks: loading a saved connection, the
 * values, Test / Connect / Save, the ▾ list of databases, and pointing at a field that is wrong.
 *
 * Every action works on the values as they were when its button was pressed. A result belongs
 * to the connection it was run against (`targetKey`), so editing the host after a Test drops the
 * result instead of leaving it next to a connection it did not test.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { listDbDrivers, missingDbDriverOf, type MissingDbDriver } from "@/lib/db-drivers";
import { useDbDriverInstalled } from "@/hooks/use-db-driver-installed";
import { useTabStore } from "@/stores/tab-store";
import { DEFAULT_USER } from "../../../../shared/db-connection-url";
import {
  DB_LOGIN_REQUIRED, type DbLoginPrompt, type DbTestResult, type EditableConnectionConfig, type SshHop,
} from "../../../../shared/db-connection-config";
import type { DbDriverStatus } from "../../../../shared/db-drivers";
import type { DbType } from "../../../../shared/db-types";
import type { Connection } from "../use-connections";
import { revealConnection } from "../db-sidebar-reveal";
import { requestDbLogin, type DbLogin } from "../db-login/db-login-store";
import {
  effectiveName, emptyForm, fieldOfServerError, formAsksForLogin, formFromSaved, listedDatabases, pickEngine,
  saveRequestBody, switchEntry, tabOfField, tabsFor, targetKey, targetOf, testRequestBody, typeUrl, validate,
  type ConnectionFormValues, type EditingInfo, type FormContext, type FormField, type FormProblem, type FormTab,
} from "./connection-form-state";
import type { RunState } from "./connection-test-result";

type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; message: string };

/** The driver a tunnel needs, as the catalog names it. */
const SSH_DRIVER = "ssh";

interface TestOutcome {
  result: DbTestResult;
  /** The login Database Log In was given, for a connection that asks for one. */
  login: DbLogin | null;
}

/** The prompt a 428 answer carries, when that is what `e` is. */
function loginPromptOf(e: unknown): DbLoginPrompt | null {
  if (!(e instanceof ApiError) || e.code !== DB_LOGIN_REQUIRED) return null;
  return (e.body as { login?: DbLoginPrompt }).login ?? null;
}

export function useConnectionForm(connectionId: number | null, tabId: string | undefined) {
  const [load, setLoad] = useState<LoadState>(connectionId === null ? { kind: "ready" } : { kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [values, setValues] = useState<ConnectionFormValues>(() => emptyForm());
  const [editing, setEditing] = useState<EditingInfo | null>(null);
  const [saved, setSaved] = useState<Connection[]>([]);
  const [tab, setTab] = useState<FormTab>("general");
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ field: FormField; n: number } | null>(null);
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dbList, setDbList] = useState<{ key: string; names: string[] } | null>(null);
  const [dbBusy, setDbBusy] = useState(false);
  const [dbError, setDbError] = useState<{ key: string; message: string } | null>(null);
  const [dbMenuOpen, setDbMenuOpen] = useState(false);
  const [drivers, setDrivers] = useState<DbDriverStatus[] | null>(null);
  const [testMissing, setTestMissing] = useState<MissingDbDriver | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** What a missing driver interrupted, to run again once it is installed. */
  const interruptedRef = useRef<"test" | "connect" | "list" | null>(null);
  const fieldRefs = useRef<Partial<Record<FormField, HTMLElement | null>>>({});

  // ── Loading ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    api.get<Connection[]>("/api/db/connections").then((list) => { if (!cancelled) setSaved(list); }).catch(() => {
      // The duplicate-name check waits for it; the server refuses a duplicate either way.
    });
    if (connectionId !== null) {
      // A form already on screen — the one Save just stored — is refreshed in place.
      setLoad((l) => (l.kind === "ready" ? l : { kind: "loading" }));
      Promise.all([
        api.get<Connection>(`/api/db/connections/${connectionId}`),
        api.get<EditableConnectionConfig>(`/api/db/connections/${connectionId}/config`),
      ]).then(([conn, config]) => {
        if (cancelled) return;
        const { values: loaded, ...saved } = formFromSaved(conn, config);
        setValues(loaded);
        setEditing({ id: conn.id, ...saved });
        setLoad({ kind: "ready" });
        // Save keeps its buttons off until the form is the saved connection's.
        setRun((r) => (r.kind === "running" && r.action === "save" ? { kind: "idle" } : r));
      }).catch((e: Error) => {
        if (!cancelled) setLoad({ kind: "failed", message: e.message });
      });
    }
    return () => { cancelled = true; };
  }, [connectionId, reloads]);

  const refreshDrivers = useCallback(() => {
    listDbDrivers().then(setDrivers).catch(() => { /* a Test still reports a missing driver */ });
  }, []);
  useEffect(refreshDrivers, [refreshDrivers]);

  // A tab left open while the request is still out must not act on it once it is gone.
  useEffect(() => () => abortRef.current?.abort(), []);

  const ctx = useMemo<FormContext>(() => ({
    editing,
    takenNames: new Set(saved.filter((c) => c.id !== connectionId).map((c) => c.name)),
  }), [editing, saved, connectionId]);

  const folders = useMemo(
    () => [...new Set(saved.map((c) => c.group_name).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)),
    [saved],
  );

  // ── Values ─────────────────────────────────────────────────────────────────
  const update = useCallback((next: Partial<ConnectionFormValues> | ((v: ConnectionFormValues) => ConnectionFormValues)) => {
    setValues((v) => (typeof next === "function" ? next(v) : { ...v, ...next }));
    setProblem(null);
  }, []);

  const key = targetKey(values, ctx);
  const listKey = targetKey(values, ctx, false);
  // A result says something about one connection; another one gets none until it is tested.
  useEffect(() => {
    setRun((r) => ((r.kind === "ok" || r.kind === "failed") && r.key !== key ? { kind: "idle" } : r));
  }, [key]);
  useEffect(() => { setTestMissing(null); }, [values.type, values.sshEnabled]);
  // SQLite has no Advanced tab to be on.
  useEffect(() => {
    if (!tabsFor(values.type).includes(tab)) setTab("general");
  }, [values.type, tab]);

  const showProblem = useCallback((p: FormProblem) => {
    setProblem(p);
    setTab(tabOfField(p.field));
    setFocusRequest((f) => ({ field: p.field, n: (f?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (focusRequest) fieldRefs.current[focusRequest.field]?.focus();
  }, [focusRequest]);

  const register = useCallback((field: FormField) => (el: HTMLElement | null) => { fieldRefs.current[field] = el; }, []);

  const setEntry = (entry: "fields" | "url") => {
    const next = switchEntry(values, ctx, entry);
    if ("problem" in next) showProblem(next.problem);
    else update(next.values);
  };
  const setUrl = (url: string) => update((v) => typeUrl(v, ctx, url));
  const setType = (type: DbType) => { if (!editing) update((v) => pickEngine(v, type)); };

  // ── Test, Connect, Save ────────────────────────────────────────────────────
  /** `/test` for `snapshot`, asking for the login first when the form keeps none. Null: the login was not given. */
  const testOnce = async (snapshot: ConnectionFormValues, snapCtx: FormContext, signal: AbortSignal): Promise<TestOutcome | null> => {
    const body = testRequestBody(snapshot, snapCtx);
    const viaLogin = async (prompt: DbLoginPrompt): Promise<TestOutcome | null> => {
      const outcome = await requestDbLogin({
        // Never a saved connection's id: this login is tried on what the form holds, not on what was saved.
        prompt: { ...prompt, connectionId: null, name: effectiveName(snapshot, snapCtx) },
        submit: (login, s) => api.post<DbTestResult>("/api/db/test", { ...body, login }, { signal: s, dbLogin: false }),
      });
      return outcome && { result: outcome.result, login: outcome.login };
    };
    if (formAsksForLogin(snapshot)) {
      const askUser = snapshot.passwordMode === "askUser";
      const user = askUser ? "" : snapshot.user.trim() || (snapshot.type === "sqlite" ? "" : DEFAULT_USER[snapshot.type]);
      return viaLogin({ connectionId: null, name: "", type: snapshot.type, user, askUser });
    }
    try {
      return { result: await api.post<DbTestResult>("/api/db/test", body, { signal, dbLogin: false }), login: null };
    } catch (e) {
      const prompt = loginPromptOf(e);
      if (!prompt) throw e;
      return viaLogin(prompt);
    }
  };

  /** A request that failed as a whole, rather than with a test result. */
  const failWith = (e: unknown, snapshot: ConnectionFormValues, snapKey: string, action: "test" | "connect" | "list" | "save") => {
    const driver = missingDbDriverOf(e);
    if (driver) {
      interruptedRef.current = action === "save" ? null : action;
      setTestMissing(driver);
      setRun({ kind: "idle" });
      // The Install notice is on the tab of what needs the driver.
      setTab(driver.id === SSH_DRIVER ? "ssh" : "general");
      return;
    }
    const field = e instanceof ApiError ? fieldOfServerError((e.body as { field?: unknown } | null)?.field, snapshot) : null;
    if (field) {
      setRun({ kind: "idle" });
      showProblem({ field, message: (e as Error).message });
      return;
    }
    const message = (e as Error).message || "The request failed";
    setRun(action === "save" ? { kind: "saveFailed", message } : { kind: "failed", result: { ok: false, error: message, details: "", elapsedMs: 0 }, key: snapKey });
  };

  const save = async (snapshot: ConnectionFormValues, snapCtx: FormContext, connected: boolean, login: DbLogin | null, newHostKeys: SshHop[] = []) => {
    const body = saveRequestBody(snapshot, snapCtx);
    let conn: Connection;
    try {
      conn = snapCtx.editing
        ? await api.put<Connection>(`/api/db/connections/${snapCtx.editing.id}`, body)
        : await api.post<Connection>("/api/db/connections", body);
    } catch (e) {
      failWith(e, snapshot, targetKey(snapshot, snapCtx), "save");
      return;
    }
    // Connect ends connected: a login it was given is held now, as Database Log In would.
    if (connected && login) {
      await api.post(`/api/db/connections/${conn.id}/login`, login).catch((e: Error) => {
        toast.error(`Saved “${conn.name}”, but could not log in`, { description: e.message });
      });
    }
    const edited = !!snapCtx.editing;
    // Reading the tables of a connection that asks for its password would ask for it again.
    revealConnection(conn, { expand: connected, refreshTables: connected || !formAsksForLogin(snapshot) });
    const trusted = newHostKeys.map((h) => `${h.host} (${h.fingerprint})`).join(", ");
    toast.success(
      connected ? `${edited ? "Updated" : "Saved"} and connected “${conn.name}”` : `${edited ? "Updated" : "Saved"} “${conn.name}”`,
      trusted ? { description: `First connection through SSH: PPM now trusts the host key of ${trusted}.` } : undefined,
    );
    if (!tabId) { setRun({ kind: "idle" }); return; }
    if (connected) { useTabStore.getState().closeTab(tabId); return; }
    // Save keeps the tab, as DBGate does, and makes it this connection's edit tab, reloaded as
    // Edit opens it: the next Save updates the connection instead of adding a second one.
    useTabStore.getState().updateTab(tabId, {
      title: `Edit ${conn.name}`,
      metadata: { connectionId: conn.id, connectionName: conn.name, dbType: conn.type },
    });
    // A new connection reloads by getting its id; an edited one already had it.
    if (edited) setReloads((n) => n + 1);
  };

  const runTest = async (action: "test" | "connect") => {
    if (run.kind === "running") return;
    const snapshot = values;
    const snapCtx = ctx;
    const p = validate(snapshot, snapCtx, action === "connect");
    if (p) { showProblem(p); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    const snapKey = targetKey(snapshot, snapCtx);
    const target = targetOf(snapshot, snapCtx);
    setTestMissing(null);
    setDetailsOpen(false);
    // With a login to ask for, the dialog shows the attempt; the line says nothing until then.
    setRun(formAsksForLogin(snapshot) ? { kind: "idle" } : { kind: "running", action, target });
    try {
      const outcome = await testOnce(snapshot, snapCtx, controller.signal);
      if (controller.signal.aborted) return;
      if (!outcome) { setRun({ kind: "idle" }); return; }
      const { result, login } = outcome;
      if (result.ok) setDbList({ key: targetKey(snapshot, snapCtx, false), names: result.databases });
      if (!result.ok) { setRun({ kind: "failed", result, key: snapKey }); return; }
      // A host key PPM just started trusting is shown, not only recorded.
      const newHostKeys = (result.ssh ?? []).filter((h) => h.firstSeen);
      if (action === "test") {
        setRun({ kind: "ok", result, key: snapKey });
        if (newHostKeys.length) setDetailsOpen(true);
        return;
      }
      // Connect saves only a connection that works.
      setRun({ kind: "running", action: "connect", target });
      await save(snapshot, snapCtx, true, login, newHostKeys);
    } catch (e) {
      if (!controller.signal.aborted) failWith(e, snapshot, snapKey, action);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancelTest = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRun({ kind: "idle" });
  };

  const saveOnly = async () => {
    if (run.kind === "running") return;
    const snapshot = values;
    const snapCtx = ctx;
    const p = validate(snapshot, snapCtx, true);
    if (p) { showProblem(p); return; }
    setRun({ kind: "running", action: "save", target: targetOf(snapshot, snapCtx) });
    await save(snapshot, snapCtx, false, null);
  };

  // ── ▾ Default database ─────────────────────────────────────────────────────
  const databases = dbList?.key === listKey ? listedDatabases(dbList.names, values) : null;

  const listDatabases = async () => {
    if (dbBusy) return;
    if (databases) { setDbMenuOpen(true); return; }
    const snapshot = values;
    const snapCtx = ctx;
    const p = validate(snapshot, snapCtx, false);
    if (p) { showProblem(p); return; }
    const snapListKey = targetKey(snapshot, snapCtx, false);
    setDbBusy(true);
    setDbError(null);
    const controller = new AbortController();
    try {
      const outcome = await testOnce(snapshot, snapCtx, controller.signal);
      if (!outcome) return;
      if (outcome.result.ok) {
        setDbList({ key: snapListKey, names: outcome.result.databases });
        setDbMenuOpen(true);
      } else {
        setDbError({ key: snapListKey, message: `Could not list the databases: ${outcome.result.error}` });
      }
    } catch (e) {
      const driver = missingDbDriverOf(e);
      if (driver) {
        interruptedRef.current = "list";
        setTestMissing(driver);
        if (driver.id === SSH_DRIVER) setTab("ssh");
        return;
      }
      setDbError({ key: snapListKey, message: `Could not list the databases: ${(e as Error).message}` });
    } finally {
      setDbBusy(false);
    }
  };

  // ── A driver to install first ──────────────────────────────────────────────
  // The engine's on General, the tunnel's on SSH Tunnel: each notice where its setting is.
  const needed = drivers?.find((d) => d.engines.includes(values.type));
  const sshDriver = drivers?.find((d) => d.id === SSH_DRIVER);
  const missingDriver = (testMissing && testMissing.id !== SSH_DRIVER ? testMissing : null)
    ?? (needed?.state === "missing" ? { id: needed.id, displayName: needed.displayName } : null);
  const missingSshDriver = (testMissing?.id === SSH_DRIVER ? testMissing : null)
    ?? (values.type !== "sqlite" && values.sshEnabled && sshDriver?.state === "missing" ? { id: sshDriver.id, displayName: sshDriver.displayName } : null);
  const latest = useRef({ runTest, listDatabases });
  latest.current = { runTest, listDatabases };

  // Whatever the missing driver stopped runs again once it is in, from here or from Settings.
  useDbDriverInstalled((installedId) => {
    if (missingDriver?.id !== installedId && missingSshDriver?.id !== installedId) return;
    const stopped = testMissing?.id === installedId;
    const again = stopped ? interruptedRef.current : null;
    if (stopped) {
      interruptedRef.current = null;
      setTestMissing(null);
    }
    // Marked at once, so the notice does not linger until the list comes back.
    setDrivers((prev) => prev?.map((d) => (d.id === installedId ? { ...d, state: "installed" as const } : d)) ?? prev);
    refreshDrivers();
    if (again === "list") void latest.current.listDatabases();
    else if (again) void latest.current.runTest(again);
  });

  return {
    load, reload: () => setReloads((n) => n + 1),
    values, update, ctx, editing, folders,
    tab, setTab, problem, register,
    setEntry, setUrl, setType,
    run, detailsOpen, toggleDetails: () => setDetailsOpen((o) => !o),
    test: () => (run.kind === "running" && run.action === "test" ? cancelTest() : void runTest("test")),
    connect: () => void runTest("connect"),
    save: () => void saveOnly(),
    databases, dbBusy, dbError: dbError?.key === listKey ? dbError.message : null,
    dbMenuOpen, setDbMenuOpen, listDatabases: () => void listDatabases(),
    missingDriver, missingSshDriver,
  };
}

export type ConnectionForm = ReturnType<typeof useConnectionForm>;
