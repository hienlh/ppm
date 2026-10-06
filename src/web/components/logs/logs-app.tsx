/**
 * The Logs window: the Logs / Issues / Report sub-tabs over one set of state. Rendered by the
 * desktop window and the phone tab alike; `mode` decides which Logs pane is drawn and whether
 * the shell has a title row of its own (a window already has one).
 *
 * The records are read here rather than in the Logs pane, so moving to Issues and back keeps
 * the lines that were loaded and the live tail keeps running for as long as Logs is open.
 * "Show in Logs" lives here too: it resets the filter to one that holds the lines, waits for
 * that page, asks for one earlier page reaching back to them if they are not on it, and selects
 * them.
 */
import "./logs.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Settings, Sparkles } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { byteSize, foldRepeats, localOffsetLabel, plural, rangeCovering } from "@/lib/logs/logs-view-model";
import { snippetCount, snippetSource } from "@/lib/logs/logs-report";
import {
  DEFAULT_LOG_FILTER, type LogEntry, type LogFilter, type LogRange,
} from "../../../shared/logs-model";
import { LOGS_NAVIGATE_EVENT, LOGS_VIEWS, takeLogsNavigation, type LogsNavigation, type LogsView } from "./open-logs";
import { queryKey, useLogsFeed } from "./use-logs-feed";
import { useLogsIssues } from "./use-logs-issues";
import { useLogsReportStore } from "./logs-report-store";
import { LiveIndicator } from "./logs-ui";
import { NO_SELECTION, type CrossPaneProps, type LogsPaneProps, type LogsSelection, type RevealRequest } from "./logs-state";
import { LogsPane } from "./logs-pane";
import { LogsPhonePane } from "./logs-phone-pane";
import { IssuesPane } from "./logs-issues-pane";
import { ReportPane } from "./logs-report-pane";

const VIEW_LABELS: Readonly<Record<LogsView, string>> = { logs: "Logs", issues: "Issues", report: "Report" };

interface FocusRequest {
  ids: readonly string[];
  /** The query the lines are looked for in. */
  key: string;
  /** The oldest of them, which the earlier page is asked to reach back to. */
  reach: string;
  /** That page was asked for. */
  reached: boolean;
}

export interface LogsAppProps {
  mode: "window" | "phone";
  initialView?: LogsView;
  onViewChange?(view: LogsView): void;
}

export function LogsApp({ mode, initialView = "logs", onViewChange }: LogsAppProps) {
  const phone = mode === "phone";
  const [view, setViewState] = useState<LogsView>(initialView);
  const [filter, setFilterState] = useState<LogFilter>(DEFAULT_LOG_FILTER);
  const [range, setRangeState] = useState<LogRange>("1h");
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [sel, setSel] = useState<LogsSelection>(NO_SELECTION);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const listTop = useRef<string | null>(null);
  const utc = useSettingsStore((s) => s.logsUtc);
  const wrapPref = useSettingsStore((s) => s.logsWrap);
  const feed = useLogsFeed(filter, range, paused);
  const rows = useMemo(() => foldRepeats(feed.entries), [feed.entries]);
  const issues = useLogsIssues();
  const reportLines = useLogsReportStore((s) => s.snippets.reduce((a, x) => a + snippetCount(x), 0));

  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const goTo = useCallback((next: LogsView) => {
    setViewState(next);
    onViewChangeRef.current?.(next);
  }, []);

  const setFilter = useCallback((patch: Partial<LogFilter>) => {
    setFilterState((f) => ({ ...f, ...patch }));
    setSel(NO_SELECTION);
  }, []);
  const setRange = useCallback((next: LogRange) => {
    setRangeState(next);
    setSel(NO_SELECTION);
  }, []);
  const clearFilters = useCallback(() => {
    setFilterState((f) => ({ ...DEFAULT_LOG_FILTER, src: f.src }));
    setRangeState("1h");
    setSel(NO_SELECTION);
  }, []);
  // Picking lines stops following: a list that keeps moving puts the Shift-click, or the
  // phone's second tap, on another line than the one aimed at.
  const pickLines = useCallback((next: LogsSelection) => {
    setSel(next);
    if (next.keys.size) setFollow(false);
  }, []);

  // Where the person asked to land: a sub-tab, one chat's lines, one source.
  const applyNavigation = useCallback((nav: LogsNavigation | null) => {
    if (!nav) return;
    if (nav.chat || nav.src) {
      setFilterState({ ...DEFAULT_LOG_FILTER, src: nav.src ?? "all", chat: nav.chat ?? null });
      // A chat's lines can be days old; the chat filter is what narrows them.
      if (nav.chat) setRangeState("all");
      setSel(NO_SELECTION);
      setFollow(true);
    }
    if (nav.view) goTo(nav.view);
    else if (nav.chat || nav.src) goTo("logs");
  }, [goTo]);

  useEffect(() => {
    applyNavigation(takeLogsNavigation());
    const onNavigate = () => applyNavigation(takeLogsNavigation());
    window.addEventListener(LOGS_NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(LOGS_NAVIGATE_EVENT, onNavigate);
  }, [applyNavigation]);

  const showInLogs = useCallback((entries: readonly LogEntry[]) => {
    if (!entries.length) return;
    const oldest = entries.reduce((a, e) => (e.ts < a.ts ? e : a));
    const next: LogFilter = {
      ...DEFAULT_LOG_FILTER,
      src: snippetSource(entries),
      levels: { ...DEFAULT_LOG_FILTER.levels, debug: entries.some((e) => e.lv === "debug") },
    };
    const nextRange = rangeCovering(oldest.ts, Date.now());
    setFilterState(next);
    setRangeState(nextRange);
    setSel(NO_SELECTION);
    setFollow(false);
    setFocus({ ids: entries.map((e) => e.id), key: queryKey(next, nextRange), reach: oldest.id, reached: false });
    goTo("logs");
  }, [goTo]);

  // The lines Show in Logs asked for: once their page is in, select them, after one earlier
  // page that reaches back to them if they are older than it.
  useEffect(() => {
    if (!focus || feed.key !== focus.key || feed.loading || feed.loadingEarlier || !feed.meta) return;
    const want = new Set(focus.ids);
    const hits = rows.filter((r) => r.ids.some((id) => want.has(id)));
    const found = hits.reduce((a, r) => a + r.ids.filter((id) => want.has(id)).length, 0);
    if (found < want.size && feed.meta.hasMore && !focus.reached) {
      setFocus({ ...focus, reached: true });
      void feed.loadEarlier(focus.reach);
      return;
    }
    setFocus(null);
    if (!hits.length) {
      toast(feed.meta.reachMissed === "far" ? "Those lines are too far back to show here" : "Those lines are no longer kept");
      return;
    }
    setSel({ keys: new Set(hits.map((r) => r.key)), anchor: hits[0]!.key, cursor: hits[hits.length - 1]!.key });
    setReveal({ key: hits[0]!.key, seq: Date.now() });
  }, [focus, feed, rows]);

  // A pulse on the Report count each time lines are added to it.
  const [pulse, setPulse] = useState(false);
  const lastReportLines = useRef(reportLines);
  useEffect(() => {
    const grew = reportLines > lastReportLines.current;
    lastReportLines.current = reportLines;
    if (!grew) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(t);
  }, [reportLines]);

  const openIssues = issues.data?.issues.filter((i) => i.cls !== "expected" && !i.dismissed).length ?? 0;

  const paneProps: LogsPaneProps = {
    feed, rows, filter, setFilter, clearFilters, range, setRange, paused, setPaused, follow, setFollow, sel, setSel: pickLines,
    utc, wrap: phone || wrapPref, reveal, listTop, goTo, togglePrefs: () => setPrefsOpen((o) => !o),
  };
  const cross: CrossPaneProps = { utc, phone, issues, goTo, showInLogs };

  return (
    <div className="lg-app" data-mode={phone ? "phone" : "window"} data-testid="logs-app">
      {phone && (
        <div className="lg-head">
          <h2>Logs</h2>
          <LiveIndicator paused={paused} pending={feed.pausedCount} />
        </div>
      )}
      <div className="lg-tabs" role="tablist" aria-label="Logs">
        {LOGS_VIEWS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => goTo(id)}
            data-testid={`logs-tab-${id}`}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center px-4 text-sm font-medium transition-colors",
              view === id ? "-mb-px border-b-2 border-primary text-text-primary" : "text-text-subtle hover:text-text-secondary",
            )}
          >
            {id === "issues" && <Sparkles className="lg-tab-ai" />}
            {VIEW_LABELS[id]}
            {id === "issues" && openIssues > 0 && <span className="lg-tabn">{openIssues}</span>}
            {id === "report" && reportLines > 0 && <span className={cn("lg-tabn acc", pulse && "pulse")}>{reportLines.toLocaleString("en-US")}</span>}
          </button>
        ))}
        {!phone && (
          <div className="ml-auto flex shrink-0 items-center gap-2 pl-3 pr-1">
            <LiveIndicator paused={paused} pending={feed.pausedCount} />
            <button
              type="button"
              aria-label="Logs preferences"
              aria-expanded={prefsOpen}
              onClick={() => setPrefsOpen((o) => !o)}
              className={cn(
                "flex size-11 items-center justify-center rounded transition-colors md:size-8",
                prefsOpen ? "bg-primary/10 text-primary" : "text-text-subtle hover:bg-surface-hover hover:text-text-secondary",
              )}
            >
              <Settings className="size-4" />
            </button>
          </div>
        )}
      </div>
      {prefsOpen && !phone && <LogsPreferences auto={issues.data?.auto} setAuto={issues.setAuto} files={feed.meta?.files} />}
      <div className="lg-body">
        {view === "logs" ? (phone ? <LogsPhonePane {...paneProps} /> : <LogsPane {...paneProps} />)
          : view === "issues" ? <IssuesPane {...cross} />
            : <ReportPane {...cross} />}
      </div>
    </div>
  );
}

function LogsPreferences({ auto, setAuto, files }: {
  auto: boolean | undefined;
  setAuto(on: boolean): Promise<void>;
  files: { generations: number; capBytes: number; browserRetentionDays: number } | undefined;
}) {
  const utc = useSettingsStore((s) => s.logsUtc);
  const setUtc = useSettingsStore((s) => s.setLogsUtc);
  const badge = useSettingsStore((s) => s.logsBadge);
  const setBadge = useSettingsStore((s) => s.setLogsBadge);
  return (
    <div className="lg-prefs" data-testid="logs-prefs">
      <span className="inline-flex items-center gap-2">
        Times
        <button type="button" className="lg-chip" aria-pressed={!utc} onClick={() => setUtc(false)}>Local ({localOffsetLabel()})</button>
        <button type="button" className="lg-chip" aria-pressed={utc} onClick={() => setUtc(true)}>UTC</button>
      </span>
      <label>
        <Switch checked={badge} onCheckedChange={setBadge} />
        Red dot on the Logs button for a likely bug
      </label>
      <label>
        <Switch checked={!!auto} disabled={auto === undefined} onCheckedChange={(on) => void setAuto(on)} />
        Let AI sort new errors and warnings
      </label>
      {files && (
        <span>
          Keeps <b>{files.generations} × {byteSize(files.capBytes)}</b> of ppm.log and <b>{plural(files.browserRetentionDays, "day")}</b> of browser logs
        </span>
      )}
    </div>
  );
}
