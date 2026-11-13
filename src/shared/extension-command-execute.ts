/**
 * `POST /api/extensions/commands/execute`: run a command an installed extension declared in
 * `contributes.commands`, from outside a browser (the CLI). Shared by the route, the service
 * and the CLI so the codes, limits and exit codes cannot drift apart.
 */

/** Default wait for a command's answer when the request names none. */
export const EXECUTE_DEFAULT_TIMEOUT_MS = 60_000;
export const EXECUTE_MIN_TIMEOUT_MS = 1_000;
export const EXECUTE_MAX_TIMEOUT_MS = 600_000;
/** Largest request body accepted. Arguments are user text, not files. */
export const EXECUTE_MAX_BODY_BYTES = 256 * 1024;
export const EXECUTE_MAX_COMMAND_LENGTH = 200;

export interface ExecuteRequest {
  command: string;
  /** Spread as positional arguments: the handler is called as `handler(...args)`. */
  args?: unknown[];
  timeoutMs?: number;
}

export interface ExecuteSuccess {
  command: string;
  extensionId: string;
  /** What the handler returned; `undefined` arrives as `null`. */
  result: unknown;
  durationMs: number;
}

export type ExecuteErrorCode =
  | "BAD_REQUEST"
  | "ORIGIN_REFUSED"
  | "NOT_ACTIVE"
  | "NOT_FOUND"
  | "HOST_NOT_READY"
  | "COMMAND_FAILED"
  | "TIMEOUT";

export interface ExecuteErrorBody {
  ok: false;
  error: string;
  code: ExecuteErrorCode;
}

export const HTTP_STATUS_FOR: Record<ExecuteErrorCode, 400 | 403 | 404 | 500 | 503 | 504> = {
  BAD_REQUEST: 400,
  ORIGIN_REFUSED: 403,
  NOT_ACTIVE: 403,
  NOT_FOUND: 404,
  HOST_NOT_READY: 503,
  COMMAND_FAILED: 500,
  TIMEOUT: 504,
};

/** The CLI's exit code per error: 2 when the command never ran, 3 when it ran and failed. */
export const EXIT_CODE_FOR: Record<ExecuteErrorCode, 2 | 3> = {
  BAD_REQUEST: 2,
  ORIGIN_REFUSED: 2,
  NOT_ACTIVE: 2,
  NOT_FOUND: 2,
  HOST_NOT_READY: 2,
  COMMAND_FAILED: 3,
  TIMEOUT: 3,
};

export function isExecuteErrorCode(value: unknown): value is ExecuteErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(HTTP_STATUS_FOR, value);
}

/** The wait a request actually gets: the default when absent or not an integer, else clamped. */
export function clampExecuteTimeout(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isInteger(requested)) return EXECUTE_DEFAULT_TIMEOUT_MS;
  return Math.min(EXECUTE_MAX_TIMEOUT_MS, Math.max(EXECUTE_MIN_TIMEOUT_MS, requested));
}
