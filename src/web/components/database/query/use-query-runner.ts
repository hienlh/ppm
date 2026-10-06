/**
 * The Query tab's runs: the text sent to the target's `/query/script`, what it streams back folded
 * into a `QueryRun` as it arrives, Stop, and the edits made to a result saved to the table it was
 * read from — that result then read again, its statement alone. One run at a time: the tab's run
 * buttons wait for the one under way, as DBGate's do.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { readNdjson } from "@/lib/read-ndjson";
import { randomId } from "@/lib/utils";
import { missingDbDriverOf, type MissingDbDriver } from "@/lib/db-drivers";
import { useDbDriverInstalled } from "@/hooks/use-db-driver-installed";
import { targetUrl, type DbTarget } from "@/lib/db-tabs";
import type { QueryScriptEvent, QueryScriptRequest, QueryStatementResult } from "../../../../shared/db-query-script";
import type { GridChanges } from "../glide-grid-types";
import type { DbTabPlace } from "../explorer/open-db-tabs";
import { requestGridSave } from "../grid/grid-save-store";
import {
  applyQueryEvents, failQueryRun, noteOnQueryRun, replaceResultSet, resultOfTab, startQueryRun, type QueryRun, type QueryRunKind,
  type TimedQueryEvent,
} from "./query-run-state";

/** Events are drawn together this often: a script of many quick statements would otherwise draw once per statement. */
const FLUSH_MS = 50;
/**
 * How long a Stop the server did not recognise waits for the run to end by itself before the
 * request is dropped: the run may have just ended, its last lines still on their way, or the
 * request starting it may not have reached the server yet. Dropping it stops the run there too.
 */
const STOP_GRACE_MS = 1_000;

export interface QueryRunRequest {
  sql: string;
  kind: QueryRunKind;
  /** The editor's line of the text's line 1, less one. */
  lineOffset: number;
}

interface ActiveRun {
  runId: string;
  target: DbTarget;
  abort: AbortController;
  stopping: boolean;
}

/** A run id the server accepts, and no other run of this browser has. */
function newRunId(): string {
  return `${randomId()}${randomId()}`;
}

export function useQueryRunner(target: DbTarget | null, options: { maxRows: number; continueOnError: boolean }) {
  const [run, setRun] = useState<QueryRun | null>(null);
  const [driverMissing, setDriverMissing] = useState<MissingDbDriver | null>(null);
  const [stopping, setStopping] = useState(false);
  /** The result tab being read again after a save. */
  const [rereading, setRereading] = useState<string | null>(null);
  /** Runs that have ended, the server's audit entry for each written by then: the History panel reads again on a change. */
  const [ended, setEnded] = useState(0);
  const runRef = useRef<QueryRun | null>(null);
  const activeRef = useRef<ActiveRun | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(true);

  const show = useCallback((next: QueryRun) => {
    runRef.current = next;
    setRun(next);
  }, []);

  // Leaving the tab drops the request, and the server stops the run when it notices.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current?.abort.abort();
    };
  }, []);

  const start = useCallback(async (request: QueryRunRequest): Promise<void> => {
    if (!target || !request.sql.trim() || activeRef.current) return;
    const { maxRows, continueOnError } = optionsRef.current;
    const active: ActiveRun = { runId: newRunId(), target, abort: new AbortController(), stopping: false };
    activeRef.current = active;
    show(startQueryRun({ runId: active.runId, kind: request.kind, sql: request.sql, lineOffset: request.lineOffset, maxRows }, Date.now()));
    setDriverMissing(null);
    setStopping(false);

    let pending: TimedQueryEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (pending.length === 0 || !mountedRef.current || !runRef.current) return;
      const batch = pending;
      pending = [];
      show(applyQueryEvents(runRef.current, batch));
    };
    const body: QueryScriptRequest = {
      sql: request.sql, runId: active.runId, maxRows,
      ...(continueOnError ? { continueOnError: true } : {}),
      ...(request.kind === "explain" ? { explain: true } : {}),
    };
    try {
      const res = await api.postStream(targetUrl(target, "/query/script"), body, { signal: active.abort.signal });
      await readNdjson<QueryScriptEvent>(res.body!, (event) => {
        pending.push({ event, at: Date.now() });
        if (event.type === "done") flush();
        else timer ??= setTimeout(flush, FLUSH_MS);
      });
      flush();
      if (mountedRef.current && runRef.current && !runRef.current.done) {
        show(failQueryRun(runRef.current, "The connection to the server was lost before the run ended", Date.now()));
      }
    } catch (e) {
      flush();
      if (!mountedRef.current || !runRef.current) return;
      const driver = missingDbDriverOf(e);
      setDriverMissing(driver);
      retryRef.current = driver ? () => { void start(request); } : null;
      const message = active.stopping && active.abort.signal.aborted
        ? "Stopped: the server did not answer Stop, so the run was dropped"
        : (e as Error).message;
      show(failQueryRun(runRef.current, message, Date.now()));
    } finally {
      if (timer) clearTimeout(timer);
      if (activeRef.current === active) activeRef.current = null;
      if (mountedRef.current) {
        setStopping(false);
        setEnded((n) => n + 1);
      }
    }
  }, [target, show]);

  /** DBGate's Stop: the statement running is cancelled and nothing after it runs. */
  const stop = useCallback(async (): Promise<void> => {
    const active = activeRef.current;
    if (!active || active.stopping) return;
    active.stopping = true;
    setStopping(true);
    let known: boolean | null = null;
    try {
      known = (await api.post<{ stopped: boolean }>(targetUrl(active.target, "/query/cancel"), { runId: active.runId })).stopped;
    } catch {
      // The server could not be asked: dropping the request is the one way left to tell it.
    }
    // Known: the run ends by itself, its last statement saying it was stopped.
    if (known) return;
    setTimeout(() => {
      if (activeRef.current === active) active.abort.abort();
    }, known === false ? STOP_GRACE_MS : 0);
  }, []);

  useDbDriverInstalled((driverId) => {
    if (driverMissing?.id !== driverId) return;
    const retry = retryRef.current;
    retryRef.current = null;
    retry?.();
  });

  /** The rows of result tab `tabKey` read again — that statement alone, as the run read it. */
  const reread = useCallback(async (tabKey: string): Promise<void> => {
    const current = runRef.current;
    const tab = current?.tabs.find((t) => t.key === tabKey);
    const found = current && tab ? resultOfTab(current, tab) : null;
    if (!target || !current || !tab || !found) return;
    setRereading(tabKey);
    let fresh: QueryStatementResult | undefined;
    let broke: string | undefined;
    try {
      const res = await api.postStream(targetUrl(target, "/query/script"), { sql: found.result.sql, runId: newRunId(), maxRows: current.maxRows });
      await readNdjson<QueryScriptEvent>(res.body!, (event) => {
        if (event.type === "statement") fresh ??= event.result;
        else if (event.type === "done" && event.error !== undefined) broke = event.error;
      });
    } catch (e) {
      broke = (e as Error).message;
    }
    if (!mountedRef.current) return;
    setRereading(null);
    // A newer run took its place: the rows read belong to nothing shown.
    const now = runRef.current;
    if (!now || now.runId !== current.runId) return;
    const set = fresh?.resultSets[tab.set];
    const why = fresh?.error ?? broke ?? (set ? undefined : "the statement no longer returns that result");
    show(why === undefined
      ? replaceResultSet(now, tabKey, set!)
      : noteOnQueryRun(now, { level: "warning", text: `Saved, but reading the rows again failed: ${why}`, statement: tab.statement }, Date.now()));
  }, [target, show]);

  /**
   * Save edits of a result to `table` through DBGate's Save changes dialog, then read its rows again
   * to show what the table holds now. Rejects when nothing was saved, so the grid keeps its edits.
   */
  const saveChangesIn = useCallback(async (tabKey: string, table: string, schema: string, changes: GridChanges, place: DbTabPlace | null) => {
    if (!target) return;
    await requestGridSave({ target, place, table, schema, changes });
    void reread(tabKey);
  }, [target, reread]);

  return { run, running: !!run && !run.done, stopping, rereading, ended, driverMissing, start, stop, saveChangesIn };
}
