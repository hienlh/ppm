/**
 * The records the Logs list shows: one page for the filter, earlier pages on request, and new
 * lines as the server pushes them.
 *
 * New lines come over `/ws/global` as `logs:lines` while any Logs view holds the subscription
 * (`retainLogsTail`), every new record from every source; this hook keeps the ones its filter
 * passes — the same predicate the server used for the page. The subscription is taken before
 * the page is asked for, and lines landing while that request is out are held and joined to the
 * page by id, so the seam between the two neither drops nor doubles a line. After a reconnect
 * the page is read again: lines written while the socket was down were never pushed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onGlobalReady, sendIfOpen } from "@/lib/global-ws-channel";
import { rangeStart } from "@/lib/logs/logs-view-model";
import {
  addToSourceStats, compileLogSearch, matchesLogFilter, type LogEntry, type LogFilter, type LogRange,
  type LogSourceId, type LogSourceStats,
} from "../../../shared/logs-model";
import {
  LOGS_SUBSCRIBE, LOGS_UNSUBSCRIBE, type LogQueryResult, type LogsLinesEvent,
} from "../../../shared/logs-api";
import { fetchLogs } from "./logs-client";

const PAGE = 500;
/** Lines kept in memory; past this the oldest go, and Load earlier brings them back. */
const MAX_KEEP = 20_000;
/** How far back a live line is checked against the list for a duplicate. */
const DEDUPE_TAIL = 4000;

let holders = 0;
let readyOff: (() => void) | null = null;
const subscribe = () => sendIfOpen(JSON.stringify({ type: LOGS_SUBSCRIBE }));

/** Keeps the server pushing new lines while any Logs view is mounted. */
function retainLogsTail(): () => void {
  if (holders++ === 0) {
    subscribe();
    readyOff = onGlobalReady(subscribe);
  }
  return () => {
    if (--holders > 0) return;
    readyOff?.();
    readyOff = null;
    sendIfOpen(JSON.stringify({ type: LOGS_UNSUBSCRIBE }));
  };
}

export type LogsMeta = Omit<LogQueryResult, "entries">;

export interface LiveBatch {
  seq: number;
  /** Records added to the list by this batch. */
  count: number;
}

interface FeedState {
  /** The filter and range the list was read for, as `queryKey` writes them. */
  key: string;
  entries: LogEntry[];
  meta: LogsMeta | null;
  loading: boolean;
  loadingEarlier: boolean;
  error: string | null;
  batch: LiveBatch | null;
}

export function queryKey(filter: LogFilter, range: LogRange): string {
  return JSON.stringify([filter.src, filter.levels, filter.tagsOff, filter.q, filter.regex, filter.caseSensitive, filter.chat, range]);
}

function cloneStats(stats: Record<LogSourceId, LogSourceStats>): Record<LogSourceId, LogSourceStats> {
  const out = {} as Record<LogSourceId, LogSourceStats>;
  for (const [id, s] of Object.entries(stats) as Array<[LogSourceId, LogSourceStats]>) {
    out[id] = { ...s, tags: s.tags.map((t) => [t[0], t[1]] as [string, number]) };
  }
  return out;
}

/** `entries` joined onto `state` the way a push is: counted, filtered, de-duplicated, capped. */
function applyLive(state: FeedState, entries: readonly LogEntry[], titles: Record<string, string>, filter: LogFilter): FeedState {
  const meta = state.meta;
  if (!meta || !entries.length) return state;
  const allTitles = { ...meta.titles, ...titles };
  const have = new Set(state.entries.slice(-DEDUPE_TAIL).map((e) => e.id));
  const fresh = entries.filter((e) => e.ts >= meta.fromTs && !have.has(e.id));
  if (!fresh.length) return state;
  const stats = cloneStats(meta.stats);
  addToSourceStats(stats, fresh);
  const search = compileLogSearch(filter);
  const matching = fresh.filter((e) => matchesLogFilter(e, filter, search, allTitles));
  const chats = meta.chats.map((c) => ({ ...c }));
  for (const e of fresh) {
    if (!e.sid) continue;
    const c = chats.find((x) => x.sid === e.sid);
    if (c) {
      c.count++;
      c.last = e.ts;
    } else chats.unshift({ sid: e.sid, title: allTitles[e.sid] ?? null, count: 1, last: e.ts });
  }
  let next = matching.length ? state.entries.concat(matching) : state.entries;
  let hasMore = meta.hasMore;
  if (next.length > MAX_KEEP) {
    next = next.slice(-MAX_KEEP);
    hasMore = true;
  }
  return {
    ...state,
    entries: next,
    meta: {
      ...meta,
      stats,
      chats,
      titles: allTitles,
      matched: meta.matched + matching.length,
      inRange: meta.inRange + fresh.filter((e) => filter.src === "all" || e.src === filter.src).length,
      hasMore,
    },
    batch: matching.length ? { seq: (state.batch?.seq ?? 0) + 1, count: matching.length } : state.batch,
  };
}

export interface LogsFeed extends FeedState {
  /** Lines held back while paused that the filter passes. */
  pausedCount: number;
  /** The page before the first line; with `reach`, as far back as that record. */
  loadEarlier(reach?: string): Promise<boolean>;
  reload(): void;
}

export function useLogsFeed(filter: LogFilter, range: LogRange, paused: boolean): LogsFeed {
  const key = queryKey(filter, range);
  const [state, setState] = useState<FeedState>({ key, entries: [], meta: null, loading: true, loadingEarlier: false, error: null, batch: null });
  const [reloads, setReloads] = useState(0);
  const [pausedCount, setPausedCount] = useState(0);

  const filterRef = useRef(filter);
  filterRef.current = filter;
  const stateRef = useRef(state);
  stateRef.current = state;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const lastSearch = useRef(filter.q);
  /** Lines pushed while the page was being read. */
  const inFlight = useRef<{ entries: LogEntry[]; titles: Record<string, string> } | null>(null);
  /** Lines pushed while paused. */
  const held = useRef<{ entries: LogEntry[]; titles: Record<string, string> }>({ entries: [], titles: {} });

  useEffect(() => retainLogsTail(), []);

  // A reconnect means lines were written that nobody pushed: read the page again.
  useEffect(() => onGlobalReady(() => setReloads((n) => n + 1)), []);

  useEffect(() => {
    const ctl = new AbortController();
    inFlight.current = { entries: [], titles: {} };
    held.current = { entries: [], titles: {} };
    setPausedCount(0);
    setState((s) => ({ ...s, key, loading: true, error: null }));
    // Typing in the search box asks once it settles; anything else asks at once.
    const delay = filter.q !== lastSearch.current ? 250 : 0;
    lastSearch.current = filter.q;
    const timer = setTimeout(() => {
      fetchLogs({ ...filter, range, from: rangeStart(range, Date.now()), limit: PAGE }, ctl.signal)
        .then((res) => {
          if (ctl.signal.aborted) return;
          const { entries, ...meta } = res;
          const pending = inFlight.current ?? { entries: [], titles: {} };
          inFlight.current = null;
          const base: FeedState = { key, entries, meta, loading: false, loadingEarlier: false, error: null, batch: null };
          setState(applyLive(base, pending.entries, pending.titles, filter));
        })
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return;
          inFlight.current = null;
          setState((s) => ({ ...s, key, loading: false, error: e instanceof Error ? e.message : String(e) }));
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // `filter` is read through `key`, which names every field of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloads]);

  useEffect(() => {
    const onLines = (ev: Event) => {
      const d = (ev as CustomEvent<LogsLinesEvent>).detail;
      if (!d?.entries?.length) return;
      if (inFlight.current) {
        inFlight.current.entries.push(...d.entries);
        Object.assign(inFlight.current.titles, d.titles);
        return;
      }
      if (pausedRef.current) {
        held.current.entries.push(...d.entries);
        Object.assign(held.current.titles, d.titles);
        const f = filterRef.current;
        const search = compileLogSearch(f);
        const titles = { ...stateRef.current.meta?.titles, ...held.current.titles };
        setPausedCount((n) => n + d.entries.filter((e) => matchesLogFilter(e, f, search, titles)).length);
        return;
      }
      setState((s) => applyLive(s, d.entries, d.titles ?? {}, filterRef.current));
    };
    window.addEventListener("logs:lines", onLines);
    return () => window.removeEventListener("logs:lines", onLines);
  }, []);

  // Resuming lets everything held back in at once.
  useEffect(() => {
    if (paused) return;
    const { entries, titles } = held.current;
    held.current = { entries: [], titles: {} };
    setPausedCount(0);
    if (entries.length) setState((s) => applyLive(s, entries, titles, filterRef.current));
  }, [paused]);

  const loadEarlier = useCallback(async (reach?: string): Promise<boolean> => {
    const s = stateRef.current;
    if (!s.meta?.hasMore || s.loadingEarlier || s.loading || !s.entries.length) return false;
    const startKey = s.key;
    setState((x) => ({ ...x, loadingEarlier: true }));
    try {
      const res = await fetchLogs({ ...filterRef.current, range, from: s.meta.fromTs, before: s.entries[0]!.id, limit: PAGE, ...(reach ? { reach } : {}) });
      const cur = stateRef.current;
      if (cur.key !== startKey || !cur.meta) {
        setState((x) => ({ ...x, loadingEarlier: false }));
        return false;
      }
      const have = new Set(cur.entries.slice(0, DEDUPE_TAIL).map((e) => e.id));
      const older = res.entries.filter((e) => !have.has(e.id));
      setState((x) => (x.key !== startKey || !x.meta
        ? { ...x, loadingEarlier: false }
        : {
          ...x,
          entries: older.concat(x.entries),
          meta: { ...x.meta, hasMore: res.hasMore, titles: { ...res.titles, ...x.meta.titles }, reachMissed: res.reachMissed },
          loadingEarlier: false,
        }));
      return older.length > 0;
    } catch {
      setState((x) => ({ ...x, loadingEarlier: false }));
      return false;
    }
  }, [range]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  return useMemo(() => ({ ...state, pausedCount, loadEarlier, reload }), [state, pausedCount, loadEarlier, reload]);
}
