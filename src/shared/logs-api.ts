/**
 * What `/api/logs` answers, shared by the routes and the Logs window.
 */
import type { LogEntry, LogFilter, LogRange, LogSourceId, LogSourceStats } from "./logs-model.ts";

export interface LogQueryParams extends LogFilter {
  range: LogRange;
  /** Start of the range in epoch ms, worked out by the browser for 15m, 1h and today (its midnight). */
  from: number;
  /** Load the page before this record. */
  before?: string;
  /**
   * Make the page reach back to this record, with a few lines before it, however many lines
   * that takes — up to a cap. What Show in Logs asks for, so it needs one request and not a
   * page at a time.
   */
  reach?: string;
  limit: number;
}

export interface LogChatInfo {
  sid: string;
  title: string | null;
  count: number;
  last: number;
}

export interface LogFilesInfo {
  /** `~/.ppm/ppm.log`, as the person would type it. */
  ppmLogPath: string;
  ppmLogBytes: number;
  capBytes: number;
  generations: number;
  rotatedFiles: number;
  cloudflaredPath: string | null;
  cloudflaredBytes: number;
  browserDevices: number;
  browserRetentionDays: number;
}

export interface LogQueryResult {
  entries: LogEntry[];
  /** Records that pass every filter in the range. */
  matched: number;
  /** Records in the range from the selected source, whatever their level or text. */
  inRange: number;
  /** More matching records before the first one returned. */
  hasMore: boolean;
  /** Per source over the range, ignoring level, tag, chat and search. */
  stats: Record<LogSourceId, LogSourceStats>;
  chats: LogChatInfo[];
  /** Chat titles for every chat named on this page or in `chats`. */
  titles: Record<string, string>;
  /** When PPM started again inside the range. */
  restarts: number[];
  /** Where the range actually starts (for `restart`, the restart). */
  fromTs: number;
  files: LogFilesInfo;
  /** The search is a regular expression that does not compile. */
  badRegex?: boolean;
  /**
   * Why the page does not reach the record `reach` named: `gone` when no record in this range
   * has that id (rotated away, or outside the range), `far` when it is further back than a page
   * may go.
   */
  reachMissed?: "gone" | "far";
}

/** Lines pushed over `/ws/global` while a Logs view is subscribed. */
export interface LogsLinesEvent {
  type: "logs:lines";
  entries: LogEntry[];
  titles: Record<string, string>;
}

/** Where a report is opened. Nothing is posted there: the person submits it on GitHub. */
export const LOGS_ISSUE_REPO = "hienlh/ppm";

export const LOGS_SUBSCRIBE = "logs:subscribe";
export const LOGS_UNSUBSCRIBE = "logs:unsubscribe";
export const LOGS_ISSUES_CHANGED = "logs:issues-changed";

/** What AI made of a group of errors and warnings. */
export type IssueClass = "bug" | "setup" | "upstream" | "expected";
export const ISSUE_CLASSES: readonly IssueClass[] = ["bug", "setup", "upstream", "expected"];

export interface LogIssue {
  id: string;
  cls: IssueClass;
  title: string;
  /** Short name of the part of PPM it concerns ("Accounts", "Codex CLI"). */
  area: string;
  src: LogSourceId;
  why: string;
  fix?: string;
  /** Occurrences in the window, with repeats counted. */
  count: number;
  errors: number;
  warnings: number;
  last: number;
  /** The newest occurrences, oldest first — the evidence and what Show in Logs selects. */
  lines: LogEntry[];
  dismissed: boolean;
}

export interface LogIssuesResult {
  issues: LogIssue[];
  /** Error and warning records in the window that no issue covers yet. */
  unsorted: number;
  analyzedAt: number | null;
  model: string;
  /** What the last run read: records, patterns and tokens. */
  lastRun: { lines: number; patterns: number; tokens: number } | null;
  running: boolean;
  auto: boolean;
  /** Why the last run failed, if it did. */
  error: string | null;
  /** Start of the window, epoch ms. */
  windowFrom: number;
}

export interface LogIssuesSummary {
  likelyBugs: number;
  running: boolean;
}

export interface ReportDraftRequest {
  snippets: Array<{ label: string; lines: string[] }>;
  environment: Array<[string, string]>;
  note?: string;
}

export interface ReportDraft {
  title: string;
  labels: string[];
  what: string;
  steps: string;
  expected: string;
  model: string;
}

export interface DuplicateSearchResult {
  query: string;
  issues: Array<{ number: number; title: string; url: string }>;
}
