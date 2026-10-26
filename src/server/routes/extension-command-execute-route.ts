import type { Context } from "hono";
import {
  EXECUTE_MAX_BODY_BYTES,
  EXECUTE_MAX_COMMAND_LENGTH,
  HTTP_STATUS_FOR,
  clampExecuteTimeout,
  type ExecuteErrorBody,
  type ExecuteErrorCode,
  type ExecuteSuccess,
} from "../../shared/extension-command-execute.ts";
import type { ExecuteOutcome } from "../../services/extension-command-executor.ts";
import { readCappedBody } from "../../services/read-capped-body.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("ExtService");

export interface CommandExecuteService {
  executeCommand(command: string, args: unknown[], timeoutMs: number): Promise<ExecuteOutcome>;
}

/** How much of a command id a log line keeps; real ids are far shorter. */
const LOGGED_COMMAND_MAX = 80;

/**
 * The caller's command string as it may appear in ppm.log. It is any 1–200 characters the caller
 * sent, and the log is read by people, the Logs window and its AI, so a newline or other control
 * character in it could forge a whole log line. Those are replaced, as is anything outside the
 * characters a command id uses, and the result is capped.
 */
export function loggableCommand(command: string): string {
  const safe = command.replace(/[^\w.:@/-]/g, "?");
  return safe.length > LOGGED_COMMAND_MAX ? `${safe.slice(0, LOGGED_COMMAND_MAX)}…` : safe;
}

function errorResponse(c: Context, code: ExecuteErrorCode, error: string): Response {
  const body: ExecuteErrorBody = { ok: false, error, code };
  return c.json(body, HTTP_STATUS_FOR[code]);
}

/**
 * `POST /api/extensions/commands/execute`. Behind the app's Bearer auth like every `/api` route,
 * plus one rule of its own: a request carrying an `Origin` is refused. CORS is open app-wide, so
 * without that check any web page could drive extension commands on an instance with auth off;
 * the CLI never sends an `Origin`, and a browser always does.
 *
 * One INFO line per call names the command and the outcome, never the arguments or the result,
 * which can carry the user's own text.
 */
export function createCommandExecuteHandler(service: CommandExecuteService) {
  return async function handle(c: Context): Promise<Response> {
    if (c.req.header("origin")) {
      log.info("ext command refused: request carried an Origin header");
      return errorResponse(c, "ORIGIN_REFUSED", "Extension commands cannot be run from a browser page");
    }
    if (Number(c.req.header("content-length") ?? "0") > EXECUTE_MAX_BODY_BYTES) {
      return errorResponse(c, "BAD_REQUEST", "Request body is too large");
    }

    let body: unknown;
    try {
      const raw = await readCappedBody(c.req.raw, EXECUTE_MAX_BODY_BYTES);
      if (raw === null) return errorResponse(c, "BAD_REQUEST", "Request body is too large");
      body = JSON.parse(raw);
    } catch {
      return errorResponse(c, "BAD_REQUEST", "Request body is not valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(c, "BAD_REQUEST", "Request body must be a JSON object");
    }

    const { command, args, timeoutMs } = body as Record<string, unknown>;
    if (typeof command !== "string" || command.length < 1 || command.length > EXECUTE_MAX_COMMAND_LENGTH) {
      return errorResponse(c, "BAD_REQUEST", `"command" must be a string of 1 to ${EXECUTE_MAX_COMMAND_LENGTH} characters`);
    }
    if (args !== undefined && !Array.isArray(args)) {
      return errorResponse(c, "BAD_REQUEST", `"args" must be an array`);
    }

    const outcome = await service.executeCommand(command, args ?? [], clampExecuteTimeout(timeoutMs));
    const ext = outcome.extensionId ?? "-";
    const logged = loggableCommand(command);
    if (outcome.kind === "ok") {
      log.info(`ext command=${logged} ext=${ext} ms=${outcome.durationMs} outcome=ok`);
      const data: ExecuteSuccess = {
        command,
        extensionId: outcome.extensionId,
        result: outcome.result ?? null,
        durationMs: outcome.durationMs,
      };
      return c.json({ ok: true, data });
    }
    log.info(`ext command=${logged} ext=${ext} ms=${outcome.durationMs} outcome=${outcome.code}`);
    return errorResponse(c, outcome.code, outcome.message);
  };
}
