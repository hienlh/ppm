/**
 * Session trace over HTTP: browser logs coming in, and a session's timeline going out.
 * Both sit behind authMiddleware — an error raised while logged out is lost, by decision.
 */
import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  DeviceRateLimiter,
  TRACE_INGEST_MAX_BODY_BYTES,
  browserRows,
  parseBrowserBatch,
} from "../../services/session-trace/browser-trace-ingest.ts";
import { appendBatch, readSessionTimeline } from "../../services/session-trace/session-trace-store.ts";

const MAX_TIMELINE_ROWS = 20_000;

export function createTraceRoutes(limiter = new DeviceRateLimiter()): Hono {
  const routes = new Hono();

  /** POST /api/trace — body: BrowserTraceBatch (`src/shared/session-trace.ts`). */
  routes.post("/", async (c) => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > TRACE_INGEST_MAX_BODY_BYTES) return c.json(err("batch too large"), 400);
    let text: string;
    try { text = await c.req.text(); } catch { return c.json(err("unreadable body"), 400); }
    if (Buffer.byteLength(text) > TRACE_INGEST_MAX_BODY_BYTES) return c.json(err("batch too large"), 400);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return c.json(err("body must be JSON"), 400); }

    const parsed = parseBrowserBatch(raw);
    if (!parsed.ok) return c.json(err(parsed.error), 400);

    const { batch, dropped } = parsed;
    const verdict = limiter.take(batch.deviceId, batch.entries.length);
    if (!verdict.allowed) {
      c.header("Retry-After", String(Math.ceil(verdict.retryAfterMs / 1000)));
      return c.json(err("too many trace entries from this device"), 429);
    }

    try {
      appendBatch(browserRows(batch));
    } catch (e) {
      // 503 rather than 500: the client keeps the batch and tries again later.
      console.warn(`[session-trace] browser batch not stored: ${(e as Error).message}`);
      return c.json(err("trace store unavailable"), 503);
    }
    return c.json(ok({ accepted: batch.entries.length, dropped }));
  });

  /**
   * GET /api/trace/sessions/:sessionId — the session's own trace plus every browser row filed
   * against it, under any id the session has had, oldest first.
   */
  routes.get("/sessions/:sessionId", (c) => {
    const limit = Math.min(MAX_TIMELINE_ROWS, Math.max(1, Number(c.req.query("limit")) || 5_000));
    try {
      return c.json(ok({ events: readSessionTimeline(c.req.param("sessionId"), limit) }));
    } catch (e) {
      return c.json(err((e as Error).message), 500);
    }
  });

  return routes;
}

export const traceRoutes = createTraceRoutes();
