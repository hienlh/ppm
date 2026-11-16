/**
 * PPM Tasks: the shapes every side of the task store shares (server service, REST, AI tools, web,
 * Telegram). Named `ppm-tasks` because `TaskItem`/`TaskStatus` already mean Claude's own Task*
 * tools (`task-status-aggregator.ts`, `use-tasks.ts`).
 */

/** The four groups every per-project status belongs to, so all-projects views can merge projects. */
export type BaseGroup = "not_started" | "active" | "waiting" | "closed";
export const BASE_GROUPS: readonly BaseGroup[] = ["not_started", "active", "waiting", "closed"];

/** How a closed status ended the task. */
export type ClosedAs = "done" | "dropped";
export const CLOSED_AS: readonly ClosedAs[] = ["done", "dropped"];

/** Most urgent first; the order is the sort order. */
export type Urgency = "now" | "today" | "week" | "later";
export const URGENCIES: readonly Urgency[] = ["now", "today", "week", "later"];

/** Most important first; the order is the sort order. */
export type Importance = "must" | "should" | "nice";
export const IMPORTANCES: readonly Importance[] = ["must", "should", "nice"];

export * from "./ppm-tasks-history.ts";
export * from "./ppm-tasks-config.ts";

/** Known task types. The column takes any string so the list can grow; writes are checked against this. */
export const TASK_TYPES = ["task", "decision", "reply"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type LinkKind = "jira" | "pr" | "session" | "url";
export const LINK_KINDS: readonly LinkKind[] = ["jira", "pr", "session", "url"];

/** The reserved member id meaning the user ("You"); never stored as a member row. */
export const ME_MEMBER_ID = "me";

/** Size limits, checked on every write. */
export const PPM_TASK_LIMITS = {
  title: 200,
  why: 2_000,
  nextStep: 2_000,
  notes: 16_000,
  result: 4_000,
  tags: 20,
  tag: 64,
  links: 50,
  linkRef: 500,
  linkLabel: 200,
  fieldKeys: 50,
  fieldValue: 2_000,
  decisionOptions: 10,
  decisionLabel: 300,
  statusName: 60,
  memberName: 100,
  reason: 500,
} as const;

/** Handed-off work is checked this often by default; a project may pick within the bounds. */
export const CHECK_INTERVAL_DEFAULT_MIN = 30;
export const CHECK_INTERVAL_MIN_MIN = 5;
export const CHECK_INTERVAL_MAX_MIN = 240;

export interface TaskLink {
  kind: LinkKind;
  /** Canonical: a Jira key, `owner/repo#n` for a PR, a session id, a URL. */
  ref: string;
  label: string | null;
}

/** A link's cached live state (written by the link-state checker). */
export interface LinkState {
  kind: LinkKind;
  ref: string;
  state: Record<string, unknown> | null;
  error: string | null;
  checkedAt: number | null;
  changedAt: number | null;
}

export interface DecisionOption {
  /** Stable within the task: "a", "b", … */
  id: string;
  label: string;
}

export interface TaskDecision {
  question: string | null;
  options: DecisionOption[];
  chosen: { optionId: string; at: number; by: string } | null;
}

export interface TaskResult {
  text: string;
  at: number;
  /** The actor label of whoever recorded it. */
  by: string;
}

/** A custom field value; undeclared keys are kept as free key–value. */
export type FieldValue = string | number | null;

export interface Task {
  id: string;
  projectKey: string;
  number: number;
  title: string;
  type: string;
  statusId: string;
  urgency: Urgency;
  importance: Importance;
  rank: number;
  why: string | null;
  nextStep: string | null;
  notes: string | null;
  /** `YYYY-MM-DD`. */
  dueDate: string | null;
  tags: string[];
  assigneeMemberId: string | null;
  waitingOnMemberId: string | null;
  waitingSince: number | null;
  parentId: string | null;
  /** The chat doing the task, read through `resolveMigratedSession`; null = the manager does it. */
  workingSessionId: string | null;
  decision: TaskDecision | null;
  fields: Record<string, FieldValue>;
  links: TaskLink[];
  result: TaskResult | null;
  /** Set while the working session is a chat other than the project's manager. */
  handedOffAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  deletedAt: number | null;
}

/** What the last check of a handed-off task's working session found (written by the checker). */
export type ChildCheckState = "running" | "waiting_card" | "stalled" | "finished_no_report";
export const CHILD_CHECK_STATES: readonly ChildCheckState[] = ["running", "waiting_card", "stalled", "finished_no_report"];

export interface TaskChildCheck {
  taskId: string;
  sessionId: string;
  state: ChildCheckState;
  checkedAt: number;
  lastProgressAt: number | null;
  alerts: number;
  lastAlertAt: number | null;
  lastAlertState: ChildCheckState | null;
}

/** A task as lists and details show it: with its status group and the urgency its due date implies. */
export interface TaskView extends Task {
  baseGroup: BaseGroup;
  closedAs: ClosedAs | null;
  effectiveUrgency: Urgency;
  /** True when the due date raised the urgency above the stored one. */
  urgencyRaised: boolean;
}

export interface TaskFilter {
  projectKeys?: string[];
  types?: string[];
  baseGroups?: BaseGroup[];
  statusIds?: string[];
  /** Assignee or waiting-on. */
  memberId?: string;
  tag?: string;
  parentId?: string | null;
  /** Closed tasks are left out unless asked for (or a closed base group / status is asked for). */
  includeClosed?: boolean;
  /** Matches title, why, next step and notes, case-insensitively. */
  text?: string;
  limit?: number;
}

/** Fields a write may change. `fields` merges (null removes a key); `links` replaces the list. */
export interface TaskPatch {
  title?: string;
  type?: string;
  statusId?: string;
  urgency?: Urgency;
  importance?: Importance;
  why?: string | null;
  nextStep?: string | null;
  notes?: string | null;
  dueDate?: string | null;
  tags?: string[];
  assigneeMemberId?: string | null;
  waitingOnMemberId?: string | null;
  parentId?: string | null;
  workingSessionId?: string | null;
  fields?: Record<string, FieldValue>;
  links?: Array<{ kind: LinkKind; ref: string; label?: string | null }>;
  /** Records (or clears) the task's result; `at` and `by` come from the write. */
  result?: { text: string } | null;
}

export interface TaskCreateInput extends TaskPatch {
  projectKey: string;
  title: string;
  decision?: { question?: string | null; options: string[] } | null;
}

/** Error codes every caller maps (409 for `conflict`, 404 for `not_found`, …). */
export type PpmTaskErrorCode = "conflict" | "not_found" | "invalid" | "disabled" | "forbidden";
