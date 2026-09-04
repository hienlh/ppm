import type { KillProcessRequest, ProcessGroup, ProcessInfo } from "../../../types/system-metrics";

/** What the confirm dialog is about to end: one row, or a whole app group. */
export type KillTarget =
  | { kind: "process"; proc: ProcessInfo }
  | { kind: "group"; group: ProcessGroup; members: ProcessInfo[] };

/** Builds the kill request body from a process row's own identity fields — pulled out
 *  of the dialog's confirm handler so the payload shape is unit-testable without
 *  mounting the dialog. `startedAt` travels unchanged so the server can 409 a pid the
 *  OS recycled between the snapshot and the click. */
export function buildKillRequest(proc: ProcessInfo, tree: boolean): KillProcessRequest {
  return { pid: proc.pid, startedAt: proc.startedAt, tree };
}

/**
 * Requests that end every member of a group.
 *
 * An ancestor roll-up ("root:<pid>") is ended with ONE tree kill on its root — the
 * server walks the same descendant set it grouped by, so this is atomic on Windows
 * (`taskkill /T`) and cannot miss a child that forked between snapshot and click.
 * An orphan bucket ("exe:<name>") has no common ancestor, so each member is a
 * separate single-process kill. Protected members are never included: the caller
 * disables the button when any exist, and the server would 403 anyway.
 */
export function buildGroupKillRequests(group: ProcessGroup, members: ProcessInfo[]): KillProcessRequest[] {
  const root = group.rootPid !== null ? members.find((m) => m.pid === group.rootPid) : undefined;
  if (root) return [buildKillRequest(root, true)];
  return members.map((m) => buildKillRequest(m, false));
}

/** A group can be ended only when none of its members is refused by the guard —
 *  the PPM instance and system groups stay un-endable as a whole. */
export function isGroupProtected(members: ProcessInfo[]): boolean {
  return members.some((m) => m.protected);
}
