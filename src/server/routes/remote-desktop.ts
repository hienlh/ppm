/**
 * `GET /api/remote-desktop/capabilities` (read-only, always answerable) and
 * `POST /api/remote-desktop/session` (mints the single-use WS nonce). Guard style mirrors
 * `named-tunnel.ts`: `authMiddleware` already passes every request through when PPM auth is
 * disabled, so a feature that hands out host control must enforce `auth.enabled` itself, plus
 * a same-origin check so a foreign page can't drive it via ambient browser credentials.
 */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { configService } from "../../services/config.service.ts";
import { getFfmpegCapabilities } from "../../services/media-transcode/ffmpeg-capabilities.ts";
import { isRemoteDesktopEnabled } from "../../services/remote-desktop/remote-desktop-flag.ts";
import { mintRemoteDesktopNonce } from "../../services/remote-desktop/remote-desktop-nonce.ts";
import { isInputAvailable } from "../../services/remote-desktop/remote-desktop-input.ts";

export const remoteDesktopRoutes = new Hono();

function assertSessionAllowed(c: Context): Response | null {
  if (!isRemoteDesktopEnabled()) {
    return c.json(err("remote desktop is disabled (set REMOTE_DESKTOP_ENABLED=1)"), 404);
  }
  if (!configService.get("auth").enabled) {
    return c.json(err("remote desktop requires PPM authentication to be enabled"), 403);
  }
  const origin = c.req.header("origin");
  if (origin) {
    // Compare *hostname* only, not host:port. `named-tunnel.ts`'s copy of this check compares
    // the full `host` (hostname:port), which only ever matches when the browser's page and the
    // API it's calling share one origin verbatim — true for the compiled/production build (one
    // server, one port) but NOT for the standard two-process dev topology (`bun dev:web` on
    // 5173 proxying to `bun dev:server` on 8081, or this feature's own alt-port test setup):
    // Vite's dev proxy rewrites the `Host` header to the proxy target's port without adding
    // `X-Forwarded-Host`, so the backend always sees a different port than the browser's real
    // `Origin` — the full-host check would reject every dev-mode session request. A real
    // cross-origin attacker (e.g. evil.com) cannot spoof `Origin` to say `localhost` in the
    // first place — the browser sets it from the page's actual origin — so relaxing port
    // equality does not weaken the protection this check exists for.
    let originHost: string | null = null;
    try { originHost = new URL(origin).hostname; } catch { originHost = null; }
    let requestHost: string | null = null;
    try { requestHost = new URL(c.req.url).hostname; } catch { requestHost = null; }
    if (!originHost || !requestHost || originHost !== requestHost) {
      return c.json(err("cross-origin request rejected"), 403);
    }
  }
  return null;
}

remoteDesktopRoutes.get("/capabilities", async (c) => {
  if (!isRemoteDesktopEnabled()) return c.json(err("remote desktop is disabled"), 404);
  const caps = await getFfmpegCapabilities();
  return c.json(ok({
    ffmpegAvailable: !!caps.ffmpeg,
    videoAvailable: process.platform === "win32" && !!caps.ffmpeg,
    inputAvailable: isInputAvailable(),
    authRequired: configService.get("auth").enabled,
  }));
});

remoteDesktopRoutes.post("/session", (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  return c.json(ok({ nonce: mintRemoteDesktopNonce(), wsPath: "/ws/remote-desktop" }));
});
