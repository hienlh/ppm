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
