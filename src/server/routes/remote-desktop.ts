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
    let originHost: string | null = null;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (!originHost || originHost !== new URL(c.req.url).host) {
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
