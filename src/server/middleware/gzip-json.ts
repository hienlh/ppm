/**
 * Gzip middleware for API JSON responses.
 * Compresses only `application/json` bodies over a size threshold, so SSE
 * (text/event-stream), binary streams (fs/raw), and tiny payloads pass through
 * untouched. JSON compresses ~5-8x; a 542KB file index becomes ~80KB on the wire.
 */
import type { MiddlewareHandler } from "hono";

const MIN_SIZE_BYTES = 1024;

export const gzipJson: MiddlewareHandler = async (c, next) => {
  await next();

  const accept = c.req.header("Accept-Encoding") ?? "";
  if (!accept.includes("gzip")) return;
  if (c.req.method === "HEAD") return;

  const res = c.res;
  if (!res || res.status !== 200 || res.body == null) return;
  if (res.headers.get("Content-Encoding")) return;
  const type = res.headers.get("Content-Type") ?? "";
  if (!type.includes("application/json")) return;

  const body = await res.arrayBuffer();
  if (body.byteLength < MIN_SIZE_BYTES) {
    c.res = new Response(body, { status: res.status, headers: res.headers });
    return;
  }

  const gzipped = Bun.gzipSync(new Uint8Array(body));
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(gzipped.byteLength));
  headers.set("Vary", "Accept-Encoding");
  c.res = new Response(gzipped, { status: res.status, headers });
};
