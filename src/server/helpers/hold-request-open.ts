import type { Context } from "hono";

/**
 * Let one request stay silent for up to `seconds` (0 = no limit). Bun.serve closes a connection
 * that sends nothing for 10 s, and a COUNT(*), a sorted page of a big table or an MCP tool call
 * waiting on a slow query sends nothing until it is done, so the caller got a dropped connection
 * instead of the answer. `c.env` is the server `app.fetch` was handed; a test calling
 * `app.fetch(req)` has none, and nothing needs lifting there.
 */
export function holdRequestOpen(c: Context, seconds: number): void {
  (c.env as { timeout?: (req: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, seconds);
}
