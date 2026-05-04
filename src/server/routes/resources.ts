import { Hono } from "hono";
import { resourceMonitor, type ResourceSnapshot } from "../../services/resource-monitor.service.ts";
import { ok, err } from "../../types/api.ts";

export const resourceRoutes = new Hono();

const MAX_SSE_CLIENTS = 5;
let sseClientCount = 0;

/** GET /resources — latest snapshot as JSON */
resourceRoutes.get("/resources", (c) => {
  return c.json(ok(resourceMonitor.getLatest()));
});

/** GET /resources/history — full ring buffer */
resourceRoutes.get("/resources/history", (c) => {
  return c.json(ok(resourceMonitor.getHistory()));
});

/** POST /resources/kill/:pid — send SIGTERM to a process in PPM's tree */
resourceRoutes.post("/resources/kill/:pid", async (c) => {
  const pid = parseInt(c.req.param("pid"), 10);
  if (isNaN(pid) || pid <= 0) {
    return c.json(err("Invalid PID"), 400);
  }
  // Safety: only allow killing processes in PPM's own tree
  const snapshot = resourceMonitor.getLatest();
  if (!snapshot) {
    return c.json(err("No resource data available"), 400);
  }
  const allPids = snapshot.groups.flatMap((g) => g.processes.map((p) => p.pid));
  if (!allPids.includes(pid)) {
    return c.json(err("PID not in PPM process tree"), 403);
  }
  // Don't allow killing the server itself
  if (pid === process.pid) {
    return c.json(err("Cannot kill PPM server process"), 403);
  }
  try {
    process.kill(pid, "SIGTERM");
    return c.json(ok({ pid, signal: "SIGTERM" }));
  } catch (e: any) {
    return c.json(err(`Failed to kill PID ${pid}: ${e.message}`), 500);
  }
});

/** GET /resources/stream — SSE stream of snapshots every 3s */
resourceRoutes.get("/resources/stream", (c) => {
  if (sseClientCount >= MAX_SSE_CLIENTS) {
    return c.json({ ok: false, error: "Too many SSE clients" }, 429);
  }

  let callbackRef: ((s: ResourceSnapshot) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      sseClientCount++;
      const encoder = new TextEncoder();

      // Send retry hint for reconnect interval
      controller.enqueue(encoder.encode("retry: 5000\n\n"));

      callbackRef = (snapshot: ResourceSnapshot) => {
        try {
          const data = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
          controller.enqueue(encoder.encode(data));
        } catch {
          // Client disconnected — cleanup happens in cancel
        }
      };

      resourceMonitor.subscribe(callbackRef);
    },
    cancel() {
      sseClientCount = Math.max(0, sseClientCount - 1);
      if (callbackRef) resourceMonitor.unsubscribe(callbackRef);
      callbackRef = null;
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
