import { Hono } from "hono";
import { resourceMonitor, type ResourceSnapshot } from "../../services/resource-monitor.service.ts";
import { ok } from "../../types/api.ts";

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
