/**
 * Whole-machine metrics routes, mounted under `/api/system` behind auth.
 *
 *   GET    /resources?processes=0|1          latest snapshot for that tier (or null)
 *   GET    /resources/stream?processes=0|1   SSE: `session` frame, then `snapshot` frames
 *   POST   /resources/stream/:sid/ping       renew the subscriber lease
 *   DELETE /resources/stream/:sid            drop the subscriber
 *   POST   /resources/kill                   guarded kill (JSON + X-PPM-Request header)
 */
import { Hono } from "hono";
import type { MetricsSnapshot, MetricsTier } from "../../types/system-metrics.ts";
import { ok, err } from "../../types/api.ts";
import {
  systemMetricsService, MAX_STREAM_SUBSCRIBERS, type SystemMetricsService,
} from "../../services/system-metrics/system-metrics.service.ts";
import { isValidSid } from "../../services/system-metrics/metrics-subscriber-registry.ts";

/** Frames a stalled client failed to take before the stream is closed. Metrics
 *  are lossy by nature; `ReadableStream`'s queue is not, and 30-60 KB every 2 s
 *  toward a dead mobile client is ~54 MB/hour of heap. */
export const MAX_DROPPED_FRAMES = 10;

const tierOf = (raw: string | undefined): MetricsTier => (raw === "1" || raw === "true" ? "full" : "light");

export function createResourceRoutes(service: SystemMetricsService = systemMetricsService): Hono {
  const routes = new Hono();

  routes.get("/resources", (c) => c.json(ok(service.getLatest(tierOf(c.req.query("processes"))))));

  routes.get("/resources/stream", (c) => {
    const tier = tierOf(c.req.query("processes"));
    // A 429 is only possible before the body starts, so reap expired leases and
    // check the cap here — BEFORE the stream is built, because `start()` runs
    // synchronously at construction. subscribe() re-checks in case two opens race.
    service.reapExpired();
    if (service.liveCount() >= MAX_STREAM_SUBSCRIBERS) {
      return c.json(err("Too many metrics subscribers"), 429);
    }

    const encoder = new TextEncoder();
    let sid: string | null = null;
    let drops = 0;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => { try { controller.close(); } catch { /* already closed */ } };
        const result = service.subscribe({
          tier,
          close,
          deliver: (snapshot: MetricsSnapshot) => {
            // `enqueue` never throws on backpressure, only on a closed controller,
            // so `desiredSize` is the only signal that the client stopped reading.
            if ((controller.desiredSize ?? 1) <= 0) {
              if (++drops >= MAX_DROPPED_FRAMES) {
                if (sid) service.unsubscribe(sid);
                close();
              }
              return;
            }
            drops = 0;
            try {
              controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
            } catch {
              if (sid) service.unsubscribe(sid);
            }
          },
        });
        if (!result) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Too many metrics subscribers" })}\n\n`));
          close();
          return;
        }
        sid = result.sid;
        controller.enqueue(encoder.encode("retry: 5000\n\n"));
        controller.enqueue(encoder.encode(`event: session\ndata: ${JSON.stringify(result)}\n\n`));
      },
      cancel() {
        // Best effort only — a proxy may keep this request alive after the
        // browser left, which is what the lease + DELETE route are for.
        if (sid) service.unsubscribe(sid);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  routes.post("/resources/stream/:sid/ping", (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid) || !service.ping(sid)) return c.json(err("Unknown or expired stream session"), 404);
    return c.json(ok({ alive: true }));
  });

  routes.delete("/resources/stream/:sid", (c) => {
    const sid = c.req.param("sid");
    const stopped = isValidSid(sid) ? service.unsubscribe(sid) : false;
    return c.json(ok({ stopped }));
  });

  routes.post("/resources/kill", async (c) => {
    // CSRF hardening for the auth-disabled configuration: a cross-origin HTML
    // form can set neither a JSON content type nor a custom header, so both
    // force a preflight that the browser will refuse.
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return c.json(err("Content-Type must be application/json"), 400);
    }
    if (c.req.header("x-ppm-request") !== "1") return c.json(err("Missing X-PPM-Request header"), 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(err("Invalid JSON body"), 400);
    }
    try {
      const outcome = await service.kill(body);
      return c.json(outcome.body, outcome.status);
    } catch (e) {
      // The live re-query itself failed (collector down, session restarting);
      // nothing was signalled, so the client can simply retry.
      console.error("[SystemMetrics] kill re-query failed:", (e as Error)?.message ?? e);
      return c.json(err("Could not verify the process — try again"), 500);
    }
  });

  return routes;
}

export const resourceRoutes = createResourceRoutes();
