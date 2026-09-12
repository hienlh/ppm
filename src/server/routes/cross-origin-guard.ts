/**
 * The header pair every state-changing system route requires.
 *
 * PPM can be configured with auth disabled on a LAN, and a page on any other
 * origin can submit an HTML form to this server. Such a form can set neither a
 * JSON content type nor a custom header, so demanding BOTH forces a CORS
 * preflight the browser will refuse to make on its behalf.
 *
 * One function, so the kill, signal and service-action routes cannot drift into
 * three slightly different ideas of what a same-origin request looks like. A
 * bodyless action still sends `{}` rather than being granted an exception here.
 */
import type { Context } from "hono";

export function crossOriginRefusal(c: Context): string | null {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return "Content-Type must be application/json";
  if (c.req.header("x-ppm-request") !== "1") return "Missing X-PPM-Request header";
  return null;
}
