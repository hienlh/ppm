import type { MiddlewareHandler } from "hono";

/**
 * The app-wide CORS headers, written onto the handler's own response AFTER it is made.
 *
 * Hono's `cors()` sets its headers on `c.res` before `next()`, which makes Hono build a
 * placeholder response; when the handler then returns its own, the `c.res` setter rebuilds it
 * as `new Response(res.body, res)` to merge the two. Reading `.body` turns a `Bun.file(...)`
 * body into Bun's file stream — the one that keeps about the file's size in native memory per
 * response and never returns it (see `services/file-chunks.ts`). Measured on Bun 1.3.10
 * (Windows), a 23 MB file: 2.9 MB per response bare, 30.2 MB behind `cors()`, and the
 * response lost its `Content-Length` (sent chunked). Every static asset, chat image and
 * download went through that.
 *
 * Same answer as `cors()` with its defaults (`origin: "*"`), with one difference: a route that
 * sets `Access-Control-Allow-Origin` itself keeps it (`cors()` overwrote it, which is why the
 * design preview had to re-assert `null`).
 */
const ALLOW_METHODS = "GET,HEAD,PUT,POST,DELETE,PATCH";

export const corsHeaders: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    // A preflight never reaches a handler, so answering it here rebuilds nothing.
    const headers = new Headers({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": ALLOW_METHODS });
    const requested = c.req.header("Access-Control-Request-Headers");
    if (requested) {
      headers.set("Access-Control-Allow-Headers", requested.split(/\s*,\s*/).join(","));
      headers.append("Vary", "Access-Control-Request-Headers");
    }
    return new Response(null, { status: 204, statusText: "No Content", headers });
  }

  await next();
  if (c.res.headers.has("Access-Control-Allow-Origin")) return;
  try {
    c.res.headers.set("Access-Control-Allow-Origin", "*");
  } catch {
    // A response whose headers are immutable (one passed through from `fetch`) is rebuilt;
    // its body is a stream already, so there is no file to turn into one.
    const res = new Response(c.res.body, c.res);
    res.headers.set("Access-Control-Allow-Origin", "*");
    c.res = res;
  }
};
