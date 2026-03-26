import { Hono } from "hono";

/**
 * Browser preview reverse proxy — forwards requests to localhost:<port>.
 * Mounted at /api/preview/:port/* so the frontend iframe can load
 * any localhost dev server through PPM's own origin (avoiding CORS/framing issues).
 */
export const browserPreviewRoutes = new Hono();

/** Only allow proxying to localhost ports (security: prevent SSRF) */
function isValidPort(port: string): boolean {
  const n = parseInt(port, 10);
  return !isNaN(n) && n >= 1 && n <= 65535;
}

browserPreviewRoutes.all("/:port{[0-9]+}/*", async (c) => {
  const port = c.req.param("port");
  if (!isValidPort(port)) {
    return c.text("Invalid port", 400);
  }

  // Build target URL — strip the /api/preview/:port prefix
  const url = new URL(c.req.url);
  const prefix = `/api/preview/${port}`;
  const targetPath = url.pathname.slice(prefix.length) || "/";
  const targetUrl = `http://localhost:${port}${targetPath}${url.search}`;

  try {
    // Forward the request with original method, headers, and body
    const headers = new Headers(c.req.raw.headers);
    // Remove host header so target server sees localhost
    headers.delete("host");

    const resp = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
      redirect: "manual",
    });

    // Clone response headers, remove framing restrictions so iframe works
    const respHeaders = new Headers(resp.headers);
    respHeaders.delete("x-frame-options");
    respHeaders.delete("content-security-policy");

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  } catch {
    return c.text(`Cannot connect to localhost:${port}`, 502);
  }
});

// Handle root path (no trailing slash)
browserPreviewRoutes.all("/:port{[0-9]+}", async (c) => {
  const port = c.req.param("port");
  if (!isValidPort(port)) {
    return c.text("Invalid port", 400);
  }

  const url = new URL(c.req.url);
  const targetUrl = `http://localhost:${port}/${url.search}`;

  try {
    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");

    const resp = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
      redirect: "manual",
    });

    const respHeaders = new Headers(resp.headers);
    respHeaders.delete("x-frame-options");
    respHeaders.delete("content-security-policy");

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  } catch {
    return c.text(`Cannot connect to localhost:${port}`, 502);
  }
});
