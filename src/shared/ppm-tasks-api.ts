/**
 * PPM Tasks over HTTP: what `/api/tasks` answers and what `/ws/global` pushes. Shared by the
 * routes and the web data layer so the two cannot drift. Projects are named by their PPM name in
 * every request and answer; the server resolves the name to the stored project key.
 */
import type {
  ChildCheckState, FieldDef, HistoryEntry, LinkState, TaskMember, TaskStatusDef, TaskView,
} from "./ppm-tasks.ts";
import type { SessionDelivery } from "./session-collab.ts";

/** A chat's live state as a task shows it (the server's `SessionLinkState`). */
export interface TaskSessionState {
  sessionId: string;
  /** `gone`: PPM has no record of the chat any more (deleted). */
  state: "running" | "waiting_card" | "idle" | "gone" | "unknown";
  title: string | null;
  providerId?: string | null;
  /** When the running turn started (ms since the epoch), while one runs. */
  runningSince?: number;
  /** The handed-off work checker's last finding; null when not handed off or not checked yet. */
  check?: TaskCheckSummary | null;
}

/** The last check of a handed-off task's working chat ("stalled 40 min", "finished, no report"). */
export interface TaskCheckSummary {
  state: ChildCheckState;
  /** When this state's episode began (stalled: the last progress), ms since the epoch. */
  since: number;
  lastProgressAt: number | null;
}

/**
 * Who works on a task: its working chat, else the project's manager chat, else nobody (the row
 * then offers Start chat).
 */
export type TaskWorkingSession =
  | { kind: "session"; session: TaskSessionState }
  | { kind: "manager"; label: "Manager"; session: TaskSessionState }
  | { kind: "start_chat" };

/** A task as every list and detail receives it. */
export interface TaskDto extends TaskView {
  /** The project's PPM name. */
  project: string;
  /** `ppm/12`. */
  ref: string;
  statusName: string;
  workingSession: TaskWorkingSession;
  /** The working chat's last check, lifted out of `workingSession` for rows that only show a chip. */
  check: TaskCheckSummary | null;
}

/** One project as the task views list it. */
export interface TaskProjectSummary {
  name: string;
  projectKey: string;
  enabled: boolean;
  hasManager: boolean;
  /** Open tasks (not closed). */
  open: number;
  /** Open tasks whose effective urgency is Now. */
  now: number;
}

export interface TaskListResponse {
  tasks: TaskDto[];
  /** The projects the list covers (one, or every switched-on project for `all`), with counts. */
  projects: TaskProjectSummary[];
}

export interface TaskDetailResponse {
  task: TaskDto;
  children: TaskDto[];
  linkStates: LinkState[];
  /**
   * The project's Jira site, where its Jira links open (`<site>/browse/NX-6284`); null when the
   * project has no Jira config. Missing from answers of an older server.
   */
  jiraSite?: string | null;
}

/** Every write answers with the task as it now stands. */
export interface TaskWriteResponse {
  task: TaskDto;
  /**
   * The user changed a task of a project that has a manager chat: ask "Tell the manager now?"
   * and, on yes, call `notify-manager`.
   */
  managerPrompt: boolean;
}

export interface TaskDecideResponse extends TaskWriteResponse {
  /** How the chat took the choice; null when it was recorded but could not be sent. */
  delivered: SessionDelivery | null;
  sessionId: string | null;
  /** Why the send failed, when it did (the choice is recorded either way). */
  deliveryError?: string;
}

export interface TaskStartChatResponse extends TaskWriteResponse {
  sessionId: string;
}

export type NotifyManagerResponse =
  | { sent: true; sessionId: string }
  | { sent: false; reason: "budget" | "nothing_pending" | "no_manager" | "error"; error?: string };

export interface TaskHistoryItem extends HistoryEntry {
  /** An AI change that can still be undone. */
  undoable: boolean;
}

export type TaskHistoryFilter = "all" | "ai" | "status";

export interface TaskLinkStatesResponse {
  /** Keyed by task id; tasks not found or in a switched-off project are left out. */
  tasks: Record<string, { linkStates: LinkState[]; workingSession: TaskWorkingSession }>;
}

export interface TaskProjectSettings {
  project: TaskProjectSummary & {
    enabledBy: "user" | "manager_assign" | "migration" | null;
    checkIntervalMin: number;
  };
  statuses: TaskStatusDef[];
  /** Archived members included (`archivedAt` set), so old assignments still read by name. */
  members: TaskMember[];
  fieldDefs: FieldDef[];
}

/** A settings write; every part is optional and applied in this order, all or nothing. */
export interface TaskProjectSettingsUpdate {
  enabled?: boolean;
  checkIntervalMin?: number;
  statuses?: {
    add?: Array<{ name: string; baseGroup: TaskStatusDef["baseGroup"]; closedAs?: TaskStatusDef["closedAs"] }>;
    update?: Array<{ id: string; name?: string; baseGroup?: TaskStatusDef["baseGroup"]; closedAs?: TaskStatusDef["closedAs"]; position?: number }>;
    /** A status tasks use needs `replacementId`; its tasks move there. */
    delete?: Array<{ id: string; replacementId?: string | null }>;
  };
  members?: {
    add?: Array<{ name: string; jiraAccountId?: string | null; githubLogin?: string | null; slackUserId?: string | null }>;
    update?: Array<{ id: string; name?: string; jiraAccountId?: string | null; githubLogin?: string | null; slackUserId?: string | null; position?: number; archived?: boolean }>;
  };
  fields?: {
    upsert?: Array<{ key: string; label: string; type: FieldDef["type"]; options?: string[] | null; position?: number }>;
    delete?: string[];
  };
}

/** Error codes the routes answer with (in the body's `code`). */
export type TaskApiErrorCode =
  | "stale" | "not_found" | "project_not_found" | "tasks_off" | "invalid" | "forbidden" | "no_session";

/** `/ws/global` pushes; ids only, each list re-reads what it shows. */
export type TasksGlobalEvent =
  | { type: "tasks:changed"; project: string; taskIds: string[] }
  | { type: "tasks:project_changed"; project: string }
  | { type: "tasks:link_states"; project: string };

export const TASKS_EVENT_TYPES = ["tasks:changed", "tasks:project_changed", "tasks:link_states"] as const;

/** A link names itself in a DELETE as `<kind>:<ref>`, URL-encoded. */
export const taskLinkId = (link: { kind: string; ref: string }): string => `${link.kind}:${link.ref}`;
