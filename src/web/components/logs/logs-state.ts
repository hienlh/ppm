/**
 * What the Logs shell hands its panes: the filter and the records it read, the selection, and
 * the actions that cross panes (Show in Logs, switching sub-tab). The selection is held by row
 * key — the first record's id, which stays put when a live copy folds into the row — and it is
 * dropped whenever the filter changes, as a selection in a list that just changed would point
 * at lines the person can no longer see.
 */
import type { MutableRefObject } from "react";
import { keySpan } from "@/lib/logs/logs-view-model";
import type { LogRow } from "@/lib/logs/logs-view-model";
import type { LogEntry, LogFilter, LogRange } from "../../../shared/logs-model";
import type { LogsFeed } from "./use-logs-feed";
import type { LogsIssues } from "./use-logs-issues";
import type { LogsView } from "./open-logs";

export interface LogsSelection {
  keys: ReadonlySet<string>;
  /** Where Shift-click and a phone's second tap extend from. */
  anchor: string | null;
  /** The keyboard's row. */
  cursor: string | null;
}

export const NO_SELECTION: LogsSelection = { keys: new Set(), anchor: null, cursor: null };

/** A request to scroll a row into view; `seq` makes asking for the same row twice count. */
export interface RevealRequest {
  key: string;
  seq: number;
}

export interface LogsPaneProps {
  feed: LogsFeed;
  rows: LogRow[];
  filter: LogFilter;
  /** Merges into the filter and drops the selection. */
  setFilter(patch: Partial<LogFilter>): void;
  /** Back to the default levels, tags, search, chat and range; the source stays. */
  clearFilters(): void;
  range: LogRange;
  setRange(range: LogRange): void;
  paused: boolean;
  setPaused(paused: boolean): void;
  follow: boolean;
  setFollow(follow: boolean): void;
  sel: LogsSelection;
  setSel(sel: LogsSelection): void;
  utc: boolean;
  wrap: boolean;
  reveal: RevealRequest | null;
  /** Where the list was left, so it opens there again after Issues or Report. */
  listTop: MutableRefObject<string | null>;
  goTo(view: LogsView): void;
  togglePrefs(): void;
}

export interface CrossPaneProps {
  utc: boolean;
  phone: boolean;
  issues: LogsIssues;
  goTo(view: LogsView): void;
  showInLogs(entries: readonly LogEntry[]): void;
}

/** Selects `key` alone. */
export function selectOne(key: string): LogsSelection {
  return { keys: new Set([key]), anchor: key, cursor: key };
}

/** The rows from the anchor to `key`, added to what is selected when `add` is set. */
export function selectTo(sel: LogsSelection, rowKeys: readonly string[], key: string, add = false): LogsSelection {
  const anchor = sel.anchor ?? key;
  const span = keySpan(rowKeys, anchor, key);
  return { keys: new Set(add ? [...sel.keys, ...span] : span), anchor, cursor: key };
}

export function toggleOne(sel: LogsSelection, key: string): LogsSelection {
  const keys = new Set(sel.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { keys, anchor: key, cursor: key };
}

/** The selected rows in list order. */
export function selectedRows(rows: readonly LogRow[], sel: LogsSelection): LogRow[] {
  return sel.keys.size ? rows.filter((r) => sel.keys.has(r.key)) : [];
}

/** Whether the filter is anything but what Logs opens with (the source aside). */
export function filterChanged(filter: LogFilter, range: LogRange): boolean {
  const l = filter.levels;
  return !l.error || !l.warn || !l.info || l.debug || !!filter.chat || !!filter.q || filter.tagsOff.length > 0 || range !== "1h";
}
