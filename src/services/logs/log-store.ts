/**
 * Every log PPM keeps, read as one list: `ppm.log` and its rotated copies, `cloudflared.log`,
 * and the browsers' console lines from the session trace. `queryLogs` filters and pages it for
 * the Logs window; `readNewEntries` is the live tail's cursor over the same sources.
 *
 * Indexes are kept per file inode (`log-file-index.ts`). Rotation renames `ppm.log.1` to `.2`
 * and `.2` to `.3`, which keeps their inodes, so those indexes survive it; the copy that becomes
 * `ppm.log.1` is adopted from `ppm.log`'s own index when it is the same content. An older file's
 * index is dropped after ten minutes unused, so "Everything kept" costs memory only while
 * someone is looking at it.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { LOG_GENERATIONS, MAX_LOG_BYTES } from "../log-rotate.ts";
import { configService } from "../config.service.ts";
import { getSessionTitles } from "../db.service.ts";
import { readBrowserRows, type BrowserTraceRow } from "../session-trace/session-trace-store.ts";
import {
  compileLogSearch, emptySourceStats, logSearchText, LOG_SOURCE_IDS,
  type LogEntry, type LogSourceId,
} from "../../shared/logs-model.ts";
import type { LogChatInfo, LogFilesInfo, LogQueryParams, LogQueryResult } from "../../shared/logs-api.ts";
import { FLAG_RESTART, LEVEL_INDEX, SOURCE_INDEX, sidTable, tagTable } from "./log-columns.ts";
import { LogFileIndex, readFirstGen, yieldToLoop } from "./log-file-index.ts";
import { browserEntry, deviceIdOf, deviceTags } from "./browser-logs.ts";

const IDLE_DROP_MS = 10 * 60 * 1000;
/** Records decoded between two yields while a search reads text. */
const SEARCH_YIELD_EVERY = 4000;
export const MAX_PAGE = 5000;
/** The most a page reaching back to one record (`reach`) may hold; under what a Logs view keeps. */
export const MAX_REACH = 15_000;
/** Lines kept before that record, so it is not the first thing on the page. */
export const REACH_CONTEXT = 20;

export function ppmLogPath(): string {
  return join(getPpmDir(), "ppm.log");
}

export function cloudflaredLogPath(): string {
  return join(getPpmDir(), "cloudflared.log");
}

/** `~/…` when it is under the home folder: what the person would recognise. */
export function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Oldest first: `ppm.log.3` … `ppm.log.1`, then `ppm.log`. A rotated file that starts with the
 * same record as a newer one is a copy of it rather than an older log — what rotation leaves
 * when the copy succeeds and the truncate fails (EBUSY on Windows, `log-rotate.ts`), once a
 * minute — so it is left out, or every record would be listed once per copy under one id.
 */
function ppmLogFiles(): string[] {
  const base = ppmLogPath();
  const out: string[] = [];
  const gens = new Set<string>();
  for (let g = 0; g <= LOG_GENERATIONS; g++) {
    const path = g === 0 ? base : `${base}.${g}`;
    const gen = readFirstGen(path, "ppm");
    if (gen && gens.has(gen)) continue;
    if (gen) gens.add(gen);
    out.unshift(path);
  }
  return out;
}

const byIno = new Map<number, LogFileIndex>();
let liveIndex: LogFileIndex | null = null;
let cloudflaredIndex: LogFileIndex | null = null;
const dropTimers = new Map<LogFileIndex, ReturnType<typeof setTimeout>>();

function touch(index: LogFileIndex): void {
  index.lastUsed = Date.now();
  if (index === liveIndex) return;
  const old = dropTimers.get(index);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    dropTimers.delete(index);
    if (index !== liveIndex && byIno.get(index.ino) === index) byIno.delete(index.ino);
  }, IDLE_DROP_MS);
  (timer as { unref?: () => void }).unref?.();
  dropTimers.set(index, timer);
}

/**
 * The index for one `ppm.log`-format path, brought up to date. `null` when the file does not
 * exist. Rotation is handled here: see the module comment.
 */
async function indexFor(path: string): Promise<LogFileIndex | null> {
  let st;
  try { st = statSync(path); } catch { return null; }
  const isLive = path === ppmLogPath();
  let index = byIno.get(st.ino);
  if (index && index.path !== path) {
    // Renamed by rotation (`.1` → `.2`): same inode, same bytes.
    (index as { path: string }).path = path;
  }
  if (!index) {
    // The fresh `ppm.log.1` is a copy of what `ppm.log` held: take that index over if it is.
    if (liveIndex && !isLive && liveIndex.ino !== st.ino && st.size >= liveIndex.scanned && liveIndex.gen
      && readFirstGen(path, "ppm") === liveIndex.gen) {
      index = liveIndex;
      byIno.delete(index.ino);
      (index as { path: string }).path = path;
      index.ino = st.ino;
      liveIndex = null;
    } else {
      index = new LogFileIndex(path, "ppm");
    }
    byIno.set(st.ino, index);
  }
  if (isLive) liveIndex = index;
  await index.refresh();
  // `refresh` may have found a new inode (the file was replaced): keep the map honest.
  if (byIno.get(index.ino) !== index) {
    for (const [ino, ix] of byIno) if (ix === index) byIno.delete(ino);
    byIno.set(index.ino, index);
  }
  touch(index);
  return index;
}

async function cloudflaredFor(): Promise<LogFileIndex | null> {
  const path = cloudflaredLogPath();
  try { statSync(path); } catch { cloudflaredIndex = null; return null; }
  if (!cloudflaredIndex) cloudflaredIndex = new LogFileIndex(path, "cloudflared");
  await cloudflaredIndex.refresh();
  return cloudflaredIndex;
}

/** One ordered source of records: a file index, or the browser rows read for this query. */
interface Stream {
  count: number;
  /** Streams sharing a chain are one log cut into files, oldest first: taken file by file. */
  chain?: string;
  ts(i: number): number;
  /** The time the merge places record `i` by; never earlier than the record before it. */
  key(i: number): number;
  lv(i: number): number;
  src(i: number): number;
  tag(i: number): number;
  sid(i: number): number;
  flags(i: number): number;
  id(i: number): string;
  entries(indices: readonly number[]): LogEntry[];
  indexOfId(id: string): number;
}

function fileStream(f: LogFileIndex, from: number): Stream & { base: number } {
  const base = f.cols.lowerBound(from);
  const c = f.cols;
  return {
    base,
    count: f.count - base,
    ts: (i) => c.ts[base + i]!,
    key: (i) => c.order[base + i]!,
    lv: (i) => c.lv[base + i]!,
    src: (i) => c.src[base + i]!,
    tag: (i) => c.tag[base + i]!,
    sid: (i) => c.sid[base + i]!,
    flags: (i) => c.flags[base + i]!,
    id: (i) => f.idOf(base + i),
    entries: (indices) => f.readEntries(indices.map((i) => base + i)),
    indexOfId: (id) => {
      const j = f.indexOfId(id);
      return j < base ? -1 : j - base;
    },
  };
}

function entryStream(list: readonly LogEntry[]): Stream {
  const tags = list.map((e) => tagTable.id(e.tag));
  const sids = list.map((e) => (e.sid ? sidTable.id(e.sid) : -1));
  return {
    count: list.length,
    ts: (i) => list[i]!.ts,
    key: (i) => list[i]!.ts,
    lv: (i) => LEVEL_INDEX[list[i]!.lv],
    src: (i) => SOURCE_INDEX[list[i]!.src],
    tag: (i) => tags[i]!,
    sid: (i) => sids[i]!,
    flags: () => 0,
    id: (i) => list[i]!.id,
    entries: (indices) => indices.map((i) => list[i]!),
    indexOfId: (id) => list.findIndex((e) => e.id === id),
  };
}

/** Browser rows as entries, each tagged with its device. */
export function browserEntries(rows: readonly BrowserTraceRow[]): LogEntry[] {
  const tags = deviceTags(rows.map(deviceIdOf));
  return rows.map((r) => browserEntry(r, tags.get(deviceIdOf(r)) ?? "Browser"));
}

/** The time PPM last started, from the supervisor's own line; 0 when none is kept. */
async function lastRestart(): Promise<number> {
  const files = ppmLogFiles().reverse();
  for (const path of files) {
    const f = await indexFor(path);
    if (!f) continue;
    for (let i = f.count - 1; i >= 0; i--) if (f.cols.flags[i]! & FLAG_RESTART) return f.cols.ts[i]!;
  }
  return 0;
}

/** Streams covering `[from, now]`, oldest file first. */
async function openStreams(from: number): Promise<{ streams: Stream[] }> {
  const streams: Stream[] = [];
  for (const path of ppmLogFiles()) {
    let st;
    try { st = statSync(path); } catch { continue; }
    // A rotated file last written before the range starts holds nothing in it.
    if (path !== ppmLogPath() && from > 0 && st.mtimeMs < from) continue;
    const f = await indexFor(path);
    if (!f || f.count === 0) continue;
    streams.push(Object.assign(fileStream(f, from), { chain: "ppm" }));
  }
  const cf = await cloudflaredFor();
  if (cf && cf.count) streams.push(fileStream(cf, from));
  try {
    const rows = readBrowserRows({ fromTs: from });
    if (rows.length) streams.push(entryStream(browserEntries(rows)));
  } catch { /* no trace database yet: no browser lines */ }
  return { streams };
}

/**
 * All streams' records in one order, as (stream, index) pairs. No stream's own order is changed:
 * `ppm.log` and its rotated copies are one log written in sequence, so they are taken file by
 * file, and only separate logs are interleaved, by `key` — a stamp out of step with the lines
 * around it is placed by theirs (`RecordColumns.order`).
 */
function merge(streams: readonly Stream[]): { s: Uint8Array; i: Uint32Array; n: number } {
  const n = streams.reduce((a, st) => a + st.count, 0);
  const s = new Uint8Array(n);
  const ix = new Uint32Array(n);
  const pos = streams.map(() => 0);
  // The earlier files of a stream's chain, which it waits for.
  const before = streams.map((st, j) => (st.chain ? streams.slice(0, j).map((o, k) => (o.chain === st.chain ? k : -1)).filter((k) => k >= 0) : []));
  for (let k = 0; k < n; k++) {
    let best = -1;
    let bestKey = Infinity;
    for (let j = 0; j < streams.length; j++) {
      if (pos[j]! >= streams[j]!.count) continue;
      if (before[j]!.some((e) => pos[e]! < streams[e]!.count)) continue;
      const t = streams[j]!.key(pos[j]!);
      if (best < 0 || t < bestKey) { best = j; bestKey = t; }
    }
    s[k] = best;
    ix[k] = pos[best]!++;
  }
  return { s, i: ix, n };
}

/**
 * Where records `ids` sit in the merged order: the first and the last of them, or -1. Each id is
 * looked up in its own stream, so no id string is built per record.
 */
function positionsOf(streams: readonly Stream[], all: ReturnType<typeof merge>, ids: readonly string[]): { first: number; last: number } {
  const want = new Set<number>();
  for (const id of ids) {
    for (let j = 0; j < streams.length; j++) {
      const i = streams[j]!.indexOfId(id);
      if (i >= 0) { want.add(j * 2 ** 32 + i); break; }
    }
  }
  let first = -1;
  let last = -1;
  if (!want.size) return { first, last };
  for (let k = 0; k < all.n; k++) {
    if (!want.has(all.s[k]! * 2 ** 32 + all.i[k]!)) continue;
    if (first < 0) first = k;
    last = k;
  }
  return { first, last };
}

function filesInfo(browserDevices: number): LogFilesInfo {
  let ppmLogBytes = 0;
  try { ppmLogBytes = statSync(ppmLogPath()).size; } catch { /* no log yet */ }
  let rotatedFiles = 0;
  for (const path of ppmLogFiles()) {
    if (path === ppmLogPath()) continue;
    try { statSync(path); rotatedFiles++; } catch { /* not there */ }
  }
  let cfBytes = 0;
  let cfPath: string | null = null;
  try { cfBytes = statSync(cloudflaredLogPath()).size; cfPath = displayPath(cloudflaredLogPath()); } catch { /* no tunnel log */ }
  return {
    ppmLogPath: displayPath(ppmLogPath()),
    ppmLogBytes,
    capBytes: MAX_LOG_BYTES,
    generations: LOG_GENERATIONS,
    rotatedFiles,
    cloudflaredPath: cfPath,
    cloudflaredBytes: cfBytes,
    browserDevices,
    browserRetentionDays: configService.get("session_trace")?.retention_days ?? 30,
  };
}

/**
 * One page of records for the Logs window: the newest `limit` that pass the filter (before
 * `before`, when paging back), plus the per-source counts the sidebar shows and the chats in
 * range for the chat menu.
 */
export async function queryLogs(p: LogQueryParams, signal?: AbortSignal): Promise<LogQueryResult> {
  const fromTs = p.range === "restart" ? await lastRestart() : p.range === "all" ? 0 : Math.max(0, p.from);
  const { streams } = await openStreams(fromTs);
  const all = merge(streams);
  const at = (k: number) => streams[all.s[k]!]!;
  const limit = Math.max(1, Math.min(MAX_PAGE, p.limit));

  // Sidebar counts, chats and restarts: over the whole range, before any filter.
  const stats = emptySourceStats();
  const tagCounts = LOG_SOURCE_IDS.map(() => new Map<number, number>());
  const chatCounts = new Map<number, { count: number; last: number }>();
  const restarts: number[] = [];
  const devices = new Set<number>();
  for (let k = 0; k < all.n; k++) {
    const st = at(k);
    const i = all.i[k]!;
    const src = st.src(i);
    const s = stats[LOG_SOURCE_IDS[src]!];
    s.total++;
    const lv = st.lv(i);
    if (lv >= LEVEL_INDEX.error) s.err++;
    else if (lv === LEVEL_INDEX.warn) s.warn++;
    const tm = tagCounts[src]!;
    const tag = st.tag(i);
    tm.set(tag, (tm.get(tag) ?? 0) + 1);
    if (src === SOURCE_INDEX.browser) devices.add(tag);
    const sid = st.sid(i);
    if (sid >= 0) {
      const c = chatCounts.get(sid);
      if (c) { c.count++; c.last = st.ts(i); } else chatCounts.set(sid, { count: 1, last: st.ts(i) });
    }
    if (st.flags(i) & FLAG_RESTART) restarts.push(st.ts(i));
  }
  LOG_SOURCE_IDS.forEach((id, n) => {
    stats[id].tags = [...tagCounts[n]!].map(([t, c]) => [tagTable.values[t]!, c] as [string, number]).sort((a, b) => b[1] - a[1]);
  });
  const chats: LogChatInfo[] = [...chatCounts]
    .map(([sid, c]) => ({ sid: sidTable.values[sid]!, title: null as string | null, count: c.count, last: c.last }))
    .sort((a, b) => b.last - a.last)
    .slice(0, 40);

  // Cheap filters first, on the columns.
  const wantSrc = p.src === "all" ? -1 : SOURCE_INDEX[p.src];
  const levelOn = [p.levels.debug, p.levels.info, p.levels.warn, p.levels.error, p.levels.error];
  const tagsOff = new Set<string>(p.tagsOff);
  const wantSid = p.chat ? sidTable.find(p.chat) ?? -2 : -1;
  let beforePos = all.n;
  if (p.before) {
    const k = positionsOf(streams, all, [p.before]).first;
    if (k >= 0) beforePos = k;
  }
  const candidates: number[] = [];
  let inRange = 0;
  for (let k = 0; k < all.n; k++) {
    const st = at(k);
    const i = all.i[k]!;
    const src = st.src(i);
    if (wantSrc >= 0 && src !== wantSrc) continue;
    inRange++;
    if (!levelOn[st.lv(i)]) continue;
    if (tagsOff.size && tagsOff.has(`${LOG_SOURCE_IDS[src]}:${tagTable.values[st.tag(i)]}`)) continue;
    if (wantSid !== -1 && st.sid(i) !== wantSid) continue;
    candidates.push(k);
  }

  const search = compileLogSearch(p);
  const titleIds = new Set<string>(chats.map((c) => c.sid));
  let titles: Record<string, string> = {};
  try { titles = getSessionTitles([...titleIds]); } catch { /* no database: ids stand in for titles */ }

  let matchedPositions: number[];
  let pageEntries: LogEntry[] | null = null;
  let searched: Array<{ k: number; e: LogEntry }> | null = null;
  if (search === undefined) {
    matchedPositions = [];
  } else if (search === null) {
    matchedPositions = candidates;
  } else {
    // Text is needed: read it per stream in runs, newest first, keeping the page as we go.
    matchedPositions = [];
    const keep: Array<{ k: number; e: LogEntry }> = [];
    const perStream = new Map<number, number[]>();
    for (const k of candidates) {
      const arr = perStream.get(all.s[k]!);
      if (arr) arr.push(k); else perStream.set(all.s[k]!, [k]);
    }
    let sinceYield = 0;
    for (const [sIdx, ks] of perStream) {
      const st = streams[sIdx]!;
      for (let a = 0; a < ks.length; a += 1000) {
        const chunk = ks.slice(a, a + 1000);
        const entries = st.entries(chunk.map((k) => all.i[k]!));
        // `entries` drops unreadable records, so match them back by id.
        const byId = new Map(entries.map((e) => [e.id, e]));
        for (const k of chunk) {
          const e = byId.get(st.id(all.i[k]!));
          if (!e) continue;
          if (!search.test(logSearchText(e, titles))) continue;
          matchedPositions.push(k);
          keep.push({ k, e });
        }
        sinceYield += chunk.length;
        if (sinceYield >= SEARCH_YIELD_EVERY) {
          sinceYield = 0;
          await yieldToLoop();
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        }
      }
    }
    matchedPositions.sort((a, b) => a - b);
    keep.sort((a, b) => a.k - b.k);
    searched = keep;
  }

  const beforeMatches = matchedPositions.filter((k) => k < beforePos);
  let pageSize = limit;
  let reachMissed: "gone" | "far" | undefined;
  if (p.reach) {
    const kr = positionsOf(streams, all, [p.reach]).first;
    if (kr < 0) {
      reachMissed = "gone";
    } else {
      let need = 0;
      for (let a = beforeMatches.length - 1; a >= 0 && beforeMatches[a]! >= kr; a--) need++;
      pageSize = Math.max(limit, need + REACH_CONTEXT);
      if (pageSize > MAX_REACH) {
        pageSize = MAX_REACH;
        reachMissed = "far";
      }
    }
  }
  const pagePositions = beforeMatches.slice(-pageSize);
  if (searched) pageEntries = searched.filter((x) => x.k < beforePos).slice(-pageSize).map((x) => x.e);
  if (!pageEntries) {
    // Read the page's text, grouped per stream, then put it back in merged order.
    const perStream = new Map<number, number[]>();
    for (const k of pagePositions) {
      const arr = perStream.get(all.s[k]!);
      if (arr) arr.push(k); else perStream.set(all.s[k]!, [k]);
    }
    const byPos = new Map<number, LogEntry>();
    for (const [sIdx, ks] of perStream) {
      const st = streams[sIdx]!;
      const entries = st.entries(ks.map((k) => all.i[k]!));
      const byId = new Map(entries.map((e) => [e.id, e]));
      for (const k of ks) {
        const e = byId.get(st.id(all.i[k]!));
        if (e) byPos.set(k, e);
      }
    }
    pageEntries = pagePositions.map((k) => byPos.get(k)).filter((e): e is LogEntry => !!e);
  }

  const missing = new Set<string>();
  for (const e of pageEntries) if (e.sid && !(e.sid in titles)) missing.add(e.sid);
  if (missing.size) {
    try { Object.assign(titles, getSessionTitles([...missing])); } catch { /* ids stand in */ }
  }
  for (const c of chats) c.title = titles[c.sid] ?? null;

  return {
    entries: pageEntries,
    matched: matchedPositions.length,
    inRange,
    hasMore: beforeMatches.length > pagePositions.length,
    stats,
    chats,
    titles,
    restarts,
    fromTs,
    files: filesInfo(devices.size),
    ...(search === undefined ? { badRegex: true } : {}),
    ...(reachMissed ? { reachMissed } : {}),
  };
}

/** Records `ids` wherever they are kept, plus `around` records of the same source each side. */
export async function readAround(ids: readonly string[], around: number, src: LogSourceId | "all"): Promise<{ before: LogEntry[]; after: LogEntry[] }> {
  if (!ids.length || around <= 0) return { before: [], after: [] };
  const { streams } = await openStreams(0);
  const all = merge(streams);
  const at = (k: number) => streams[all.s[k]!]!;
  const { first, last } = positionsOf(streams, all, ids);
  if (first < 0) return { before: [], after: [] };
  const wantSrc = src === "all" ? -1 : SOURCE_INDEX[src];
  const pick = (from: number, step: 1 | -1): number[] => {
    const out: number[] = [];
    for (let k = from; k >= 0 && k < all.n && out.length < around; k += step) {
      if (wantSrc >= 0 && at(k).src(all.i[k]!) !== wantSrc) continue;
      out.push(k);
    }
    return step === -1 ? out.reverse() : out;
  };
  const read = (ks: number[]): LogEntry[] => {
    const out: LogEntry[] = [];
    for (const k of ks) out.push(...at(k).entries([all.i[k]!]));
    return out;
  };
  return { before: read(pick(first - 1, -1)), after: read(pick(last + 1, 1)) };
}

/** Errors and warnings from `from` on, every source, for the issue grouping. */
export async function readProblems(from: number): Promise<LogEntry[]> {
  const { streams } = await openStreams(from);
  const all = merge(streams);
  const out: LogEntry[] = [];
  const perStream = new Map<number, number[]>();
  for (let k = 0; k < all.n; k++) {
    const st = streams[all.s[k]!]!;
    const i = all.i[k]!;
    if (st.lv(i) < LEVEL_INDEX.warn) continue;
    const arr = perStream.get(all.s[k]!);
    if (arr) arr.push(i); else perStream.set(all.s[k]!, [i]);
  }
  for (const [sIdx, is] of perStream) {
    const st = streams[sIdx]!;
    for (let a = 0; a < is.length; a += 2000) {
      out.push(...st.entries(is.slice(a, a + 2000)));
      await yieldToLoop();
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * The live tail's cursor: what has been appended to each source since the last call. The first
 * call only takes the current ends and returns nothing.
 */
export interface TailCursor {
  liveOffsetGen: string;
  liveCount: number;
  cfGen: string;
  cfCount: number;
  browserRowid: number;
}

export async function readNewEntries(cursor: TailCursor | null, lastRowid: () => number): Promise<{ cursor: TailCursor; entries: LogEntry[] }> {
  const live = await indexFor(ppmLogPath());
  const cf = await cloudflaredFor();
  const next: TailCursor = {
    liveOffsetGen: live?.gen ?? "",
    liveCount: live?.count ?? 0,
    cfGen: cf?.gen ?? "",
    cfCount: cf?.count ?? 0,
    browserRowid: cursor?.browserRowid ?? 0,
  };
  if (!cursor) {
    try { next.browserRowid = lastRowid(); } catch { /* no trace database */ }
    return { cursor: next, entries: [] };
  }
  const entries: LogEntry[] = [];
  if (live) {
    const from = live.gen === cursor.liveOffsetGen ? cursor.liveCount : 0;
    if (live.count > from) entries.push(...live.readEntries(range(from, live.count)));
  }
  if (cf) {
    const from = cf.gen === cursor.cfGen ? cursor.cfCount : 0;
    if (cf.count > from) entries.push(...cf.readEntries(range(from, cf.count)));
  }
  try {
    const rows = readBrowserRows({ afterRowid: cursor.browserRowid, limit: 2000 });
    if (rows.length) {
      next.browserRowid = rows[rows.length - 1]!.rowid;
      entries.push(...browserEntries(rows));
    }
  } catch { /* no trace database */ }
  entries.sort((a, b) => a.ts - b.ts);
  return { cursor: next, entries };
}

function range(a: number, b: number): number[] {
  const out = new Array<number>(Math.max(0, b - a));
  for (let i = a; i < b; i++) out[i - a] = i;
  return out;
}

/** Tests only. */
export function _resetLogStoreForTests(): void {
  byIno.clear();
  liveIndex = null;
  cloudflaredIndex = null;
  for (const t of dropTimers.values()) clearTimeout(t);
  dropTimers.clear();
}

/** When PPM started again since `from`, from the supervisor's own lines. */
export async function restartTimes(from: number): Promise<number[]> {
  const out: number[] = [];
  for (const path of ppmLogFiles()) {
    let st;
    try { st = statSync(path); } catch { continue; }
    if (path !== ppmLogPath() && st.mtimeMs < from) continue;
    const f = await indexFor(path);
    if (!f) continue;
    for (let i = f.cols.lowerBound(from); i < f.count; i++) if (f.cols.flags[i]! & FLAG_RESTART) out.push(f.cols.ts[i]!);
  }
  return out;
}
