/**
 * The Logs window's data model, shared by the server (which reads the files) and the browser
 * (which filters live lines with the same predicate the server used for the page).
 *
 * One `LogEntry` is one record: a `ppm.log` line with its continuation lines (a stack trace, a
 * multi-line message), a `cloudflared.log` line, or one browser console call. Every `ppm.log`
 * scope is put in one of six areas by `AREA_BY_TAG`; cloudflared and the browsers are areas of
 * their own. A scope missing from the table lands in Server, so a new `createLogger("x")` is
 * never invisible — it only shows up in the wrong place until it is added here.
 */
import type { LogLevel } from "./log-levels.ts";

export type { LogLevel } from "./log-levels.ts";

export const LOG_SOURCE_IDS = ["ai", "shell", "server", "ext", "files", "auto", "tunnel", "browser"] as const;
export type LogSourceId = (typeof LOG_SOURCE_IDS)[number];

export interface LogSourceInfo {
  id: LogSourceId;
  label: string;
  /** Which heading the source sits under in the sidebar. */
  group: "ppm" | "elsewhere";
}

export const LOG_SOURCES: readonly LogSourceInfo[] = [
  { id: "ai", label: "AI & chat", group: "ppm" },
  { id: "shell", label: "Shell & tools", group: "ppm" },
  { id: "server", label: "Server", group: "ppm" },
  { id: "ext", label: "Extensions", group: "ppm" },
  { id: "files", label: "Files", group: "ppm" },
  { id: "auto", label: "Automation", group: "ppm" },
  { id: "tunnel", label: "Tunnel", group: "elsewhere" },
  { id: "browser", label: "Browser", group: "elsewhere" },
];

export function logSourceLabel(id: LogSourceId | "all"): string {
  if (id === "all") return "All sources";
  return LOG_SOURCES.find((s) => s.id === id)?.label ?? id;
}

/** `ppm.log` scope → area. Anything not listed is Server. */
export const AREA_BY_TAG: Readonly<Record<string, LogSourceId>> = {
  // AI & chat
  sdk: "ai", chat: "ai", usage: "ai", accounts: "ai", codex: "ai", registry: "ai", "nested-spy": "ai",
  proxy: "ai", "chat-prepare": "ai", "group-chat": "ai", mcp: "ai", "mcp-oauth": "ai", "mcp-control": "ai",
  "design-mcp": "ai", design: "ai", "session-review": "ai", whisper: "ai",
  // Shell & tools
  "bash-spy": "shell", "bg-shell": "shell", "session-baselines": "shell", terminal: "shell", spawn: "shell",
  // Extensions and the editor's language servers
  ExtService: "ext", ExtWS: "ext", ext: "ext", RPC: "ext", lsp: "ext",
  // Files
  "file-watcher": "files", "file-index": "files", fs: "files", git: "files", transcode: "files",
  // Automation
  scheduler: "auto", ppmbot: "auto", "ppmbot-stream": "auto", jira: "auto", "jira-debug": "auto",
  telegram: "auto", notify: "auto", "web-push": "auto",
  // PPM's own side of remote access, next to cloudflared's file
  tunnel: "tunnel", tunnels: "tunnel", "named-tunnel": "tunnel", cloudflared: "tunnel", tailscale: "tunnel",
  cloud: "tunnel", "cloud-ws": "tunnel", preview: "tunnel",
};

export function areaOfTag(tag: string): LogSourceId {
  return AREA_BY_TAG[tag] ?? "server";
}

/** Tag given to a record that carried no `[scope]`, and to raw stderr a process printed. */
export const UNTAGGED = "ppm";
export const STDERR_TAG = "stderr";

export interface LogEntry {
  /** Stable for the life of the record: file generation + byte offset, or the browser row id. */
  id: string;
  /** Epoch ms, UTC. */
  ts: number;
  lv: LogLevel;
  src: LogSourceId;
  tag: string;
  /** The first line of the message. */
  msg: string;
  /** Continuation lines, as written. */
  more?: string[];
  /** The chat this record names (`session=<uuid>`), if any. */
  sid?: string;
}

export const LOG_RANGES = ["15m", "1h", "restart", "today", "all"] as const;
export type LogRange = (typeof LOG_RANGES)[number];

export const LOG_RANGE_LABELS: Readonly<Record<LogRange, string>> = {
  "15m": "Last 15 minutes",
  "1h": "Last hour",
  restart: "Since the restart",
  today: "Today",
  all: "Everything kept",
};

export interface LogFilter {
  src: LogSourceId | "all";
  levels: Readonly<Record<"error" | "warn" | "info" | "debug", boolean>>;
  /** `"<src>:<tag>"` pairs switched off in the tag bar. */
  tagsOff: readonly string[];
  q: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Only records naming this chat. */
  chat: string | null;
}

export const DEFAULT_LOG_FILTER: LogFilter = {
  src: "all",
  levels: { error: true, warn: true, info: true, debug: false },
  tagsOff: [],
  q: "",
  regex: false,
  caseSensitive: false,
  chat: null,
};

/** A FATAL record is shown, counted and filtered as an error. */
export function levelBucket(lv: LogLevel): "error" | "warn" | "info" | "debug" {
  return lv === "fatal" ? "error" : lv;
}

/** The search as a RegExp, or `null` for no search; `undefined` when a regex does not compile. */
export function compileLogSearch(filter: Pick<LogFilter, "q" | "regex" | "caseSensitive">): RegExp | null | undefined {
  if (!filter.q) return null;
  try {
    const source = filter.regex ? filter.q : filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(source, filter.caseSensitive ? "" : "i");
  } catch {
    return undefined;
  }
}

/** What a search looks through: the message, its tag, and every continuation line. */
export function logSearchText(entry: LogEntry, titles?: Readonly<Record<string, string>>): string {
  const title = entry.sid && titles?.[entry.sid] ? ` ${titles[entry.sid]}` : "";
  return `${entry.tag} ${entry.msg}${title}${entry.more?.length ? `\n${entry.more.join("\n")}` : ""}`;
}

/**
 * Whether a record passes the filter. `search` is `compileLogSearch(filter)`, passed in so a
 * page of records compiles it once; a regex that does not compile matches nothing.
 */
export function matchesLogFilter(
  entry: LogEntry,
  filter: LogFilter,
  search: RegExp | null | undefined,
  titles?: Readonly<Record<string, string>>,
): boolean {
  if (filter.src !== "all" && entry.src !== filter.src) return false;
  if (!filter.levels[levelBucket(entry.lv)]) return false;
  if (filter.tagsOff.length && filter.tagsOff.includes(`${entry.src}:${entry.tag}`)) return false;
  if (filter.chat && entry.sid !== filter.chat) return false;
  if (search === undefined) return false;
  if (search && !search.test(logSearchText(entry, titles))) return false;
  return true;
}

const SESSION_RE = /\bsession=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

export function sessionIdOf(msg: string): string | undefined {
  return SESSION_RE.exec(msg)?.[1];
}

export interface LogSourceStats {
  total: number;
  err: number;
  warn: number;
  /** Lines per tag, most first. */
  tags: Array<[string, number]>;
}

export function emptySourceStats(): Record<LogSourceId, LogSourceStats> {
  const out = {} as Record<LogSourceId, LogSourceStats>;
  for (const id of LOG_SOURCE_IDS) out[id] = { total: 0, err: 0, warn: 0, tags: [] };
  return out;
}

/** Per-source totals over a set of records, independent of the level/search filter. */
export function computeSourceStats(entries: Iterable<LogEntry>): Record<LogSourceId, LogSourceStats> {
  const out = emptySourceStats();
  const tags = new Map<LogSourceId, Map<string, number>>();
  for (const e of entries) {
    const s = out[e.src];
    s.total++;
    const b = levelBucket(e.lv);
    if (b === "error") s.err++;
    else if (b === "warn") s.warn++;
    let m = tags.get(e.src);
    if (!m) tags.set(e.src, (m = new Map()));
    m.set(e.tag, (m.get(e.tag) ?? 0) + 1);
  }
  for (const [src, m] of tags) out[src].tags = [...m].sort((a, b) => b[1] - a[1]);
  return out;
}

/** Adds records arriving live to stats computed earlier, in place. */
export function addToSourceStats(stats: Record<LogSourceId, LogSourceStats>, entries: readonly LogEntry[]): void {
  for (const e of entries) {
    const s = stats[e.src];
    s.total++;
    const b = levelBucket(e.lv);
    if (b === "error") s.err++;
    else if (b === "warn") s.warn++;
    const t = s.tags.find((x) => x[0] === e.tag);
    if (t) t[1]++;
    else s.tags.push([e.tag, 1]);
  }
}

/** A record as it reads in the file, which is what Copy, Download and a report carry. */
export function rawLogLine(entry: LogEntry, repeats = 0): string {
  const iso = new Date(entry.ts).toISOString();
  const head = entry.src === "tunnel" && entry.tag === "cloudflared"
    ? `${iso.slice(0, 19)}Z ${CLOUDFLARED_LEVEL[entry.lv]} ${entry.msg}`
    : `[${iso}] [${entry.lv.toUpperCase()}] [${entry.tag}] ${entry.msg}`;
  const rep = repeats > 1 ? ` [x${repeats}]` : "";
  return `${head}${rep}${entry.more?.length ? `\n${entry.more.join("\n")}` : ""}`;
}

const CLOUDFLARED_LEVEL: Readonly<Record<LogLevel, string>> = { debug: "DBG", info: "INF", warn: "WRN", error: "ERR", fatal: "FTL" };

/**
 * Two records that read the same apart from their time. The viewer folds a run of them into
 * one row with a count, so 48 copies of a warning take one line.
 */
export function sameLogRecord(a: LogEntry, b: LogEntry): boolean {
  return a.src === b.src && a.lv === b.lv && a.tag === b.tag && a.msg === b.msg
    && (a.more?.length ?? 0) === 0 && (b.more?.length ?? 0) === 0;
}
