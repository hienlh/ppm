/**
 * WS handler for `/ws/remote-desktop` — binary out = framed video access units (1-byte
 * key/delta header + Annex-B bytes), text in = JSON control messages.
 *
 * The connection is *not* trusted just because the upgrade succeeded: the coarse PPM auth
 * token already travels as `?token=` on every WS URL (`isWsUpgradeAuthorized`,
 * `src/server/index.ts`) and proves nothing beyond "holds the one reusable app token", so a
 * single-use short-TTL nonce (`POST /api/remote-desktop/session`) must be presented as the
 * client's *first* message — `{type:"auth", nonce}` — before capture or input starts. Kept out
 * of the query string (unlike the coarse token) so it never lands in proxy/tunnel access logs.
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
  try { parsed = JSON.parse(text); } catch { ws.close(1008, "expected auth message"); return; }
  const nonce = parsed.type === "auth" ? parsed.nonce : undefined;
  if (typeof nonce !== "string" || !consumeRemoteDesktopNonce(nonce)) {
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
    ws.data.session = await createRemoteDesktopSession(socket);
  } catch (e) {
    console.error(`[remote-desktop] failed to start capture: ${(e as Error).message}`);
    ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
    ws.close(1011, "capture failed to start");
  }
}

export const remoteDesktopWebSocket = {
  open(ws: RemoteDesktopWs) {
    guardOrClose(ws); // nothing else to do until the client's first (auth) message arrives
  },

  async message(ws: RemoteDesktopWs, msg: string | ArrayBuffer | Uint8Array) {
    if (!guardOrClose(ws)) return;
    const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);
    if (!ws.data.authenticated) {
      await authenticateFirstMessage(ws, text);
      return;
    }
    await ws.data.session?.handleClientMessage(text);
  },

  close(ws: RemoteDesktopWs) {
    ws.data.session?.close();
  },
};
