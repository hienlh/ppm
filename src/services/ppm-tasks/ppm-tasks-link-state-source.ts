/**
 * Where a task's links get their live state (Jira status, PR state and CI, chat running/idle). The
 * default answers "unknown" for everything; the link-state checker registers the real source at
 * startup, so the REST layer and the UI can be built against this interface alone.
 */
import type { ChildCheckState, LinkKind, LinkState, Task } from "../../shared/ppm-tasks.ts";

/** A working session's live state as a task row shows it. */
export interface SessionLinkState {
  sessionId: string;
  /** `gone`: PPM has no record of the chat any more (deleted). */
  state: "running" | "waiting_card" | "idle" | "gone" | "unknown";
  title: string | null;
  providerId?: string | null;
  /** When the running turn started (ms since the epoch), while one runs. */
  runningSince?: number;
  /**
   * The handed-off work checker's last finding for the task this state was asked for ("stalled 40
   * min", "finished, no report"); null when the task is not handed off or was not checked yet.
   */
  check?: { state: ChildCheckState; since: number; lastProgressAt: number | null } | null;
}

export interface TaskLinkStateSource {
  /**
   * The states of these links in this project: Jira and PR links from the cache (a stale or missing
   * one is refreshed in the background and pushed as a `link_states` event), session links live.
   */
  states(projectKey: string, links: ReadonlyArray<{ kind: LinkKind; ref: string }>): LinkState[];
  /** A chat's live state; with `task`, the last check of that task's handed-off chat as well. */
  sessionState(sessionId: string, task?: Pick<Task, "id" | "workingSessionId" | "handedOffAt"> | null): SessionLinkState;
}

export const unknownLinkStateSource: TaskLinkStateSource = {
  states: (_projectKey, links) => links.map((l) => ({ kind: l.kind, ref: l.ref, state: null, error: null, checkedAt: null, changedAt: null })),
  sessionState: (sessionId) => ({ sessionId, state: "unknown", title: null }),
};

let source: TaskLinkStateSource = unknownLinkStateSource;

/** Registers the real source; null puts the "unknown" default back (tests). */
export function setTaskLinkStateSource(next: TaskLinkStateSource | null): void {
  source = next ?? unknownLinkStateSource;
}

export const taskLinkStateSource = (): TaskLinkStateSource => source;
