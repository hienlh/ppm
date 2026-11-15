/**
 * Where a task's links get their live state (Jira status, PR state and CI, chat running/idle). The
 * default answers "unknown" for everything; the link-state checker registers the real source at
 * startup, so the REST layer and the UI can be built against this interface alone.
 */
import type { LinkKind, LinkState } from "../../shared/ppm-tasks.ts";

/** A working session's live state as a task row shows it. */
export interface SessionLinkState {
  sessionId: string;
  state: "running" | "waiting_card" | "idle" | "unknown";
  title: string | null;
}

export interface TaskLinkStateSource {
  /** The cached states of these links in this project; a link never checked reads as unknown. */
  states(projectKey: string, links: ReadonlyArray<{ kind: LinkKind; ref: string }>): LinkState[];
  sessionState(sessionId: string): SessionLinkState;
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
