import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SecurityError, NotFoundError, ValidationError } from "../../services/file.service.ts";

/** Map domain error types to HTTP status codes */
export function errorStatus(e: unknown): ContentfulStatusCode {
  if (e instanceof SecurityError) return 403;
  if (e instanceof NotFoundError) return 404;
  if (e instanceof ValidationError) return 400;
  return 500;
}
