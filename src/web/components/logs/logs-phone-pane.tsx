/**
 * The Logs list on a phone: sources as chips, the search and a Filters sheet, and records that
 * wrap to three lines. A long press picks the first line and a tap then picks the last, like
 * Shift-click; Ask AI and Report sit in a bar at the bottom, in the thumb zone.
 *
 * The long press is pointer events, disarmed by a move past 8px and by `pointercancel` — which
 * is what the browser sends once it decides the finger is scrolling, after which no `pointerup`
 * arrives to disarm it.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Check, ClipboardList, Copy, MessageSquare, MessageSquarePlus, Search, SlidersHorizontal, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { clockTime, hitPattern, plural, timeSpan, type LogRow } from "@/lib/logs/logs-view-model";
import {
  LOG_RANGES, LOG_RANGE_LABELS, LOG_SOURCES, compileLogSearch, levelBucket, type LogFilter, type LogSourceId,
} from "../../../shared/logs-model";
import { copyRows, currentChatTab, recordCount, rowsToChat, rowsToReport } from "./logs-actions";
import { LEVEL_TEXT, MessageText, SOURCE_ICONS, SheetSection, Hits } from "./logs-ui";
import { ListEmpty } from "./logs-pane";
import {
  NO_SELECTION, filterChanged, selectOne, selectTo, selectedRows, type LogsPaneProps,
} from "./logs-state";
import { useFollowList } from "./use-follow-list";

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 8;

const LEVEL_CHIPS: ReadonlyArray<[keyof LogFilter["levels"], string, string]> = [
  ["error", "e", "Errors"], ["warn", "w", "Warnings"], ["info", "", "Info"], ["debug", "", "Debug"],
];

interface Press {
  key: string;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
  fired: boolean;
}

export function LogsPhonePane(p: LogsPaneProps) {
  const { feed, rows, filter, setFilter, range, setRange, sel, setSel, follow, setFollow, utc } = p;
  const meta = feed.meta;
  const listRef = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [sheet, setSheet] = useState<"filter" | "chat" | null>(null);
  const setUtc = useSettingsStore((s) => s.setLogsUtc);

  const search = useMemo(() => compileLogSearch(filter), [filter]);
  const re = useMemo(() => hitPattern(search), [search]);
  const titles = useMemo(() => meta?.titles ?? {}, [meta?.titles]);
  const rowKeys = useMemo(() => rows.map((r) => r.key), [rows]);
  const selected = useMemo(() => selectedRows(rows, sel), [rows, sel]);
  // Show in Logs arrives with lines already selected.
  const selecting = picking || sel.keys.size > 0;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 64,
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
  });
  const totalSize = virtualizer.getTotalSize();
  const { newCount, onScroll } = useFollowList(listRef, {
    follow, setFollow, feed, size: totalSize + rows.length, virtualizer, keep: p.listTop,
  });

  const stopSelecting = useCallback(() => {
    setPicking(false);
    setSel(NO_SELECTION);
  }, [setSel]);

  const tapRow = (key: string) => {
    if (selecting) {
      if (sel.anchor === key && sel.keys.size === 1) setSel({ keys: new Set(), anchor: null, cursor: null });
      else if (!sel.anchor) setSel(selectOne(key));
      else setSel(selectTo(sel, rowKeys, key));
      return;
    }
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const disarm = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as Element;
    const rowEl = target.closest<HTMLElement>(".lg-prow");
    const key = rowEl?.dataset.key;
    if (!key || target.closest("button, a")) return;
    disarm();
    const timer = setTimeout(() => {
      if (!press.current) return;
      press.current.fired = true;
      setPicking(true);
      setSel(selectOne(key));
      navigator.vibrate?.(10);
    }, LONG_PRESS_MS);
    press.current = { key, x: e.clientX, y: e.clientY, timer, fired: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const pr = press.current;
    if (pr && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > MOVE_TOLERANCE_PX) disarm();
  };

  const onPointerUp = () => {
    const pr = press.current;
    if (!pr) return;
    clearTimeout(pr.timer);
    press.current = null;
    if (!pr.fired) tapRow(pr.key);
  };

  const n = recordCount(selected);
  const first = selected[0];
  const last = selected[selected.length - 1];
  const span = first && last ? timeSpan(first.entry.ts, last.lastTs, utc) : "";
  const chat = sheet === "chat" ? currentChatTab() : undefined;
  const allCounts = meta ? Object.values(meta.stats) : [];

  const toChat = (newTab: boolean) => {
    rowsToChat(selected, newTab);
    setSheet(null);
    stopSelecting();
  };

  return (
    <div className="lg-view">
      <div className="lg-pchips" aria-label="Sources">
        <SourceChip id="all" label="All" err={allCounts.reduce((a, s) => a + s.err, 0)} warn={allCounts.reduce((a, s) => a + s.warn, 0)} current={filter.src === "all"} onPick={() => setFilter({ src: "all", tagsOff: [] })} />
        {LOG_SOURCES.map((s) => (
          <SourceChip key={s.id} id={s.id} label={s.label} err={meta?.stats[s.id].err ?? 0} warn={meta?.stats[s.id].warn ?? 0} current={filter.src === s.id} onPick={() => setFilter({ src: s.id, tagsOff: [] })} />
        ))}
      </div>

      <div className="lg-psearch">
        <div className="lg-search">
          <Search />
          <input
            type="search"
            value={filter.q}
            onChange={(e) => setFilter({ q: e.target.value })}
            placeholder="Search logs"
            aria-label="Search logs"
            aria-invalid={!!filter.q && (search === undefined || !!meta?.badRegex)}
            enterKeyHint="search"
          />
        </div>
        <button type="button" className="lg-pfilter" aria-label="Filters" onClick={() => setSheet("filter")}>
          <SlidersHorizontal />
          {filterChanged(filter, range) && <span className="dotn" />}
        </button>
      </div>

      {!selecting && rows.length > 0 && <div className="lg-phint">Long-press a line to select it, then tap the last line you need.</div>}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          className="lg-plist"
          onScroll={onScroll}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={disarm}
          onPointerLeave={disarm}
          onContextMenu={(e) => { if ((e.target as Element).closest(".lg-prow")) e.preventDefault(); }}
          data-testid="logs-plist"
        >
          {rows.length > 0 ? (
            <div style={{ height: totalSize, position: "relative" }}>
              <div style={{ transform: `translateY(${virtualizer.getVirtualItems()[0]?.start ?? 0}px)` }}>
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = rows[vi.index]!;
                  return (
                    <PhoneRow
                      key={row.key}
                      row={row}
                      index={vi.index}
                      selecting={selecting}
                      selected={sel.keys.has(row.key)}
                      open={open.has(row.key)}
                      utc={utc}
                      re={re}
                      titles={titles}
                      onChat={(sid) => setFilter({ chat: sid })}
                      measure={virtualizer.measureElement}
                    />
                  );
                })}
              </div>
            </div>
          ) : <ListEmpty {...p} />}
        </div>
        {newCount > 0 && !follow && (
          <button type="button" className="lg-newpill" style={{ bottom: 12 }} onClick={() => setFollow(true)}>
            <ArrowDown />{plural(newCount, "new line")}
          </button>
        )}
      </div>

      {selecting && (
        <div className="lg-pbar" data-testid="logs-pbar">
          <Button variant="ghost" size="icon" className="size-11" aria-label="Stop selecting" onClick={stopSelecting}>
            <X className="size-5" />
          </Button>
          <span className="cnt">
            {n ? `${plural(n, "line")} selected` : "Nothing selected"}
            <small>{n ? span : "Tap lines to select them"}</small>
          </span>
          <Button variant="outline" className="min-h-11 px-3" disabled={!n} onClick={() => setSheet("chat")}>
            <MessageSquare className="size-4" />Ask AI
          </Button>
          <Button
            className="min-h-11 px-3"
            disabled={!n}
            onClick={() => {
              rowsToReport(selected, () => p.goTo("report"));
              stopSelecting();
            }}
          >
            <ClipboardList className="size-4" />Report
          </Button>
        </div>
      )}

      <BottomSheet open={sheet === "chat"} onClose={() => setSheet(null)}>
        <div className="lg-sheet-title">Ask AI about {plural(n, "line")}<small>{span}</small></div>
        <div className="lg-sheet-list">
          <button type="button" className="lg-sheet-row" onClick={() => toChat(false)}>
            <MessageSquare />
            <span>Add to current chat<small>{chat ? chat.title : "Opens a new chat"}</small></span>
          </button>
          <button type="button" className="lg-sheet-row" onClick={() => toChat(true)}>
            <MessageSquarePlus />
            <span>Add to new chat<small>Starts a chat with these lines attached</small></span>
          </button>
          <button type="button" className="lg-sheet-row" onClick={() => { void copyRows(selected); setSheet(null); }}>
            <Copy />
            <span>Copy lines</span>
          </button>
        </div>
      </BottomSheet>

      <BottomSheet open={sheet === "filter"} onClose={() => setSheet(null)} className="flex max-h-[calc(var(--sheet-vh,100dvh)*0.85)] flex-col">
        <div className="lg-sheet-title">Filters</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SheetSection title="Levels">
            {LEVEL_CHIPS.map(([lv, cls, label]) => (
              <button key={lv} type="button" className={cn("lg-chip", cls)} aria-pressed={filter.levels[lv]} onClick={() => setFilter({ levels: { ...filter.levels, [lv]: !filter.levels[lv] } })}>
                <span className="dot" />{label}
              </button>
            ))}
          </SheetSection>
          <SheetSection title="Chat">
            <button type="button" className="lg-chip" aria-pressed={!filter.chat} onClick={() => setFilter({ chat: null })}>All chats</button>
            {filter.chat && !meta?.chats.slice(0, 4).some((c) => c.sid === filter.chat) && (
              <button type="button" className="lg-chip" aria-pressed>
                <span className="t">{titles[filter.chat] ?? filter.chat.slice(0, 8)}</span>
              </button>
            )}
            {(meta?.chats ?? []).slice(0, 4).map((c) => (
              <button key={c.sid} type="button" className="lg-chip" aria-pressed={filter.chat === c.sid} onClick={() => setFilter({ chat: c.sid })}>
                <span className="t">{c.title ?? titles[c.sid] ?? c.sid.slice(0, 8)}</span>
              </button>
            ))}
          </SheetSection>
          <SheetSection title="Time">
            {LOG_RANGES.map((r) => (
              <button key={r} type="button" className="lg-chip" aria-pressed={range === r} onClick={() => setRange(r)}>{LOG_RANGE_LABELS[r]}</button>
            ))}
          </SheetSection>
          <div className="lg-sheet-list">
            <label className="lg-sheet-row">
              <Switch checked={utc} onCheckedChange={setUtc} />
              <span>Show times in UTC</span>
            </label>
          </div>
        </div>
        <div className="lg-sheet-foot">
          <Button variant="outline" className="min-h-11 flex-1" onClick={p.clearFilters}>Reset</Button>
          <Button className="min-h-11 flex-1" onClick={() => setSheet(null)}>
            {feed.loading ? "Reading…" : `Show ${plural(meta?.matched ?? 0, "line")}`}
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}

function SourceChip({ id, label, err, warn, current, onPick }: {
  id: LogSourceId | "all";
  label: string;
  err: number;
  warn: number;
  current: boolean;
  onPick(): void;
}) {
  const Icon = SOURCE_ICONS[id];
  return (
    <button type="button" className="lg-chip" aria-pressed={current} onClick={onPick}>
      <Icon />
      {label}
      {err > 0 ? <span className="lg-pill e">{err}</span> : warn > 0 ? <span className="lg-pill w">{warn}</span> : null}
    </button>
  );
}

function PhoneRow({ row, index, selecting, selected, open, utc, re, titles, onChat, measure }: {
  row: LogRow;
  index: number;
  selecting: boolean;
  selected: boolean;
  open: boolean;
  utc: boolean;
  re: RegExp | null;
  titles: Readonly<Record<string, string>>;
  onChat(sid: string): void;
  measure(node: Element | null): void;
}) {
  const e = row.entry;
  const more = e.more?.length ?? 0;
  return (
    <div
      ref={measure}
      data-index={index}
      data-key={row.key}
      aria-selected={selecting ? selected : undefined}
      className={cn("lg-prow", levelBucket(e.lv) === "error" && "err", selected && "sel", open && "open")}
    >
      <div className="lg-prow-g">
        {selecting ? <span className="lg-pcheck">{selected && <Check />}</span> : <span className={`lv ${e.lv}`} />}
      </div>
      <div className="min-w-0">
        <div className="lg-prow-meta">
          <span>{clockTime(e.ts, utc)}</span>
          <span className={`lv ${e.lv}`}>{LEVEL_TEXT[e.lv]}</span>
          <span className="tg">{e.tag}</span>
          {row.count > 1 && <span>×{row.count}</span>}
          {more > 0 && <span>+{plural(more, "line")}</span>}
        </div>
        <div className="lg-prow-msg">
          <MessageText msg={e.msg} re={re} titles={titles} onChat={onChat} />
          {open && more > 0 && <>{"\n"}<Hits text={e.more!.join("\n")} re={re} /></>}
        </div>
      </div>
    </div>
  );
}
