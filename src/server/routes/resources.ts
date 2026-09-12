/**
 * Whole-machine metrics routes, mounted under `/api/system` behind auth.
 *
 *   GET    /hardware                         static device inventory (drives, NICs, GPUs)
 *   GET    /resources?processes=0|1          latest snapshot for that tier (or null)
 *   GET    /resources/stream?processes=0|1   SSE: `session` frame, then `snapshot` frames
 *   POST   /resources/stream/:sid/ping       renew the subscriber lease
 *   DELETE /resources/stream/:sid            drop the subscriber
 *   POST   /resources/kill                   guarded kill (JSON + X-PPM-Request header)
 *   POST   /resources/signal                 guarded signal, same guard as a kill
 *   GET    /resources/process/:pid           on-demand facts for the Details dialog
 */
import { Hono } from "hono";
import type { MetricsSnapshot, MetricsTier } from "../../types/system-metrics.ts";
import type { HardwareInventory } from "../../types/system-hardware.ts";
import { ok, err } from "../../types/api.ts";
import {
  systemMetricsService, MAX_STREAM_SUBSCRIBERS, type SystemMetricsService,
} from "../../services/system-metrics/system-metrics.service.ts";
import { isValidSid } from "../../services/system-metrics/metrics-subscriber-registry.ts";
import { readHardwareInventory } from "../../services/system-metrics/hardware-inventory.ts";
import { createAppIconService, type AppIconService } from "../../services/system-services/app-icon-service.ts";
import { iconMimeType } from "../../services/system-services/app-icons-linux.ts";
import { crossOriginRefusal } from "./cross-origin-guard.ts";

/** Frames a stalled client failed to take before the stream is closed. Metrics
 *  are lossy by nature; `ReadableStream`'s queue is not, and 30-60 KB every 2 s
 *  toward a dead mobile client is ~54 MB/hour of heap. */
export const MAX_DROPPED_FRAMES = 10;

const tierOf = (raw: string | undefined): MetricsTier => (raw === "1" || raw === "true" ? "full" : "light");


export function createResourceRoutes(
  service: SystemMetricsService = systemMetricsService,
  hardware: () => Promise<HardwareInventory> = readHardwareInventory,
  appIcons: AppIconService = createAppIconService(),
): Hono {
  const routes = new Hono();

  // Static facts, fetched once per window and again whenever a snapshot names a
  // device id the client does not know yet — never on the 2 s tick.
  routes.get("/hardware", async (c) => c.json(ok(await hardware())));

  // The request names an APP, never a path: the only file this can serve is one
  // this host's own desktop entry pointed at, resolved server-side.
  routes.get("/app-icon/:id", async (c) => {
    const iconPath = appIcons.path(c.req.param("id") ?? "");
    if (!iconPath) return c.json(err("No icon for that app"), 404);
    const file = Bun.file(iconPath);
    if (!(await file.exists())) return c.json(err("No icon for that app"), 404);
    return new Response(file, {
      headers: {
        "Content-Type": iconMimeType(iconPath),
        // Icons change only when a package is reinstalled.
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

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

  // Every field here is already in the process table this caller can stream,
  // except exe/cwd/cgroup — the same trust level, behind the same auth.
  routes.get("/resources/process/:pid", (c) => {
    const raw = c.req.param("pid") ?? "";
    const pid = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(pid) || pid <= 0) {
      return c.json(err("PID must be a positive integer"), 400);
    }
    const details = service.processDetails(pid);
    if (!details) return c.json(err(`PID ${pid} is no longer running`), 404);
    return c.json(ok(details));
  });

  routes.post("/resources/signal", async (c) => {
    const refusal = crossOriginRefusal(c);
    if (refusal) return c.json(err(refusal), 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(err("Invalid JSON body"), 400);
    }
    try {
      const outcome = await service.signal(body);
      return c.json(outcome.body, outcome.status);
    } catch (e) {
      console.error("[SystemMetrics] signal re-query failed:", (e as Error)?.message ?? e);
      return c.json(err("Could not verify the process — try again"), 500);
    }
  });

  routes.post("/resources/kill", async (c) => {
    const refusal = crossOriginRefusal(c);
    if (refusal) return c.json(err(refusal), 400);
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
