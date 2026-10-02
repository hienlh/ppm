/**
 * WS handler for `/ws/android` — binary out = framed H.264 access units, text in/out = JSON.
 *
 * The upgrade succeeding proves nothing: the coarse PPM token travels as `?token=` on every WS
 * URL (`isWsUpgradeAuthorized`, `src/server/index.ts`) and says only "holds the one reusable app
 * token". A socket that hands over touch and keyboard control of a running VM therefore requires
 * a single-use, short-TTL nonce from `POST /api/android/devices/:deviceId/sessions` as the
 * client's *first* message, and the nonce — not the URL — is what names the device.
 *
 * The flag and `auth.enabled` are re-checked here even though `src/server/index.ts` already gated
 * the upgrade on them: this handler must never depend on one call site staying correct, and must
 * NOT reuse `isWsUpgradeAuthorized()`, which returns true unconditionally when PPM auth is off.
 */
import { configService } from "../../services/config.service.ts";
import { isAndroidEmulatorEnabled } from "../../services/android/android-flag.ts";
import { consumeAndroidNonce } from "../../services/android/android-nonce.ts";
import { findRunningByDeviceId } from "../../services/android/device-registry.ts";
import {
  attachAndroidViewer, registerAndroidExitSweep,
  type AndroidSocket, type AndroidViewerSession,
} from "../../services/android/android-session.ts";
import { ANDROID_QUALITY_PRESETS, type AndroidQuality } from "../../shared/android-protocol.ts";

registerAndroidExitSweep();

interface AndroidWs {
  data: { type: "android"; session?: AndroidViewerSession; authenticated?: boolean; closed?: boolean };
  send: (d: string | Uint8Array) => number;
  getBufferedAmount?: () => number;
  close: (code?: number, reason?: string) => void;
}

function guardOrClose(ws: AndroidWs): boolean {
  if (!isAndroidEmulatorEnabled()) { ws.close(1008, "android emulator support is disabled"); return false; }
  if (!configService.get("auth").enabled) {
    ws.close(1008, "android emulator control requires PPM authentication to be enabled");
    return false;
  }
  return true;
}

/** The session layer's view of this socket. `isClosed` reads the flag `close` below sets: a
 *  close during `attachAndroidViewer` finds no session to close yet. */
export function androidSocketFor(ws: AndroidWs): AndroidSocket {
  return {
    send: (d) => ws.send(d),
    getBufferedAmount: ws.getBufferedAmount ? () => ws.getBufferedAmount!() : undefined,
    close: (code, reason) => ws.close(code, reason),
    isClosed: () => ws.data.closed === true,
  };
}

function parseQuality(value: unknown): AndroidQuality {
  return typeof value === "string" && value in ANDROID_QUALITY_PRESETS ? (value as AndroidQuality) : "balanced";
}

async function authenticateFirstMessage(ws: AndroidWs, text: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text); } catch { ws.close(1008, "expected auth message"); return; }

  const nonce = parsed.type === "auth" ? parsed.nonce : undefined;
  const deviceId = typeof nonce === "string" ? consumeAndroidNonce(nonce) : null;
  if (!deviceId) { ws.close(1008, "invalid or expired session nonce"); return; }

  const emulator = findRunningByDeviceId(deviceId);
  if (!emulator) { ws.close(1011, "that emulator is no longer running"); return; }

  ws.data.authenticated = true;
  try {
    ws.data.session = await attachAndroidViewer(androidSocketFor(ws), {
      deviceId,
      emulator,
      quality: parseQuality(parsed.quality),
    });
  } catch (e) {
    console.error(`[android] failed to start a session: ${(e as Error).message}`);
    ws.send(JSON.stringify({ type: "error", message: (e as Error).message, fatal: true }));
    ws.close(1011, "session failed to start");
  }
}

export const androidWebSocket = {
  open(ws: AndroidWs) {
    guardOrClose(ws); // nothing else until the client's first (auth) message arrives
  },

  async message(ws: AndroidWs, msg: string | ArrayBuffer | Uint8Array) {
    if (!guardOrClose(ws)) return;
    const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);
    if (!ws.data.authenticated) {
      await authenticateFirstMessage(ws, text);
      return;
    }
    await ws.data.session?.handleClientMessage(text);
  },

  close(ws: AndroidWs) {
    ws.data.closed = true;
    ws.data.session?.close();
  },
};
