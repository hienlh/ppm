/**
 * The device's log, live.
 *
 * Three decisions in here are about cost rather than looks:
 *
 *  - **Nothing is stored.** The plan is explicit that logcat never reaches the database. The
 *    ring lives in this component's state and dies with it; the server holds a second, larger
 *    one so reopening the panel is not an empty box.
 *  - **The subscription follows the panel.** Mounting turns the device's log stream on and
 *    unmounting turns it off, which is the plan's gate ("logs hidden ngừng subscription") — so
 *    a viewer left open overnight is not also running a logcat nobody is reading.
 *  - **Following is suspended the moment you scroll up.** Auto-scrolling a list somebody is
 *    reading is the one behaviour that makes a log viewer useless, and a "follow" checkbox they
 *    have to find first is not much better.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowDown, Copy, Check, Pause, Play, Search, Trash2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  appendBounded, EMPTY_FILTER, formatLogText, formatLogTime, LOG_LEVELS, matchesFilter,
  type LogFilter,
} from "./android-log-filter";
import type { AndroidLogEntry, AndroidLogLevel } from "../../../shared/android-protocol";

/** The client keeps fewer than the server's 2000: this is what one person scrolls, not storage. */
const CLIENT_RING = 1_000;
/** Rendering every row of a busy log is what makes the panel stutter, not receiving them. */
const MAX_ROWS = 400;

export interface AndroidLogcatPanelProps {
  setLogcat: (on: boolean) => void;
  onLog: (listener: (entries: AndroidLogEntry[]) => void) => () => void;
}

const LEVEL_CLASS: Record<AndroidLogLevel, string> = {
  verbose: "text-muted-foreground",
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
  fatal: "text-destructive font-semibold",
};

const LEVEL_LETTER: Record<AndroidLogLevel, string> = {
  verbose: "V", debug: "D", info: "I", warn: "W", error: "E", fatal: "F",
};

export function AndroidLogcatPanel({ setLogcat, onLog }: AndroidLogcatPanelProps) {
  const [entries, setEntries] = useState<AndroidLogEntry[]>([]);
  const [filter, setFilter] = useState<LogFilter>(EMPTY_FILTER);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const [following, setFollowing] = useState(true);

  const listRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // Turning the feed on is this panel existing, and turning it off is it going away. The gate
  // asks for exactly that, and a separate toggle would let the two disagree.
  useEffect(() => {
    setLogcat(true);
    return () => setLogcat(false);
  }, [setLogcat]);

  useEffect(() => onLog((batch) => {
    // Pause freezes the *view*: the stream keeps running on the host so nothing is missed, but
    // a log that scrolls while you are reading it is the thing pause exists to stop.
    if (pausedRef.current) return;
    setEntries((current) => appendBounded(current, batch, CLIENT_RING));
  }), [onLog]);

  const visible = useMemo(() => {
    const matched = entries.filter((e) => matchesFilter(e, filter));
    return matched.length > MAX_ROWS ? matched.slice(matched.length - MAX_ROWS) : matched;
  }, [entries, filter]);

  // Scroll after the rows are in the DOM, and only while the reader has not scrolled away.
  useEffect(() => {
    if (!following) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, following]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    // 24px of slack: a list that is one subpixel off the bottom must not read as "scrolled up".
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }, []);

  const copyAll = useCallback(async () => {
    const text = formatLogText(visible);
    try {
      // `navigator.clipboard` does not exist on an insecure origin, which is PPM's usual LAN
      // deployment — the textarea fallback is the only thing that works there.
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else copyViaTextarea(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      copyViaTextarea(text);
    }
  }, [visible]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-11 pl-8 md:h-9"
            placeholder="Filter tag or message"
            value={filter.text}
            onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))}
          />
        </div>

        {/* A native select so a phone gets its own picker (design guidelines §8). */}
        <label className="sr-only" htmlFor="android-log-level">Minimum level</label>
        <select
          id="android-log-level"
          className="h-11 rounded-md border bg-background px-2 text-sm md:h-9"
          value={filter.minimum}
          onChange={(e) => setFilter((f) => ({ ...f, minimum: e.target.value as AndroidLogLevel }))}
        >
          {LOG_LEVELS.map((l) => (
            <option key={l} value={l}>{l[0]!.toUpperCase() + l.slice(1)}</option>
          ))}
        </select>

        <Button variant={paused ? "default" : "ghost"} size="icon" className="size-11 md:size-9"
          onClick={() => setPaused((p) => !p)}
          title={paused ? "Resume" : "Pause the view"} aria-label={paused ? "Resume" : "Pause the view"}
          aria-pressed={paused}>
          {paused ? <Play /> : <Pause />}
        </Button>
        <Button variant="ghost" size="icon" className="size-11 md:size-9"
          onClick={() => setEntries([])} title="Clear the view" aria-label="Clear the view">
          <Trash2 />
        </Button>
        <Button variant="ghost" size="icon" className="size-11 md:size-9"
          onClick={() => void copyAll()} title="Copy what is shown" aria-label="Copy what is shown">
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>

      <div
        ref={listRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-[11px] leading-[1.45]"
      >
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {entries.length === 0 ? "Waiting for the device to log something…" : "Nothing matches that filter."}
          </p>
        ) : visible.map((e) => (
          <div key={e.id} className="flex gap-2 whitespace-pre-wrap break-words">
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatLogTime(e.timestamp)}</span>
            <span className={cn("w-3 shrink-0 text-center font-semibold", LEVEL_CLASS[e.level])}>
              {LEVEL_LETTER[e.level]}
            </span>
            {e.tag && (
              <button
                type="button"
                className="shrink-0 max-w-40 truncate text-left text-muted-foreground hover:underline"
                title={`Filter by ${e.tag}`}
                onClick={() => setFilter((f) => ({ ...f, text: e.tag }))}
              >
                {e.tag}
              </button>
            )}
            <span className={cn("min-w-0", LEVEL_CLASS[e.level])}>{e.message}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t px-2 py-1 text-xs text-muted-foreground">
        <span>{visible.length === entries.length ? `${entries.length} lines` : `${visible.length} of ${entries.length} lines`}</span>
        {paused && <span className="text-amber-600 dark:text-amber-400">paused</span>}
        <span className="flex-1" />
        {!following && (
          <Button variant="ghost" size="sm" className="h-8" onClick={() => setFollowing(true)}>
            <ArrowDown /> Follow
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The insecure-origin copy fallback.
 *
 * The textarea must be rendered — `display:none` and `visibility:hidden` both give an empty
 * selection, and `execCommand` then copies nothing while still returning true (CLAUDE.md, remote
 * desktop clipboard).
 */
function copyViaTextarea(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.left = "-9999px";
  area.setAttribute("readonly", "");
  document.body.appendChild(area);
  try {
    area.select();
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}
