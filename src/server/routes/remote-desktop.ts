/**
 * `GET /api/remote-desktop/capabilities` (read-only, always answerable — includes the host's
 * requirements checklist), `POST /api/remote-desktop/requirements/:id/:action` (host-side
 * fixes: OS permission prompt, open its Settings pane), `POST /api/remote-desktop/session` (mints the single-use WS
 * nonce) and `POST /api/remote-desktop/whep/:ticket` (the WebRTC handshake, forwarded to the
 * session's own loopback relay). Guard style mirrors
 * `named-tunnel.ts`: `authMiddleware` already passes every request through when PPM auth is
 * disabled, so a feature that hands out host control must enforce `auth.enabled` itself, plus
 * a same-origin check so a foreign page can't drive it via ambient browser credentials.
 */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { holdRequestOpen } from "../helpers/hold-request-open.ts";
import { configService } from "../../services/config.service.ts";
import { getFfmpegCapabilities, workingEncoders } from "../../services/media-transcode/ffmpeg-capabilities.ts";
import { isRemoteDesktopEnabled } from "../../services/remote-desktop/remote-desktop-flag.ts";
import { mintRemoteDesktopNonce } from "../../services/remote-desktop/remote-desktop-nonce.ts";
import { listDisplays } from "../../services/remote-desktop/remote-desktop-displays.ts";
import { HOST_ACTIONS, remoteDesktopReadiness, runHostAction } from "../../services/remote-desktop/remote-desktop-requirements.ts";
import {
  ANSWER_WAIT_MS, getHelperStatus, getRescueState, runHelperAction, startHelperJob,
} from "../../services/remote-desktop/win32-helper/helper-service.ts";
import { getRescueNotice } from "../../services/remote-desktop/win32-helper/rescue-notice.ts";
import { resolveWhepTarget } from "../../services/remote-desktop/remote-desktop-whep-registry.ts";
import {
  relayStatus, startMediamtxInstall, uninstallMediamtx,
} from "../../services/remote-desktop/mediamtx-install.service.ts";

import { ffmpegInstaller } from "../../services/remote-desktop/ffmpeg-install.ts";

export const remoteDesktopRoutes = new Hono();

function assertSessionAllowed(c: Context): Response | null {
  if (!isRemoteDesktopEnabled()) {
    return c.json(err("remote desktop is disabled on this host (REMOTE_DESKTOP_ENABLED=0)"), 404);
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
  const [caps, readiness, displays, encoders] = await Promise.all([
    getFfmpegCapabilities(), remoteDesktopReadiness(), listDisplays(), workingEncoders(),
  ]);
  return c.json(ok({
    displays,
    // Every encoder that really encodes here, preference order, for the codec picker. The
    // first is what a session uses unless the client names another.
    encoders,
    // Flat booleans kept for existing clients/tests; `readiness` is the source of truth.
    ffmpegAvailable: !!caps.ffmpeg,
    videoAvailable: readiness.videoReady,
    inputAvailable: readiness.inputReady,
    authRequired: configService.get("auth").enabled,
    ...readiness,
  }));
});

remoteDesktopRoutes.get("/requirements/ffmpeg/install", (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  return c.json(ok(ffmpegInstaller.getStatus()));
});

remoteDesktopRoutes.post("/requirements/ffmpeg/install", (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  try {
    const status = ffmpegInstaller.start();
    return c.json(ok(status), status.state === "installing" ? 202 : 200);
  } catch (error) {
    return c.json(err(error instanceof Error ? error.message : String(error)), 400);
  }
});

/** A Windows helper task can take well over Bun.serve's 10-second idle limit to answer (measured:
 *  20 s and 27 s). Cut off, the page reported a failure while the task went on to do its work.
 *  The request waits `ANSWER_WAIT_MS` for the answer, after up to `RUN_TIMEOUT_MS` each for the
 *  status checks and starting the task; this covers all three. */
const HELPER_ANSWER_SECONDS = Math.ceil(ANSWER_WAIT_MS / 1000) + 60;

// Same guards as /session: these pop dialogs / open panes on the host, which is host control too.
remoteDesktopRoutes.post("/requirements/:id/:action", async (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  const action = HOST_ACTIONS.find((a) => a === c.req.param("action"));
  if (!action) return c.json(err("unknown action"), 404);
  holdRequestOpen(c, HELPER_ANSWER_SECONDS);
  const result = await runHostAction(c.req.param("id"), action);
  if (result === null) return c.json(err("this requirement has no host action"), 404);
  return c.json(ok(result));
});

/** The Windows headless helper (`win32-helper/`): status, and install/uninstall through one
 *  administrator prompt on the host. Host control, so the same guards as `/session`. */
remoteDesktopRoutes.get("/headless-helper", async (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  return c.json(ok(await getHelperStatus()));
});

/** The safety net armed by bringing the session back or turning the virtual display on: when
 *  its `Rescue` task runs unless confirmed (`armed`), and whether it last ran and turned the
 *  virtual display on (`notice`). Polled by the viewer, which confirms by itself once a picture
 *  comes through; reads two small files. */
remoteDesktopRoutes.get("/headless-helper/rescue", (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  return c.json(ok({ armed: getRescueState(), notice: getRescueNotice() }));
});

remoteDesktopRoutes.post("/headless-helper/:kind", async (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  const kind = c.req.param("kind");
  // The viewer answers the safety net by itself once a picture has come through for a few
  // seconds: that picture is the proof the PC can still be reached through PPM.
  if (kind === "confirm") {
    holdRequestOpen(c, HELPER_ANSWER_SECONDS);
    return c.json(ok(await runHelperAction("Confirm")));
  }
  if (kind !== "install" && kind !== "uninstall") return c.json(err("unknown helper action"), 404);
  try {
    return c.json(ok(startHelperJob(kind)), 202);
  } catch (error) {
    return c.json(err(error instanceof Error ? error.message : String(error)), 400);
  }
});

remoteDesktopRoutes.post("/session", (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  return c.json(ok({ nonce: mintRemoteDesktopNonce(), wsPath: "/ws/remote-desktop" }));
});

/**
 * WHEP: the browser posts an SDP offer, the relay answers with an SDP answer, and media then
 * flows peer-to-peer over the relay's ICE port.
 *
 * The relay's signalling port is bound to loopback (`mediamtx-config.ts`), so this proxy is
 * the only way to reach it — and it is deliberately **ticket-addressed, never URL-addressed**:
 * the client presents a ticket PPM minted for its own session and handed it over the
 * already-authenticated WebSocket. Forwarding a client-supplied URL here would turn a feature
 * that already carries host control into an SSRF hole.
 *
 * `Location` from the relay is not passed back: it addresses 127.0.0.1 and means nothing to
 * the browser. MediaMTX drops the session on its own when the peer connection goes away.
 */
const MAX_SDP_BYTES = 64 * 1024;

remoteDesktopRoutes.post("/whep/:ticket", async (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;

  const target = resolveWhepTarget(c.req.param("ticket"));
  // One answer for unknown and for expired: a distinguishable pair would say whether a ticket
  // ever existed.
  if (!target) return c.json(err("unknown or expired WebRTC ticket"), 404);

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.startsWith("application/sdp")) {
    return c.json(err("expected application/sdp"), 415);
  }
  const offer = await c.req.text();
  if (offer.length > MAX_SDP_BYTES) return c.json(err("SDP offer too large"), 413);

  let answer: Response;
  try {
    answer = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: offer,
    });
  } catch {
    // The relay died between the ticket being handed out and this call.
    return c.json(err("the WebRTC relay is not reachable"), 502);
  }

  const body = await answer.text();
  if (!answer.ok) return c.json(err(`relay rejected the offer (${answer.status})`), 502);
  return new Response(body, {
    status: 201,
    headers: { "content-type": "application/sdp", "cache-control": "no-store" },
  });
});

/**
 * The WebRTC relay's own install lifecycle, for the Settings pane.
 *
 * Behind the same guards as `/session`: downloading and unpacking an executable onto the host
 * is host control, and the same-origin check keeps a foreign page from triggering it with
 * ambient credentials.
 */
remoteDesktopRoutes.get("/relay", (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  return c.json(ok(relayStatus()));
});

remoteDesktopRoutes.post("/relay/install", (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  try {
    return c.json(ok(startMediamtxInstall()));
  } catch (e) {
    return c.json(err((e as Error).message), 409);
  }
});

remoteDesktopRoutes.post("/relay/uninstall", (c) => {
  const rejected = assertSessionAllowed(c);
  if (rejected) return rejected;
  try {
    // False means a copy PPM did not install — the host's own, which is not PPM's to remove.
    const removed = uninstallMediamtx();
    return removed
      ? c.json(ok({ removed }))
      : c.json(err("this copy was not installed by PPM"), 409);
  } catch (e) {
    return c.json(err((e as Error).message), 409);
  }
});
