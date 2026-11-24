/**
 * `/api/web-browser`: what the host can offer, a connection nonce, and start/stop.
 * Every route goes through `checkWebBrowserAccess` itself (see that file for what it checks).
 */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { checkWebBrowserAccess, mintWebBrowserNonce, isPublicRequest } from "../../services/web-browser/web-browser-access.ts";
import { findBrowsers, installHint } from "../../services/web-browser/chrome-locate.ts";
import { webBrowserHost, WebBrowserUnavailableError } from "../../services/web-browser/browser-host.ts";
import { viewerHub } from "../../services/web-browser/viewer-hub.ts";
import { isWebBrowserAllowedByEnv } from "../../services/web-browser/web-browser-flag.ts";
import { configService } from "../../services/config.service.ts";
import { attachmentHeader, listDownloads, mintDownloadTicket, spendDownloadTicket, DOWNLOAD_TICKET_PREFIX } from "../../services/web-browser/download-manager.ts";
import { MAX_UPLOAD_BYTES, saveUpload } from "../../services/web-browser/upload-store.ts";
import { parseWebBrowserSettings } from "../../shared/web-browser-settings.ts";
import { settleWebBrowserIntro } from "../../services/web-browser/web-browser-intro.ts";

export const webBrowserRoutes = new Hono();

function refuse(c: Context, opts?: { requireEnabled?: boolean }): Response | null {
  const r = checkWebBrowserAccess(c.req.raw, opts);
  return r ? c.json({ ...err(r.message), code: r.code }, r.status) : null;
}

webBrowserRoutes.get("/capabilities", async (c) => {
  if (!isWebBrowserAllowedByEnv()) return c.json(ok({ available: false, reason: "disabled-by-env" }));
  const settings = webBrowserHost.settings();
  const browsers = await findBrowsers();
  return c.json(ok({
    available: browsers.length > 0,
    enabled: settings.enabled ?? null,
    browsers: browsers.map((b) => ({ path: b.path, name: b.name, version: b.version })),
    installHint: browsers.length ? null : installHint(),
    publicRequest: isPublicRequest(c.req.raw),
    refused: checkWebBrowserAccess(c.req.raw)?.code ?? null,
    state: webBrowserHost.state,
    settings,
  }));
});

/**
 * Save Settings → Web Browser. Over a public link the reach switches and the browser path
 * cannot change: one request with the token must not be able to widen what the browser can
 * reach from the Internet. `browserPath` must be one of the browsers PPM found, since it names a
 * program PPM will run.
 */
webBrowserRoutes.put("/settings", async (c) => {
  const rejected = refuse(c, { requireEnabled: false });
  if (rejected) return rejected;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(err("expected JSON"), 400); }
  const current = webBrowserHost.settings();
  const next = parseWebBrowserSettings(body);
  if (isPublicRequest(c.req.raw)) {
    const guarded = ["allowLocalhost", "allowLan", "allowPublicTunnel", "aiControl", "browserPath"] as const;
    if (guarded.some((k) => next[k] !== current[k])) {
      return c.json({ ...err("these settings can only be changed from the LAN or Tailscale"), code: "public-access" }, 403);
    }
  }
  if (next.browserPath && !(await findBrowsers()).some((b) => b.path === next.browserPath)) {
    return c.json(err("that browser was not found on this host"), 400);
  }
  configService.set("web_browser", next);
  webBrowserHost.applySettings();
  if (next.enabled === false && webBrowserHost.state !== "stopped") await webBrowserHost.stop();
  settleWebBrowserIntro();
  return c.json(ok(next));
});

webBrowserRoutes.get("/downloads", (c) => {
  const rejected = refuse(c);
  if (rejected) return rejected;
  return c.json(ok(listDownloads()));
});

/** A one-use link for a finished download (a link cannot carry the Authorization header). */
webBrowserRoutes.post("/downloads/:id/ticket", (c) => {
  const rejected = refuse(c);
  if (rejected) return rejected;
  const ticket = mintDownloadTicket(c.req.param("id"));
  if (!ticket) return c.json(err("no such download"), 404);
  return c.json(ok({ url: `${DOWNLOAD_TICKET_PREFIX}${ticket}` }));
});

/**
 * The ticket in the path was issued once to an authenticated request (the auth middleware lets
 * a live one through) and is spent here. Never rendered: octet-stream, nosniff, CSP sandbox.
 */
webBrowserRoutes.get("/download/:ticket", (c) => {
  const file = spendDownloadTicket(c.req.param("ticket"));
  if (!file) return c.json(err("this download link has expired"), 410);
  return new Response(Bun.file(file.path), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": attachmentHeader(file.name),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "no-store",
    },
  });
});

/** A file the viewer picked for a page's file input; the raw body is the file, its name in a header. */
webBrowserRoutes.post("/uploads", async (c) => {
  const rejected = refuse(c);
  if (rejected) return rejected;
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > MAX_UPLOAD_BYTES) return c.json(err(`files over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB are not accepted`), 413);
  const body = c.req.raw.body;
  if (!body) return c.json(err("empty upload"), 400);
  let name = "file";
  try { name = decodeURIComponent(c.req.header("x-file-name") ?? "file"); } catch {}
  try {
    return c.json(ok({ id: await saveUpload(body, name) }));
  } catch (error) {
    return c.json(err((error as Error)?.message ?? String(error)), 413);
  }
});

webBrowserRoutes.post("/session", (c) => {
  const rejected = refuse(c);
  if (rejected) return rejected;
  return c.json(ok({ nonce: mintWebBrowserNonce(), wsPath: "/ws/web-browser" }));
});

webBrowserRoutes.post("/start", async (c) => {
  const rejected = refuse(c);
  if (rejected) return rejected;
  try {
    await webBrowserHost.ensureStarted();
    return c.json(ok({ state: webBrowserHost.state }));
  } catch (error) {
    const code = error instanceof WebBrowserUnavailableError ? error.code : "start-failed";
    return c.json({ ...err((error as Error)?.message ?? String(error)), code }, 503);
  }
});

webBrowserRoutes.post("/stop", async (c) => {
  const rejected = refuse(c, { requireEnabled: false });
  if (rejected) return rejected;
  await webBrowserHost.stop();
  return c.json(ok({ state: webBrowserHost.state }));
});

/**
 * Wipes everything the browser keeps — logins, storage, cache, history — by stopping it and
 * deleting its profile folder, which is more thorough than any per-origin CDP clear.
 */
webBrowserRoutes.post("/clear-data", async (c) => {
  const rejected = refuse(c, { requireEnabled: false });
  if (rejected) return rejected;
  await webBrowserHost.stop();
  const { rmSync } = await import("node:fs");
  const { webBrowserPaths } = await import("../../services/web-browser/chrome-launch-args.ts");
  for (const dir of [webBrowserPaths.profile(), webBrowserPaths.downloads(), webBrowserPaths.uploads()]) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(webBrowserPaths.tabsFile(), { force: true });
  viewerHub.broadcast(viewerHub.status());
  return c.json(ok({ cleared: true }));
});
