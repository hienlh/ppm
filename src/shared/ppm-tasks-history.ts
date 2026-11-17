/**
 * PPM Tasks history: who changed a task, how, and what. Re-exported by `ppm-tasks.ts`.
 */

/** Full history detail (and undo of AI changes) is kept this long; older rows keep only key events. */
export const HISTORY_DETAIL_DAYS = 90;

export type ActorKind = "user" | "manager" | "assistant" | "chat" | "ppm";
export const AI_ACTOR_KINDS: readonly ActorKind[] = ["manager", "assistant", "chat"];

export interface Actor {
  kind: ActorKind;
  sessionId?: string;
  /** "You", "Manager nxsys", "Assistant", a chat's title, "PPM". */
  label: string;
}

export type Via = "ppm" | "telegram" | "tool" | "api";

/** Who wrote a change, how, and why. */
export interface WriteContext {
  actor: Actor;
  via: Via;
  reason?: string;
  /** Written in an unattended PPM Assistant turn: audited and shown as "while you were away". */
  unattended?: boolean;
}

export type HistoryKind =
  | "created" | "updated" | "status" | "closed" | "reopened" | "reordered"
  | "decision" | "decided" | "result" | "deleted" | "undo" | "project"
  /** A snooze set, changed or cleared by someone; `resurfaced` is PPM bringing the task back. */
  | "snoozed" | "resurfaced";

/** Kept past the detail window; everything else is compacted away after 90 days. */
export const KEY_HISTORY_KINDS: readonly HistoryKind[] = ["created", "status", "closed", "reopened"];

export interface HistoryChange {
  /** A patch field name, or `fields.<key>` for one custom field. */
  field: string;
  before: unknown;
  after: unknown;
}

export interface HistoryEntry {
  id: number;
  /** Null for a project-config event (statuses, members, fields, the switch). */
  taskId: string | null;
  projectKey: string;
  at: number;
  actor: Actor;
  via: Via;
  unattended: boolean;
  kind: HistoryKind;
  changes: HistoryChange[];
  reason: string | null;
  undoOf: number | null;
  undoneBy: number | null;
}
