/**
 * WS handler for `/ws/remote-desktop` — binary out = framed video access units (1-byte
 * key/delta header + Annex-B bytes), text in = JSON control messages.
 *
 * The connection is *not* trusted just because the upgrade succeeded: the coarse PPM auth
 * token already travels as `?token=` on every WS URL (`isWsUpgradeAuthorized`,
 * `src/server/index.ts`) and proves nothing beyond "holds the one reusable app token", so a
 * single-use short-TTL nonce (`POST /api/remote-desktop/session`) must be presented as the
 * client's *first* message — `{type:"auth", nonce, displayId?, cursor?, codec?}` — before
 * capture or input starts. `displayId` picks one of `/capabilities`' `displays`; absent/unknown = primary.
 * `cursor` and `codec` carry the client's saved cursor and encoder prefs, because ffmpeg takes
 * both at startup and applying them afterwards would respawn it on every connect. `webrtc`
 * asks for the relay transport; when it is not installed the session answers on this socket
 * as before rather than failing. Kept out of
 * the query string (unlike the coarse token) so they never land in proxy/tunnel access logs.
 *
 * Both the feature flag and `auth.enabled` are re-checked here even though
 * `src/server/index.ts` already gated the upgrade on them — this handler must never depend on
 * a single call site staying correct as fetch-time routing evolves, and must NOT reuse
 * `isWsUpgradeAuthorized()`, which returns `true` unconditionally when PPM auth is disabled.
 */
import { configService } from "../../services/config.service.ts";
import { isRemoteDesktopEnabled } from "../../services/remote-desktop/remote-desktop-flag.ts";
import { consumeRemoteDesktopNonce } from "../../services/remote-desktop/remote-desktop-nonce.ts";
import {
  createRemoteDesktopSession,
  registerRemoteDesktopExitSweep,
  type RemoteDesktopSession,
  type RemoteDesktopSocket,
} from "../../services/remote-desktop/remote-desktop-session.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("remote-desktop");

registerRemoteDesktopExitSweep();

interface RemoteDesktopWs {
  data: { type: "remote-desktop"; session?: RemoteDesktopSession; authenticated?: boolean };
  send: (d: string | Uint8Array) => number;
  getBufferedAmount?: () => number;
  close: (code?: number, reason?: string) => void;
}

function guardOrClose(ws: RemoteDesktopWs): boolean {
  if (!isRemoteDesktopEnabled()) { ws.close(1008, "remote desktop is disabled"); return false; }
  if (!configService.get("auth").enabled) {
    ws.close(1008, "remote desktop requires PPM authentication to be enabled");
    return false;
  }
  return true;
}

async function authenticateFirstMessage(ws: RemoteDesktopWs, text: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text); } catch {
    log.warn("auth rejected: first message is not JSON");
    ws.close(1008, "expected auth message");
    return;
  }
  const nonce = parsed.type === "auth" ? parsed.nonce : undefined;
  if (typeof nonce !== "string" || !consumeRemoteDesktopNonce(nonce)) {
    // Never the nonce itself: a refusal on a channel that hands over the host's screen and input.
    log.warn("auth rejected: invalid or expired nonce");
    ws.close(1008, "invalid or expired session nonce");
    return;
  }
  ws.data.authenticated = true;
  try {
    const socket: RemoteDesktopSocket = {
      send: (d) => ws.send(d),
      getBufferedAmount: ws.getBufferedAmount ? () => ws.getBufferedAmount!() : undefined,
      close: (code, reason) => ws.close(code, reason),
    };
    ws.data.session = await createRemoteDesktopSession(socket, {
      displayId: typeof parsed.displayId === "string" ? parsed.displayId : undefined,
      // Only an explicit `false` hides it: an older client sends no flag at all and must keep
      // getting the pointer it has always had.
      showCursor: parsed.cursor !== false,
      encoder: typeof parsed.codec === "string" ? parsed.codec : undefined,
      // Opt-in, and only honoured when the relay is installed: an older client sends no flag
      // and keeps the WebSocket path it has always used.
      webrtc: parsed.webrtc === true,
    });
  } catch (e) {
    log.error("failed to start capture:", e);
    ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
    ws.close(1011, "capture failed to start");
  }
}

export const remoteDesktopWebSocket = {
  open(ws: RemoteDesktopWs) {
    guardOrClose(ws); // nothing else to do until the client's first (auth) message arrives
  },

  async message(ws: RemoteDesktopWs, msg: string | ArrayBuffer | Uint8Array) {
    // The server drops this promise, so anything that escapes is an unhandled rejection — and
    // three of those in a minute exit the whole server. The session catches its own messages;
    // this is for the rest (a first message of `null` fails reading `.type`, for one).
    try {
      if (!guardOrClose(ws)) return;
      const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);
      if (!ws.data.authenticated) {
        await authenticateFirstMessage(ws, text);
        return;
      }
      await ws.data.session?.handleClientMessage(text);
    } catch (e) {
      log.warn(`message handling failed: ${(e as Error)?.message ?? e}`);
    }
  },

  close(ws: RemoteDesktopWs) {
    ws.data.session?.close("socket-closed");
  },
};
