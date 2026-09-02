import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorStatus } from "../../server/helpers/error-status.ts";
import { mapFsError } from "../fs-path-guard.service.ts";
import { err } from "../../types/api.ts";

/**
 * Single translation from a thrown filesystem error to the JSON body the
 * explorer expects. `code` drives the client prompts (collision → rename,
 * NO_TRASH → offer permanent delete), `hint` explains a refusal a user can
 * actually fix (macOS Full Disk Access).
 */
export function fsErrorBody(e: unknown): {
  body: ReturnType<typeof err> & { code: string; hint?: string };
  status: ContentfulStatusCode;
} {
  const info = mapFsError(e);
  // Domain errors from the project-scoped services carry no `code`; fall back
  // to the shared class-based mapping so both doors answer alike.
  const status = (info.status === 500 ? errorStatus(e) : info.status) as ContentfulStatusCode;
  return {
    body: { ...err(info.message), code: info.code, hint: info.hint },
    status,
  };
}
