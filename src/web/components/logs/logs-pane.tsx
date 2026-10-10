/**
 * The Logs list on a desktop: sources down the side, the filter row, and the records as a
 * virtualised list you select like files — click, Shift-click, Ctrl-click, drag, the arrow keys —
 * with the terminal's Add to chat group under the selection.
 *
 * The list follows new lines while it is scrolled to the end and stops the moment the person
 * scrolls up; what arrives meanwhile is counted on a "N new lines" pill. Rows are placed in
 * normal flow inside a shifted block rather than absolutely, so the widest row still sets the
 * scroll width when long lines are not wrapped.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown, ArrowDownToLine, CaseSensitive, Check, ChevronDown, ClipboardList, Clock, Copy, Download, Layers,
  Loader2, MessageSquare, MessageSquarePlus, MoreHorizontal, Pause, Play, RefreshCw, Regex, Search, Settings,
  WrapText,
} from "@/lib/icons";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { tabSessionId } from "@/lib/tab-session-id";
import { useSettingsStore } from "@/stores/settings-store";
import {
  byteSize, clockTime, hitPattern, localOffsetLabel, plural, restartDividers, shortCount, type LogRow,
} from "@/lib/logs/logs-view-model";
import {
  LOG_RANGES, LOG_RANGE_LABELS, LOG_SOURCES, compileLogSearch, levelBucket, logSourceLabel, type LogFilter,
  type LogSourceId, type LogSourceStats,
} from "../../../shared/logs-model";
import type { LogFilesInfo } from "../../../shared/logs-api";
import { copyRows, currentChatTab, downloadRows, recordCount, rowsToChat, rowsToReport } from "./logs-actions";
import { LEVEL_TEXT, Hits, MessageText, SOURCE_ICONS } from "./logs-ui";
import { useFollowList } from "./use-follow-list";
import {
  NO_SELECTION, filterChanged, selectOne, selectTo, selectedRows, toggleOne, type LogsPaneProps,
} from "./logs-state";

/** terminal/terminal-selection-chat.tsx, one button of its group. */
const SELBTN = "flex items-center gap-1 whitespace-nowrap rounded bg-surface-elevated text-text-primary transition-colors hover:bg-primary hover:text-primary-foreground active:bg-primary active:text-primary-foreground px-2 py-0.5 text-xs";

/** Batches up to this size flash their rows; a flood would only blink. */
const FLASH_MAX = 5;

const SOURCE_SUB: Readonly<Record<LogSourceId, string>> = {
  ai: "sdk, chat, usage, accounts",
  shell: "bash-spy, bg-shell, terminal",
  server: "supervisor, startup, stderr",
  ext: "extensions, language servers",
  files: "file-watcher, file-index, git",
  auto: "scheduler, assistant-telegram, jira",
  tunnel: "cloudflared.log",
  browser: "Console",
};

type ListItem = { kind: "div"; key: string; at: number } | { kind: "row"; key: string; row: LogRow };

function sumStats(stats: Record<LogSourceId, LogSourceStats> | undefined, src: LogSourceId | "all") {
  if (!stats) return { total: 0, err: 0, warn: 0 };
  if (src !== "all") return stats[src];
  return Object.values(stats).reduce((a, s) => ({ total: a.total + s.total, err: a.err + s.err, warn: a.warn + s.warn }), { total: 0, err: 0, warn: 0 });
}

function sourceSub(id: LogSourceId, stats: Record<LogSourceId, LogSourceStats> | undefined, files: LogFilesInfo | undefined): string {
  if (id === "tunnel") return "cloudflared.log";
  if (id === "browser") return files ? `Console · ${plural(files.browserDevices, "device")}` : SOURCE_SUB.browser;
  const tags = stats?.[id]?.tags.slice(0, 3).map((t) => t[0]);
  return tags?.length ? tags.join(", ") : SOURCE_SUB[id];
}

function footFile(src: LogSourceId | "all", files: LogFilesInfo | undefined): string {
  if (!files) return "";
  if (src === "all") return `ppm.log, cloudflared.log, ${plural(files.browserDevices, "browser")}`;
  if (src === "tunnel") return files.cloudflaredPath ? `cloudflared.log · ${byteSize(files.cloudflaredBytes)}` : "no cloudflared.log yet";
  if (src === "browser") return `browser consoles · ${plural(files.browserDevices, "device")}`;
  return `ppm.log · ${byteSize(files.ppmLogBytes)}`;
}

function SideNote({ src, files }: { src: LogSourceId | "all"; files: LogFilesInfo }) {
  if (src === "tunnel") {
    return files.cloudflaredPath
      ? <><b>{files.cloudflaredPath}</b><br />Written by cloudflared itself, to the second.</>
      : <>No cloudflared.log yet. It appears once a tunnel has run.</>;
  }
  if (src === "browser") return <><b>Browser consoles</b><br />Sent by every open PPM tab and kept {plural(files.browserRetentionDays, "day")}.</>;
  if (src === "all") {
    return <><b>{files.ppmLogPath}</b> and its {plural(files.rotatedFiles, "older file")}, <b>cloudflared.log</b> and {plural(files.browserDevices, "browser")}, merged by time.</>;
  }
  return <><b>{files.ppmLogPath}</b><br />{byteSize(files.ppmLogBytes)} of {byteSize(files.capBytes)}. When full it becomes ppm.log.1; {files.generations} files are kept.</>;
}


interface RowViewProps {
  row: LogRow;
  index: number;
  selected: boolean;
  cursor: boolean;
  flash: boolean;
  open: boolean;
  utc: boolean;
  re: RegExp | null;
  titles: Readonly<Record<string, string>>;
  onChat(sid: string): void;
  onToggleMore(key: string): void;
  measure(node: Element | null): void;
}

const RowView = memo(function RowView({ row, index, selected, cursor, flash, open, utc, re, titles, onChat, onToggleMore, measure }: RowViewProps) {
  const e = row.entry;
  const more = e.more?.length ?? 0;
  return (
    <div
      ref={measure}
      data-index={index}
      data-key={row.key}
      role="option"
      aria-selected={selected}
      className={cn("lg-row", levelBucket(e.lv) === "error" && "err", selected && "sel", cursor && "cur", flash && "flash")}
    >
      <span className="lg-mark" />
      <span className="lg-t">{clockTime(e.ts, utc)}</span>
      <span className={`lg-lv ${e.lv}`}>{LEVEL_TEXT[e.lv]}</span>
      <span className="lg-tg" title={e.tag}>{e.tag}</span>
      <span className="lg-m">
        <MessageText msg={e.msg} re={re} titles={titles} onChat={onChat} />
        {row.count > 1 && <span className="lg-x" title={`The same line ${row.count} times in a row`}>×{row.count.toLocaleString("en-US")}</span>}
        {more > 0 && (
          <button type="button" className="lg-pchip" onClick={() => onToggleMore(row.key)}>
            {open ? "Hide lines" : `+${plural(more, "line")}`}
          </button>
        )}
      </span>
      {open && more > 0 && <div className="lg-more"><Hits text={e.more!.join("\n")} re={re} /></div>}
    </div>
  );
});

function LevelChip({ lv, cls, label, n, filter, setFilter }: {
  lv: keyof LogFilter["levels"];
  cls?: string;
  label: string;
  n?: number;
  filter: LogFilter;
  setFilter: LogsPaneProps["setFilter"];
}) {
  return (
    <button
      type="button"
      className={cn("lg-chip", cls)}
      aria-pressed={filter.levels[lv]}
      onClick={() => setFilter({ levels: { ...filter.levels, [lv]: !filter.levels[lv] } })}
    >
      <span className="dot" />
      {label}
      {n != null && <span className="n">{shortCount(n)}</span>}
    </button>
  );
}

export function LogsPane(p: LogsPaneProps) {
  const { feed, rows, filter, setFilter, range, setRange, sel, setSel, follow, setFollow, paused, setPaused, utc, wrap } = p;
  const meta = feed.meta;
  const setLogsWrap = useSettingsStore((s) => s.setLogsWrap);
  const listRef = useRef<HTMLDivElement>(null);
  const rowsBoxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const anchorKey = useRef<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [dragging, setDragging] = useState(false);
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set());

  const search = useMemo(() => compileLogSearch(filter), [filter]);
  const re = useMemo(() => hitPattern(search), [search]);
  const titles = useMemo(() => meta?.titles ?? {}, [meta?.titles]);
  const restarts = meta?.restarts;
  const items = useMemo<ListItem[]>(() => {
    const dividers = restartDividers(rows, restarts ?? []);
    const out: ListItem[] = [];
    for (const row of rows) {
      const at = dividers.get(row.key);
      if (at != null) out.push({ kind: "div", key: `restart-${at}`, at });
      out.push({ kind: "row", key: row.key, row });
    }
    return out;
  }, [rows, restarts]);
  const indexOf = useMemo(() => new Map(items.map((it, i) => [it.key, i])), [items]);
  const rowKeys = useMemo(() => rows.map((r) => r.key), [rows]);
  const selected = useMemo(() => selectedRows(rows, sel), [rows, sel]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => (items[i]?.kind === "div" ? 32 : 20),
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 24,
    paddingStart: 4,
    paddingEnd: 64,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const { newCount, onScroll: followScroll, ownScroll } = useFollowList(listRef, {
    follow, setFollow, feed, size: totalSize + items.length, virtualizer, keep: p.listTop,
  });

  // A different filter is a different list: no row in it is expanded yet.
  useEffect(() => setOpen(new Set()), [feed.key]);

  // A few lines at a time flash as they arrive; a flood would only blink.
  const batch = feed.batch;
  useEffect(() => {
    if (!batch || batch.count > FLASH_MAX) return;
    const ids = new Set(feed.entries.slice(-batch.count).map((e) => e.id));
    const keys = new Set<string>();
    for (let i = rows.length - 1; i >= 0 && keys.size < batch.count; i--) {
      if (rows[i]!.ids.some((id) => ids.has(id))) keys.add(rows[i]!.key);
      else if (keys.size) break;
    }
    setFlash(keys);
    const t = setTimeout(() => setFlash(new Set()), 1200);
    return () => clearTimeout(t);
    // Only a new batch counts; `rows` and `entries` are read as they are at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.seq]);

  // Show in Logs: bring the first picked row into view, and keep the list from following away.
  const reveal = p.reveal;
  useLayoutEffect(() => {
    if (!reveal) return;
    const i = indexOf.get(reveal.key);
    if (i == null) return;
    ownScroll(600);
    virtualizer.scrollToIndex(i, { align: "center" });
    listRef.current?.focus({ preventScroll: true });
    // A reveal is acted on once, when it is asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);

  // Load earlier keeps the row that was first where it was, rather than jumping to the top.
  useLayoutEffect(() => {
    const key = anchorKey.current;
    if (!key) return;
    const i = indexOf.get(key);
    if (i == null || i === 0) return;
    anchorKey.current = null;
    ownScroll();
    virtualizer.scrollToIndex(i, { align: "start" });
  }, [indexOf, virtualizer, ownScroll]);

  const loadEarlier = useCallback(async () => {
    setFollow(false);
    anchorKey.current = rowKeys[0] ?? null;
    if (!(await feed.loadEarlier())) anchorKey.current = null;
  }, [feed, rowKeys, setFollow]);

  // The selection's actions sit under its last row, or over its first when there is no room.
  const placeBar = useCallback(() => {
    const bar = barRef.current;
    const list = listRef.current;
    const box = rowsBoxRef.current;
    if (!bar || !list || !box || !selected.length) return;
    const first = indexOf.get(selected[0]!.key);
    const last = indexOf.get(selected[selected.length - 1]!.key);
    const ms = virtualizer.measurementsCache;
    const a = first == null ? undefined : ms[first];
    const b = last == null ? undefined : ms[last];
    if (!a || !b) return;
    const h = bar.offsetHeight;
    const w = bar.offsetWidth;
    let top = b.end + 4;
    if (top + h > list.scrollTop + list.clientHeight && a.start - h - 4 >= list.scrollTop) top = a.start - h - 4;
    const msg = box.querySelector(".lg-m");
    const msgLeft = msg ? msg.getBoundingClientRect().left - box.getBoundingClientRect().left : 0;
    const left = Math.max(list.scrollLeft + 6, Math.min(msgLeft, list.scrollLeft + list.clientWidth - w - 6));
    bar.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${Math.round(top)}px)`;
  }, [selected, indexOf, virtualizer]);

  useLayoutEffect(() => {
    placeBar();
  });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(() => placeBar());
    ro.observe(list);
    return () => ro.disconnect();
  }, [placeBar]);

  const onScroll = () => {
    placeBar();
    followScroll();
  };

  // Click, Shift-click, Ctrl-click and drag, like rows in a file manager.
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const rowEl = target.closest<HTMLElement>(".lg-row");
    if (!rowEl || target.closest("button, a")) return;
    const key = rowEl.dataset.key;
    if (!key) return;
    e.preventDefault();
    listRef.current?.focus({ preventScroll: true });
    if (e.shiftKey && sel.anchor) setSel(selectTo(sel, rowKeys, key, e.ctrlKey || e.metaKey));
    else if (e.ctrlKey || e.metaKey) setSel(toggleOne(sel, key));
    else if (sel.keys.size === 1 && sel.keys.has(key)) setSel({ keys: new Set(), anchor: key, cursor: key });
    else {
      setSel(selectOne(key));
      setDragging(true);
    }
  };

  const onMouseOver = (e: React.MouseEvent) => {
    if (!dragging) return;
    const key = (e.target as Element).closest<HTMLElement>(".lg-row")?.dataset.key;
    if (key && key !== sel.cursor) setSel(selectTo(sel, rowKeys, key));
  };

  useEffect(() => {
    if (!dragging) return;
    const doc = listRef.current?.ownerDocument ?? document;
    const end = () => setDragging(false);
    doc.addEventListener("mouseup", end);
    return () => doc.removeEventListener("mouseup", end);
  }, [dragging]);

  const toggleMore = useCallback((key: string) => {
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const filterChat = useCallback((sid: string) => setFilter({ chat: sid }), [setFilter]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (sel.keys.size) {
        e.stopPropagation();
        setSel(NO_SELECTION);
      }
      return;
    }
    if (!rowKeys.length) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      let i = sel.cursor ? rowKeys.indexOf(sel.cursor) : -1;
      i = i < 0 ? (e.key === "ArrowDown" ? 0 : rowKeys.length - 1) : Math.max(0, Math.min(rowKeys.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      const key = rowKeys[i]!;
      if (e.shiftKey) setSel(selectTo(sel.anchor ? sel : { ...sel, anchor: sel.cursor ?? key }, rowKeys, key));
      else setSel({ keys: sel.keys, anchor: sel.keys.size ? sel.anchor : key, cursor: key });
      const at = indexOf.get(key);
      if (at != null) virtualizer.scrollToIndex(at, { align: "auto" });
    } else if (e.key === " " && sel.cursor) {
      e.preventDefault();
      setSel(toggleOne(sel, sel.cursor));
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSel({ keys: new Set(rowKeys), anchor: rowKeys[0]!, cursor: rowKeys[rowKeys.length - 1]! });
    } else if (mod && e.key.toLowerCase() === "c" && selected.length) {
      e.preventDefault();
      void copyRows(selected);
    } else if (e.key === "Enter" && sel.cursor) {
      const row = rows.find((r) => r.key === sel.cursor);
      if (row?.entry.more?.length) toggleMore(row.key);
    }
  };

  const clearSel = () => setSel(NO_SELECTION);
  const counts = sumStats(meta?.stats, filter.src);
  const firstVirtual = virtualItems[0];
  const showBar = selected.length > 0 && !dragging;
  const regexBad = search === undefined || !!meta?.badRegex;
  const chatName = filter.chat ? (titles[filter.chat] ?? filter.chat.slice(0, 8)) : "All chats";
  const tags = filter.src === "all" ? [] : (meta?.stats[filter.src].tags ?? []);
  const off = new Set(filter.tagsOff);
  const lastRestart = range === "restart" ? meta?.fromTs : meta?.restarts.at(-1);

  return (
    <>
      <nav className="lg-side" aria-label="Log sources">
        <SourceButton id="all" label="All sources" sub="ppm.log, cloudflared.log, browsers" stats={sumStats(meta?.stats, "all")} current={filter.src === "all"} onPick={() => setFilter({ src: "all", tagsOff: [] })} />
        <div className="lg-group">Server · ppm.log</div>
        {LOG_SOURCES.filter((s) => s.group === "ppm").map((s) => (
          <SourceButton key={s.id} id={s.id} label={s.label} sub={sourceSub(s.id, meta?.stats, meta?.files)} stats={meta?.stats[s.id]} current={filter.src === s.id} onPick={() => setFilter({ src: s.id, tagsOff: [] })} />
        ))}
        <div className="lg-group">Elsewhere</div>
        {LOG_SOURCES.filter((s) => s.group === "elsewhere").map((s) => (
          <SourceButton key={s.id} id={s.id} label={s.label} sub={sourceSub(s.id, meta?.stats, meta?.files)} stats={meta?.stats[s.id]} current={filter.src === s.id} onPick={() => setFilter({ src: s.id, tagsOff: [] })} />
        ))}
        {meta && <div className="lg-side-file"><SideNote src={filter.src} files={meta.files} /></div>}
      </nav>

      <section className="lg-view" aria-label={logSourceLabel(filter.src)}>
        <div className="lg-tools">
          <div className="lg-search">
            <Search />
            <input
              type="search"
              value={filter.q}
              onChange={(e) => setFilter({ q: e.target.value })}
              placeholder={filter.src === "all" ? "Search all logs" : `Search ${logSourceLabel(filter.src)}`}
              aria-label="Search logs"
              aria-invalid={!!filter.q && regexBad}
              title={!!filter.q && regexBad ? "This regular expression does not compile" : undefined}
            />
            <span className="lg-inl">
              <button type="button" title="Match case" aria-pressed={filter.caseSensitive} onClick={() => setFilter({ caseSensitive: !filter.caseSensitive })}><CaseSensitive /></button>
              <button type="button" title="Regular expression" aria-pressed={filter.regex} onClick={() => setFilter({ regex: !filter.regex })}><Regex /></button>
            </span>
          </div>
          <span className="lg-sep" />
          <LevelChip lv="error" cls="e" label="Errors" n={counts.err} filter={filter} setFilter={setFilter} />
          <LevelChip lv="warn" cls="w" label="Warnings" n={counts.warn} filter={filter} setFilter={setFilter} />
          <LevelChip lv="info" label="Info" filter={filter} setFilter={setFilter} />
          <LevelChip lv="debug" label="Debug" filter={filter} setFilter={setFilter} />
          <span className="lg-sep lg-hide-narrow" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn("lg-ghost", filter.chat && "on")} title={filter.chat ? `Only lines naming ${chatName}` : "Lines from every chat"}>
                <MessageSquare />
                <span className="max-w-[140px] truncate">{chatName}</span>
                <ChevronDown className="chev" />
              </button>
            </DropdownMenuTrigger>
            <ChatMenuContent filter={filter} setFilter={setFilter} chats={meta?.chats ?? []} titles={titles} />
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="lg-ghost">
                <Clock />
                {LOG_RANGE_LABELS[range]}
                <ChevronDown className="chev" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
              {LOG_RANGES.map((r) => (
                <DropdownMenuItem key={r} onSelect={() => setRange(r)}>
                  <span>{LOG_RANGE_LABELS[r]}</span>
                  {range === r ? <Check className="ml-auto" /> : r === "restart" && lastRestart ? (
                    <span className="lg-mi-sub">{clockTime(lastRestart, utc).slice(0, 5)}</span>
                  ) : r === "all" && meta ? <span className="lg-mi-sub">{plural(1 + meta.files.rotatedFiles, "file")}</span> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="lg-fill" />
          {(feed.loading || feed.loadingEarlier) && <span className="lg-busy" aria-label="Reading the logs"><Loader2 className="animate-spin" /></span>}
          <button type="button" className="lg-ibtn" title="Wrap long lines" aria-pressed={wrap} onClick={() => setLogsWrap(!wrap)}><WrapText /></button>
          <button
            type="button"
            className="lg-ibtn"
            title="Follow new lines"
            aria-pressed={follow}
            onClick={() => setFollow(!follow)}
          >
            <ArrowDownToLine />
          </button>
          <button type="button" className="lg-ibtn" title={paused ? "Resume live lines" : "Pause live lines"} aria-pressed={paused} onClick={() => setPaused(!paused)}>
            {paused ? <Play /> : <Pause />}
          </button>
          <button type="button" className="lg-ibtn lg-hide-narrow" title="Download these lines" onClick={() => downloadRows(rows)} disabled={!rows.length}><Download /></button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="lg-ibtn" title="More" aria-label="More"><MoreHorizontal /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem disabled={!rows.length} onSelect={() => void copyRows(rows)}>
                <Copy />Copy visible lines<span className="lg-mi-sub">{recordCount(rows).toLocaleString("en-US")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!rows.length} onSelect={() => downloadRows(rows)}><Download />Download as .log</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => feed.reload()}><RefreshCw />Read again</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={p.togglePrefs}><Settings />Preferences</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {tags.length > 0 && (
          <div className="lg-tagbar">
            <span className="lg-tagbar-lbl">Tags</span>
            {tags.map(([tag, n]) => {
              const k = `${filter.src}:${tag}`;
              return (
                <button
                  key={tag}
                  type="button"
                  className="lg-tag"
                  aria-pressed={!off.has(k)}
                  onClick={() => setFilter({ tagsOff: off.has(k) ? filter.tagsOff.filter((x) => x !== k) : [...filter.tagsOff, k] })}
                >
                  {tag}<span className="n">{shortCount(n)}</span>
                </button>
              );
            })}
          </div>
        )}

        <div
          ref={listRef}
          className={cn("lg-list", wrap && "wrap")}
          tabIndex={0}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Log lines"
          aria-busy={feed.loading}
          onScroll={onScroll}
          onMouseDown={onMouseDown}
          onMouseOver={onMouseOver}
          onKeyDown={onKeyDown}
          data-testid="logs-list"
        >
          {rows.length > 0 ? (
            <div ref={rowsBoxRef} className="lg-rows" style={{ height: totalSize, padding: 0 }}>
              <div style={{ transform: `translateY(${firstVirtual?.start ?? 0}px)` }}>
                {virtualItems.map((vi) => {
                  const it = items[vi.index]!;
                  if (it.kind === "div") {
                    return (
                      <div key={it.key} ref={virtualizer.measureElement} data-index={vi.index} className="lg-div">
                        <RefreshCw />PPM restarted at {clockTime(it.at, utc).slice(0, 8)}
                      </div>
                    );
                  }
                  return (
                    <RowView
                      key={it.key}
                      row={it.row}
                      index={vi.index}
                      selected={sel.keys.has(it.key)}
                      cursor={sel.cursor === it.key}
                      flash={flash.has(it.key)}
                      open={open.has(it.key)}
                      utc={utc}
                      re={re}
                      titles={titles}
                      onChat={filterChat}
                      onToggleMore={toggleMore}
                      measure={virtualizer.measureElement}
                    />
                  );
                })}
              </div>
              {showBar && (
                <div
                  ref={barRef}
                  className="lg-selbar absolute left-0 top-0 z-10 flex max-w-full flex-wrap gap-1 rounded-md border border-border bg-surface p-0.5 shadow-md"
                  role="group"
                  aria-label="Selected lines"
                  data-testid="logs-selbar"
                >
                  <span className="lg-selcount">{plural(recordCount(selected), "line")}</span>
                  <button type="button" className={SELBTN} onClick={() => { rowsToChat(selected, false); clearSel(); }}><MessageSquare />Add to current chat</button>
                  <button type="button" className={SELBTN} onClick={() => { rowsToChat(selected, true); clearSel(); }}><MessageSquarePlus />Add to new chat</button>
                  <button type="button" className={SELBTN} onClick={() => { rowsToReport(selected, () => p.goTo("report")); clearSel(); }}><ClipboardList />Add to report</button>
                  <button type="button" className={SELBTN} onClick={() => void copyRows(selected)}><Copy />Copy</button>
                </div>
              )}
            </div>
          ) : (
            <ListEmpty {...p} />
          )}
        </div>

        {newCount > 0 && !follow && (
          <button type="button" className="lg-newpill" onClick={() => setFollow(true)}>
            <ArrowDown />{plural(newCount, "new line")}
          </button>
        )}

        <div className="lg-foot">
          <span className="src">{footFile(filter.src, meta?.files)}</span>
          {meta && (
            <span>
              {meta.hasMore
                ? `${recordCount(rows).toLocaleString("en-US")} of ${plural(meta.matched, "line")}`
                : plural(meta.matched, "line")}
            </span>
          )}
          <button type="button" disabled={!meta?.hasMore || feed.loadingEarlier || feed.loading} onClick={() => void loadEarlier()}>
            {feed.loadingEarlier ? "Loading…" : "Load earlier"}
          </button>
          <span className="sp" />
          <span className="tz">{utc ? "UTC" : `Local time (${localOffsetLabel()})`}</span>
        </div>
      </section>
    </>
  );
}

function SourceButton({ id, label, sub, stats, current, onPick }: {
  id: LogSourceId | "all";
  label: string;
  sub: string;
  stats: Pick<LogSourceStats, "total" | "err" | "warn"> | undefined;
  current: boolean;
  onPick(): void;
}) {
  const Icon = SOURCE_ICONS[id];
  const err = stats?.err ?? 0;
  const warn = stats?.warn ?? 0;
  return (
    <button
      type="button"
      aria-current={current}
      title={label}
      onClick={onPick}
      className={cn(
        "lg-src flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left transition-colors",
        err ? "has-e" : warn ? "has-w" : "",
        current ? "bg-primary/10 text-text-primary" : "hover:bg-surface-hover",
      )}
    >
      <Icon className="lg-src-ic size-4 shrink-0" />
      <span className="lg-src-txt"><b>{label}</b><small>{sub}</small></span>
      <span className="lg-cnts">
        {(err > 0 || warn > 0) && (
          <span className="flex gap-1">
            {err > 0 && <span className="lg-pill e" title={plural(err, "error")}>{shortCount(err)}</span>}
            {warn > 0 && <span className="lg-pill w" title={plural(warn, "warning")}>{shortCount(warn)}</span>}
          </span>
        )}
        <span className="lg-total" title="Lines in this range">{shortCount(stats?.total ?? 0)}</span>
      </span>
    </button>
  );
}

function ChatMenuContent({ filter, setFilter, chats, titles }: {
  filter: LogFilter;
  setFilter: LogsPaneProps["setFilter"];
  chats: ReadonlyArray<{ sid: string; title: string | null; count: number }>;
  titles: Readonly<Record<string, string>>;
}) {
  const current = tabSessionId(currentChatTab());
  return (
    <DropdownMenuContent align="start" className="max-h-80 min-w-60 max-w-80">
      <DropdownMenuLabel className="text-xs font-normal text-text-subtle">Show lines from</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => setFilter({ chat: null })}>
        <Layers />All chats{!filter.chat && <Check className="ml-auto" />}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {chats.length === 0 && (
        <DropdownMenuLabel className="text-xs font-normal text-text-subtle">No chat named in this range</DropdownMenuLabel>
      )}
      {chats.slice(0, 40).map((c) => (
        <DropdownMenuItem key={c.sid} onSelect={() => setFilter({ chat: c.sid })}>
          <MessageSquare />
          <span className="min-w-0 truncate">{c.title ?? titles[c.sid] ?? c.sid.slice(0, 8)}</span>
          {filter.chat === c.sid
            ? <Check className="ml-auto" />
            : <span className="lg-mi-sub">{c.sid === current ? "this tab" : c.sid.slice(0, 8)}</span>}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  );
}

export function ListEmpty(p: LogsPaneProps) {
  const { feed, filter, range } = p;
  if (feed.error && !feed.loading) {
    return (
      <div className="lg-empty">
        Could not read the logs: {feed.error}. <button type="button" onClick={() => feed.reload()}>Try again</button>
      </div>
    );
  }
  if (feed.loading || !feed.meta) return <div className="lg-empty">Reading the logs…</div>;
  if (filterChanged(filter, range)) {
    return <div className="lg-empty">No lines match these filters. <button type="button" onClick={p.clearFilters}>Clear filters</button></div>;
  }
  return (
    <div className="lg-empty">
      Nothing in {LOG_RANGE_LABELS[range].toLowerCase()}. <button type="button" onClick={() => p.setRange("all")}>Show everything kept</button>
    </div>
  );
}
