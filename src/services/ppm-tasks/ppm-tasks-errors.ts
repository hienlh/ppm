/** Errors the task store throws; every caller maps `code` (409 for `conflict`, 404 for `not_found`, …). */
import type { PpmTaskErrorCode } from "../../shared/ppm-tasks.ts";

export class PpmTaskError extends Error {
  constructor(readonly code: PpmTaskErrorCode, message: string) {
    super(message);
    this.name = "PpmTaskError";
  }
}

/** A write named a revision the task is no longer at; nothing was written. */
export class TaskConflictError extends PpmTaskError {
  constructor(readonly taskId: string, readonly currentRevision: number) {
    super("conflict", `The task changed since it was read: it is now at revision ${currentRevision}. Read it again and retry.`);
    this.name = "TaskConflictError";
  }
}

export const notFound = (what: string): PpmTaskError => new PpmTaskError("not_found", `${what} not found`);
export const invalid = (message: string): PpmTaskError => new PpmTaskError("invalid", message);
