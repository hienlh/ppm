import type { KillProcessRequest, ProcessInfo } from "../../../types/system-metrics";

/** Builds the kill request body from a process row's own identity fields — pulled out
 *  of the dialog's confirm handler so the payload shape is unit-testable without
 *  mounting the dialog. `startedAt` travels unchanged so the server can 409 a pid the
 *  OS recycled between the snapshot and the click. */
export function buildKillRequest(proc: ProcessInfo, tree: boolean): KillProcessRequest {
  return { pid: proc.pid, startedAt: proc.startedAt, tree };
}
